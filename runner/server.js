/**
 * Runner voor de lezing: draait op de laptop in de zaal, offline.
 *
 *   node runner/server.js [pack-naam] [--port 8080]
 *
 * Serveert drie dingen:
 *   /          operator-pagina (handbesturing, status, notes)
 *   /show      schermpagina voor de beamer
 *   /assets/*  de media uit het pack
 *
 * En drie endpoints:
 *   POST /api/scan      de zelfscanner meldt een barcode, krijgt de nieuwe stand terug
 *   POST /api/command   de operator stuurt next/prev/goto/blank
 *   GET  /api/events    server-sent events: elke statewijziging naar alle pagina's
 *
 * Geen afhankelijkheden, met opzet. Server-sent events in plaats van een
 * websocket: de browser doet de reconnect zelf, en de runner moet later één
 * los uitvoerbaar bestand worden.
 *
 * De frame-teller staat hier, op één plek. In de oude versie zat hij in
 * show.html en wist de scanner niet welk frame in beeld stond.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {execFile} = require('child_process');
const {loadPack, validateManifest, kindForFile} = require('../shared/manifest-schema');
const {pakIn, pakUit} = require('../shared/lezing-bestand');

const ROOT = __dirname;
const PACKS_DIR = path.join(ROOT, 'packs');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------------------------------------------------------------- argumenten

const args = process.argv.slice(2);
let packName = null;
let port = 8080;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' || args[i] === '-p') {
    port = Number(args[++i]) || port;
  } else if (!args[i].startsWith('-')) {
    packName = args[i];
  }
}

/**
 * Alle packs in runner/packs/ inlezen. Eentje met fouten blokkeert de start
 * niet: die staat in de lijst met zijn foutmelding, zodat je hem in de editor
 * kan repareren in plaats van de runner niet te kunnen starten. Alleen de
 * lezing die je gaat géven moet kloppen.
 */
function lesPacksIn() {
  if (!fs.existsSync(PACKS_DIR)) {
    fs.mkdirSync(PACKS_DIR, {recursive: true});
  }
  const namen = fs
    .readdirSync(PACKS_DIR)
    .filter(n => !n.startsWith('.') && fs.statSync(path.join(PACKS_DIR, n)).isDirectory())
    .sort();
  const uit = new Map();
  for (const naam of namen) {
    try {
      const p = loadPack(path.join(PACKS_DIR, naam));
      p.naam = naam;
      p.fout = null;
      uit.set(naam, p);
    } catch (e) {
      uit.set(naam, {naam, dir: path.join(PACKS_DIR, naam), manifest: null, fout: e.message});
    }
  }
  return uit;
}

let packs = lesPacksIn();
let pack = null;

function zetActief(naam) {
  const p = packs.get(naam);
  if (!p) {
    throw new Error(`lezing "${naam}" bestaat niet`);
  }
  if (p.fout) {
    throw new Error(`lezing "${naam}" klopt niet: ${p.fout}`);
  }
  pack = p;
  slideOpBarcode.clear();
  pack.manifest.slides.forEach((slide, i) => {
    slide.index = i;
    slideOpBarcode.set(slide.barcode, slide);
  });
}

const slideOpBarcode = new Map();

try {
  const goede = [...packs.values()].filter(p => !p.fout);
  if (packs.size === 0) {
    throw new Error('geen lezingen in runner/packs/ -- maak er een in de editor');
  }
  if (packName) {
    zetActief(packName);
  } else if (goede.length === 1) {
    zetActief(goede[0].naam);
  } else if (goede.length === 0) {
    throw new Error(
      'geen enkele lezing klopt:\n    ' +
        [...packs.values()].map(p => `${p.naam}: ${p.fout}`).join('\n    '),
    );
  } else {
    // Meerdere goede lezingen en geen keuze: pak de eerste, de rest staat in de
    // editor en de operator klaar om op over te stappen.
    zetActief(goede[0].naam);
  }
} catch (e) {
  console.error('\nKan de lezing niet laden:\n  ' + e.message + '\n');
  process.exit(1);
}

/** Na een bewerking in de editor opnieuw inlezen, met de actieve lezing erbij. */
function herlaad(actief) {
  packs = lesPacksIn();
  const naam = actief || (pack && pack.naam);
  if (packs.has(naam) && !packs.get(naam).fout) {
    zetActief(naam);
  }
}

// --------------------------------------------------------------------- state

const state = {
  barcode: null, // null = leeg scherm
  frameIndex: 0,
  bron: 'start', // 'scan' | 'operator' | 'start'
  teller: 0, // loopt op bij elke wijziging, zodat een pagina kan zien of hij achterloopt
};

let scannerLaatstGezien = 0;

function huidigeSlide() {
  return state.barcode ? slideOpBarcode.get(state.barcode) || null : null;
}

/** De volledige stand, zoals de pagina's en de scanner hem krijgen. */
function standVoorClients() {
  const slide = huidigeSlide();
  const frame = slide ? slide.frames[state.frameIndex] || null : null;
  return {
    type: 'state',
    barcode: state.barcode,
    slideIndex: slide ? slide.index : -1,
    frameIndex: slide ? state.frameIndex : 0,
    frameCount: slide ? slide.frames.length : 0,
    frame: frame ? {src: frame.src, type: frame.type} : null,
    note: frame ? frame.note : '',
    label: slide ? slide.label : '',
    bron: state.bron,
    teller: state.teller,
  };
}

function zet(barcode, frameIndex, bron) {
  state.barcode = barcode;
  state.frameIndex = frameIndex;
  state.bron = bron;
  state.teller++;
  stuurNaarAllen(standVoorClients());
}

/**
 * Een barcode opzoeken, met één tolerantie: UPC-A (12 cijfers, Amerikaanse
 * producten) is dezelfde code als EAN-13 met een nul ervoor. Welke van de twee
 * een scanner teruggeeft hangt af van hoe hij is ingesteld. Staat in de lezing
 * de ene vorm en komt de andere binnen, dan hoort die slide gewoon te werken en
 * niet stil te blijven.
 */
function zoekSlide(code) {
  if (slideOpBarcode.has(code)) {
    return slideOpBarcode.get(code);
  }
  if (code.length === 12 && slideOpBarcode.has('0' + code)) {
    return slideOpBarcode.get('0' + code);
  }
  if (code.length === 13 && code[0] === '0' && slideOpBarcode.has(code.slice(1))) {
    return slideOpBarcode.get(code.slice(1));
  }
  return null;
}

/**
 * Een scan van de zelfscanner.
 *
 * Dezelfde barcode opnieuw = volgend frame, en na het laatste frame weer het
 * eerste. Dat is een expliciete wens en staat daarom hier, in één
 * functie, en niet in de pagina's.
 */
function scan(code) {
  if (pack.manifest.clearScan && code === pack.manifest.clearScan) {
    zet(null, 0, 'scan');
    return {ok: true, bekend: true, leeg: true};
  }
  const slide = zoekSlide(code);
  if (!slide) {
    // Niet in deze lezing: de stand blijft staan, de scanner meldt het.
    return {ok: true, bekend: false, barcode: code};
  }
  code = slide.barcode;
  if (state.barcode === code) {
    zet(code, (state.frameIndex + 1) % slide.frames.length, 'scan');
  } else {
    zet(code, 0, 'scan');
  }
  return Object.assign({ok: true, bekend: true}, standVoorClients());
}

/**
 * Handbesturing vanaf de laptop. Anders dan bij een scan lopen de pijltjes
 * dóór naar de volgende slide: als de scanner het niet doet moet de hele lezing
 * van de laptop af te draaien zijn.
 */
function commando(cmd, data) {
  const slides = pack.manifest.slides;
  const slide = huidigeSlide();

  if (cmd === 'blank') {
    zet(null, 0, 'operator');
    return {ok: true};
  }
  if (cmd === 'goto') {
    const doel = slideOpBarcode.get(String(data.barcode || ''));
    if (!doel) {
      return {ok: false, fout: `barcode ${data.barcode} staat niet in deze lezing`};
    }
    const i = Number(data.frameIndex) || 0;
    zet(doel.barcode, Math.max(0, Math.min(i, doel.frames.length - 1)), 'operator');
    return {ok: true};
  }
  if (cmd === 'next') {
    if (!slide) {
      zet(slides[0].barcode, 0, 'operator');
    } else if (state.frameIndex + 1 < slide.frames.length) {
      zet(slide.barcode, state.frameIndex + 1, 'operator');
    } else {
      zet(slides[(slide.index + 1) % slides.length].barcode, 0, 'operator');
    }
    return {ok: true};
  }
  if (cmd === 'prev') {
    if (!slide) {
      const laatste = slides[slides.length - 1];
      zet(laatste.barcode, laatste.frames.length - 1, 'operator');
    } else if (state.frameIndex > 0) {
      zet(slide.barcode, state.frameIndex - 1, 'operator');
    } else {
      const vorige = slides[(slide.index - 1 + slides.length) % slides.length];
      zet(vorige.barcode, vorige.frames.length - 1, 'operator');
    }
    return {ok: true};
  }
  return {ok: false, fout: `onbekend commando "${cmd}"`};
}

// ----------------------------------------------------------- server-sent events

const clients = new Set();

function stuurNaarAllen(obj) {
  const regel = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) {
    try {
      res.write(regel);
    } catch (e) {
      clients.delete(res);
    }
  }
}

// Een comment-regel houdt de verbinding open als er lang niets gebeurt.
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clients.delete(res);
    }
  }
}, 15000).unref();

// ------------------------------------------------------------------- helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

function lokaalIp() {
  const nets = os.networkInterfaces();
  for (const naam of Object.keys(nets)) {
    for (const net of nets[naam] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function json(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function leesJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let te_groot = false;
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 64 * 1024) {
        te_groot = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (te_groot) {
        return reject(new Error('body te groot'));
      }
      if (data === '') {
        return resolve({});
      }
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('geen geldige JSON'));
      }
    });
    req.on('error', reject);
  });
}

const UPLOAD_MAX = 500 * 1024 * 1024;

/** Ruwe body lezen, voor uploads uit de editor. */
function leesRuw(req) {
  return new Promise((resolve, reject) => {
    const stukken = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > UPLOAD_MAX) {
        req.destroy();
        return reject(new Error('bestand groter dan 500 MB'));
      }
      stukken.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(stukken)));
    req.on('error', reject);
  });
}

/** Statisch bestand serveren, nooit buiten `base`. Ondersteunt Range voor video. */
function stuurBestand(req, res, base, rel) {
  const abs = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return json(res, {fout: 'pad buiten de map'}, 403);
  }
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) {
      return json(res, {fout: 'niet gevonden: ' + rel}, 404);
    }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : stat.size - 1;
        if (start <= end && end < stat.size) {
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
          });
          return fs.createReadStream(abs, {start, end}).pipe(res);
        }
      }
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

// ------------------------------------------------------------- naar de scanner
//
// De app voor het device is een eigen project: de runner bouwt
// hem niet en kent zijn code niet. Wat we hier wél doen is zijn push-script
// aanroepen, zodat de spreker niet in een terminal hoeft. Staat dat project er niet,
// dan zegt de knop dat gewoon.

const APP_DIR =
  process.env.LEZING_APP_DIR || path.resolve(ROOT, '..', '..', 'zelfscanner-lezing-app');
const PUSH_SCRIPT = path.join(APP_DIR, 'tools', 'push-pack.js');
const APP_PACKAGE = 'com.zelfscannerlezing';

let adbPad = null;

function vindAdb() {
  if (adbPad !== null) {
    return adbPad;
  }
  const kandidaten = [
    process.env.ADB,
    'adb',
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
  ].filter(Boolean);
  for (const kandidaat of kandidaten) {
    try {
      require('child_process').execFileSync(kandidaat, ['version'], {stdio: 'ignore'});
      adbPad = kandidaat;
      return adbPad;
    } catch (e) {
      // volgende proberen
    }
  }
  adbPad = false;
  return false;
}

function adbUit(args, timeout) {
  return new Promise(resolve => {
    const bin = vindAdb();
    if (!bin) {
      return resolve('');
    }
    execFile(bin, args, {timeout: timeout || 5000}, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

/** Aangesloten devices, met model en of de lezing-app erop staat. */
async function zoekDevices() {
  const uit = await adbUit(['devices']);
  const serials = uit
    .split('\n')
    .slice(1)
    .map(r => r.trim())
    .filter(r => r && r.endsWith('device'))
    .map(r => r.split(/\s+/)[0]);

  return Promise.all(
    serials.map(async serial => {
      const [model, pakketten] = await Promise.all([
        adbUit(['-s', serial, 'shell', 'getprop', 'ro.product.model']),
        adbUit(['-s', serial, 'shell', 'pm', 'list', 'packages', APP_PACKAGE]),
      ]);
      return {
        serial,
        model: model.trim() || 'onbekend',
        appGeinstalleerd: pakketten.indexOf(APP_PACKAGE) >= 0,
      };
    }),
  );
}

// -------------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // De zelfscanner meldt zich: geeft meteen de nieuwe stand terug, zodat het
  // juiste frame en de juiste note op de scanner staan zonder op de events te
  // wachten. Valt het netwerk weg, dan rekent de scanner het zelf uit en
  // trekt hij bij de volgende gelukte POST weer bij.
  if (p === '/api/scan' && req.method === 'POST') {
    let body;
    try {
      body = await leesJson(req);
    } catch (e) {
      return json(res, {ok: false, fout: e.message}, 400);
    }
    const code = String(body.barcode || '').trim();
    if (!code) {
      return json(res, {ok: false, fout: 'geen barcode'}, 400);
    }
    scannerLaatstGezien = Date.now();
    const result = scan(code);
    console.log(
      `scan ${code} -> ` +
        (result.bekend
          ? result.leeg
            ? 'scherm leeg'
            : `slide ${result.slideIndex + 1}, frame ${result.frameIndex + 1}/${result.frameCount}`
          : 'niet in deze lezing'),
    );
    return json(res, result);
  }

  if (p === '/api/command' && req.method === 'POST') {
    let body;
    try {
      body = await leesJson(req);
    } catch (e) {
      return json(res, {ok: false, fout: e.message}, 400);
    }
    const result = commando(String(body.cmd || ''), body);
    return json(res, result, result.ok ? 200 : 400);
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(standVoorClients())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/pack') {
    const gevraagd = url.searchParams.get('naam');
    if (gevraagd) {
      const doel = packs.get(gevraagd);
      if (!doel) {
        return json(res, {fout: `lezing "${gevraagd}" bestaat niet`}, 404);
      }
      if (doel.fout) {
        return json(res, {naam: doel.naam, fout: doel.fout}, 200);
      }
      return json(res, {
        naam: doel.naam,
        title: doel.manifest.title,
        version: doel.manifest.version,
        clearScan: doel.manifest.clearScan,
        slides: doel.manifest.slides,
      });
    }
    return json(res, {
      naam: pack.naam,
      title: pack.manifest.title,
      version: pack.manifest.version,
      clearScan: pack.manifest.clearScan,
      slides: pack.manifest.slides,
    });
  }

  if (p === '/api/state') {
    return json(
      res,
      Object.assign(standVoorClients(), {
        schermen: clients.size,
        scannerLaatstGezien: scannerLaatstGezien ? Date.now() - scannerLaatstGezien : null,
      }),
    );
  }

  // Health check voor de scanner: zo kan die zonder configuratie twee adressen
  // proberen (usb-kabel via adb reverse, en het lokale netwerk) en pakken wat
  // antwoordt.
  if (p === '/api/hello') {
    return json(res, {app: 'zelfscanner-lezing', pack: pack.naam, ip: lokaalIp(), port});
  }

  // ----------------------------------------------------------------- editor

  if (p === '/api/devices') {
    if (!vindAdb()) {
      return json(res, {ok: false, fout: 'adb niet gevonden', devices: []});
    }
    if (!fs.existsSync(PUSH_SCRIPT)) {
      return json(res, {
        ok: false,
        fout: `het app-project staat niet op ${APP_DIR} -- zet LEZING_APP_DIR goed`,
        devices: [],
      });
    }
    const devices = await zoekDevices();
    return json(res, {ok: true, devices});
  }

  if (p === '/api/push' && req.method === 'POST') {
    let body;
    try {
      body = await leesJson(req);
    } catch (e) {
      return json(res, {ok: false, fout: e.message}, 400);
    }
    const doel = packs.get(String(body.naam || ''));
    if (!doel || doel.fout) {
      return json(res, {ok: false, fout: 'kies een lezing die klopt'}, 400);
    }
    if (!fs.existsSync(PUSH_SCRIPT)) {
      return json(res, {ok: false, fout: `geen push-script op ${PUSH_SCRIPT}`}, 400);
    }
    // Het serienummer komt uit onze eigen lijst, nooit rechtstreeks uit de
    // pagina: dit gaat naar een commando.
    const devices = await zoekDevices();
    const gekozen = devices.find(d => d.serial === String(body.device || ''));
    if (!gekozen) {
      return json(res, {ok: false, fout: 'dat device is niet (meer) aangesloten'}, 400);
    }

    if (body.ookDraaien) {
      try {
        zetActief(doel.naam);
        zet(null, 0, 'operator');
      } catch (e) {
        return json(res, {ok: false, fout: e.message}, 400);
      }
    }

    const argumenten = [PUSH_SCRIPT, doel.dir, '--device', gekozen.serial];
    if (body.runner) {
      argumenten.push('--runner', String(body.runner));
    }
    const uitvoer = await new Promise(resolve => {
      execFile(
        process.execPath,
        argumenten,
        {cwd: APP_DIR, timeout: 120000},
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            tekst: String(stdout || '') + String(stderr || ''),
            fout: err ? err.message : null,
          });
        },
      );
    });
    console.log(`push ${doel.naam} -> ${gekozen.serial}: ${uitvoer.ok ? 'ok' : 'MISLUKT'}`);
    return json(res, {
      ok: uitvoer.ok,
      tekst: uitvoer.tekst,
      fout: uitvoer.fout,
      device: gekozen,
      draait: pack ? pack.naam : null,
    });
  }

  if (p === '/api/packs') {
    return json(res, {
      actief: pack ? pack.naam : null,
      packs: [...packs.values()].map(x => ({
        naam: x.naam,
        title: x.manifest ? x.manifest.title : '',
        slides: x.manifest ? x.manifest.slides.length : 0,
        frames: x.manifest ? x.manifest.slides.reduce((n, s) => n + s.frames.length, 0) : 0,
        fout: x.fout || null,
      })),
    });
  }

  if (p === '/api/select' && req.method === 'POST') {
    let body;
    try {
      body = await leesJson(req);
    } catch (e) {
      return json(res, {ok: false, fout: e.message}, 400);
    }
    try {
      zetActief(String(body.naam || ''));
    } catch (e) {
      return json(res, {ok: false, fout: e.message}, 400);
    }
    // Van lezing wisselen betekent schoon beginnen: een barcode uit de vorige
    // lezing mag niet blijven staan.
    zet(null, 0, 'operator');
    console.log(`lezing gewisseld naar ${pack.naam}`);
    return json(res, {ok: true, naam: pack.naam});
  }

  if (p === '/api/pack/new' && req.method === 'POST') {
    let body;
    try {
      body = await leesJson(req);
    } catch (e) {
      return json(res, {ok: false, fout: e.message}, 400);
    }
    const naam = String(body.naam || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '');
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(naam)) {
      return json(res, {ok: false, fout: 'naam mag alleen letters, cijfers, - en _ bevatten'}, 400);
    }
    const dir = path.join(PACKS_DIR, naam);
    if (fs.existsSync(dir)) {
      return json(res, {ok: false, fout: `lezing "${naam}" bestaat al`}, 400);
    }
    fs.mkdirSync(path.join(dir, 'assets'), {recursive: true});
    // Een nieuwe lezing begint met één lege slide: een manifest zonder slides
    // is volgens het schema fout, en een editor met niets erin is onhandig.
    const manifest = {
      version: '1.0.0',
      title: String(body.title || naam),
      slides: [],
    };
    fs.writeFileSync(path.join(dir, 'lezing.json'), JSON.stringify(manifest, null, 2) + '\n');
    herlaad();
    return json(res, {ok: true, naam});
  }

  if (p === '/api/pack/save' && req.method === 'POST') {
    let body;
    try {
      body = await leesJson(req);
    } catch (e) {
      return json(res, {ok: false, fout: e.message}, 400);
    }
    const naam = String(body.naam || '');
    const doel = packs.get(naam);
    if (!doel) {
      return json(res, {ok: false, fout: `lezing "${naam}" bestaat niet`}, 400);
    }
    const manifest = body.manifest;
    // Een lege lijst slides mag tijdens het bewerken, alleen niet om mee te
    // draaien: anders kan je geen nieuwe lezing opbouwen.
    const fouten =
      manifest && Array.isArray(manifest.slides) && manifest.slides.length === 0
        ? []
        : validateManifest(manifest, doel.dir);
    if (fouten.length) {
      return json(res, {ok: false, fout: 'klopt niet', fouten}, 400);
    }
    fs.writeFileSync(path.join(doel.dir, 'lezing.json'), JSON.stringify(manifest, null, 2) + '\n');
    const wasActief = pack && pack.naam === naam;
    herlaad(wasActief ? naam : null);
    if (wasActief) {
      // De pagina's moeten de nieuwe inhoud zien. Staat de barcode die in beeld
      // stond er nog, dan blijft hij staan; anders wordt het scherm leeg.
      const nog = slideOpBarcode.get(state.barcode);
      zet(nog ? state.barcode : null, nog ? Math.min(state.frameIndex, nog.frames.length - 1) : 0, 'operator');
    }
    return json(res, {ok: true});
  }

  // Een lezing als één .lezing-bestand, om persoonlijk door te geven. Zie
  // shared/lezing-bestand.js.
  if (p === '/api/export') {
    const doel = packs.get(String(url.searchParams.get('naam') || ''));
    if (!doel) {
      return json(res, {ok: false, fout: 'die lezing bestaat niet'}, 404);
    }
    let data;
    try {
      data = pakIn(doel.dir);
    } catch (e) {
      return json(res, {ok: false, fout: e.message}, 400);
    }
    console.log(`export ${doel.naam} (${Math.round(data.length / 1024)} kB)`);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${doel.naam}.lezing"`,
      'Cache-Control': 'no-store',
    });
    return res.end(data);
  }

  if (p === '/api/import' && req.method === 'POST') {
    // De naam komt van de bestandsnaam ("mijnlezing.lezing" -> mijnlezing). Bestaat die al,
    // dan wordt het mijnlezing-2: importeren overschrijft nooit een lezing.
    const basis =
      String(url.searchParams.get('naam') || '')
        .replace(/\.(lezing|zip)$/i, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, 36) || 'lezing';
    let data;
    try {
      data = await leesRuw(req);
    } catch (e) {
      return json(res, {ok: false, fout: e.message}, 400);
    }
    const tijdelijk = path.join(PACKS_DIR, `.import-${crypto.randomBytes(4).toString('hex')}`);
    try {
      pakUit(data, tijdelijk);
      loadPack(tijdelijk);
    } catch (e) {
      fs.rmSync(tijdelijk, {recursive: true, force: true});
      return json(res, {ok: false, fout: e.message}, 400);
    }
    let naam = basis;
    for (let n = 2; packs.has(naam) || fs.existsSync(path.join(PACKS_DIR, naam)); n++) {
      naam = `${basis}-${n}`;
    }
    fs.renameSync(tijdelijk, path.join(PACKS_DIR, naam));
    herlaad();
    console.log(`import ${naam} (${Math.round(data.length / 1024)} kB)`);
    return json(res, {ok: true, naam});
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const naam = url.searchParams.get('pack') || (pack && pack.naam);
    const doel = packs.get(naam);
    if (!doel) {
      return json(res, {ok: false, fout: `lezing "${naam}" bestaat niet`}, 400);
    }
    const bestandsnaam = String(url.searchParams.get('name') || '');
    const soort = kindForFile(bestandsnaam);
    if (!soort) {
      return json(
        res,
        {ok: false, fout: `"${bestandsnaam}" is geen afbeelding, video of html-pagina`},
        400,
      );
    }
    let data;
    try {
      data = await leesRuw(req);
    } catch (e) {
      return json(res, {ok: false, fout: e.message}, 400);
    }
    if (data.length === 0) {
      return json(res, {ok: false, fout: 'leeg bestand'}, 400);
    }

    const map = {image: 'images', video: 'videos', page: 'pages'}[soort];
    const mapAbs = path.join(doel.dir, 'assets', map);
    fs.mkdirSync(mapAbs, {recursive: true});

    // Hetzelfde bestand twee keer uploaden levert geen tweede kopie op: bij
    // gelijke inhoud hergebruiken we wat er al staat. Zo blijft een lezing met
    // dezelfde flyer in twee slides klein.
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    for (const bestaand of fs.readdirSync(mapAbs)) {
      const abs = path.join(mapAbs, bestaand);
      if (!fs.statSync(abs).isFile()) {
        continue;
      }
      if (fs.statSync(abs).size !== data.length) {
        continue;
      }
      const h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      if (h === hash) {
        return json(res, {
          ok: true,
          src: `assets/${map}/${bestaand}`,
          type: soort,
          hergebruikt: true,
        });
      }
    }

    const ext = path.extname(bestandsnaam).toLowerCase();
    let basis = path
      .basename(bestandsnaam, path.extname(bestandsnaam))
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'bestand';
    let kies = basis + ext;
    let n = 2;
    while (fs.existsSync(path.join(mapAbs, kies))) {
      kies = `${basis}-${n++}${ext}`;
    }
    fs.writeFileSync(path.join(mapAbs, kies), data);
    console.log(`upload ${naam}: ${map}/${kies} (${Math.round(data.length / 1024)} kB)`);
    return json(res, {ok: true, src: `assets/${map}/${kies}`, type: soort, hergebruikt: false});
  }

  // Bestanden van een willekeurige lezing, voor de preview in de editor. De
  // schermpagina gebruikt /assets/, dat is altijd de lezing die nu draait.
  if (p.startsWith('/packs/')) {
    const rest = p.slice('/packs/'.length);
    const schuin = rest.indexOf('/');
    if (schuin > 0) {
      const doel = packs.get(rest.slice(0, schuin));
      if (doel) {
        return stuurBestand(req, res, doel.dir, rest.slice(schuin));
      }
    }
    return json(res, {fout: 'niet gevonden'}, 404);
  }

  if (p === '/barcodes') {
    return stuurBestand(req, res, PUBLIC_DIR, '/barcodes.html');
  }

  if (p === '/editor') {
    return stuurBestand(req, res, PUBLIC_DIR, '/editor.html');
  }

  if (p.startsWith('/assets/')) {
    return stuurBestand(req, res, pack.dir, p);
  }

  if (p === '/' || p === '/operator' || p === '/index.html') {
    return stuurBestand(req, res, PUBLIC_DIR, '/operator.html');
  }
  if (p === '/show') {
    return stuurBestand(req, res, PUBLIC_DIR, '/show.html');
  }

  return stuurBestand(req, res, PUBLIC_DIR, p);
});

server.listen(port, () => {
  const ip = lokaalIp();
  const frames = pack.manifest.slides.reduce((n, s) => n + s.frames.length, 0);
  console.log('');
  console.log(`  Lezing:   ${pack.manifest.title || pack.naam} (${pack.manifest.slides.length} slides, ${frames} frames)`);
  const andere = [...packs.values()].filter(x => x.naam !== pack.naam);
  if (andere.length) {
    console.log(
      `  Ook klaar: ${andere.map(x => x.naam + (x.fout ? ' (klopt niet)' : '')).join(', ')}`,
    );
  }
  console.log('');
  console.log(`  Operator: http://localhost:${port}/`);
  console.log(`  Scherm:   http://localhost:${port}/show`);
  console.log(`  Editor:   http://localhost:${port}/editor`);
  console.log(`  Barcodes: http://localhost:${port}/barcodes`);
  console.log(`  Scanner:  http://${ip}:${port}/api/scan   (of via usb: http://127.0.0.1:${port})`);
  console.log('');
});
