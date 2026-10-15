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
 * los uitvoerbaar bestand worden (zie docs/04).
 *
 * De frame-teller staat hier, op één plek. In de oude versie zat hij in
 * show.html en wist de scanner niet welk frame in beeld stond -- zie bug 5 en 6
 * in docs/02.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {loadPack} = require('../shared/manifest-schema');

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

function kiesPack() {
  if (!fs.existsSync(PACKS_DIR)) {
    throw new Error(`geen map ${PACKS_DIR}`);
  }
  const namen = fs
    .readdirSync(PACKS_DIR)
    .filter(n => !n.startsWith('.') && fs.statSync(path.join(PACKS_DIR, n)).isDirectory());
  if (packName) {
    if (!namen.includes(packName)) {
      throw new Error(`pack "${packName}" bestaat niet. Beschikbaar: ${namen.join(', ') || 'geen'}`);
    }
    return packName;
  }
  if (namen.length === 0) {
    throw new Error('geen packs in runner/packs/');
  }
  if (namen.length > 1) {
    throw new Error(
      `meerdere packs (${namen.join(', ')}) -- geef er één mee: node runner/server.js <naam>`,
    );
  }
  return namen[0];
}

let pack;
try {
  const naam = kiesPack();
  pack = loadPack(path.join(PACKS_DIR, naam));
  pack.naam = naam;
} catch (e) {
  console.error('\nKan de lezing niet laden:\n  ' + e.message + '\n');
  process.exit(1);
}

const slideOpBarcode = new Map();
pack.manifest.slides.forEach((slide, i) => {
  slide.index = i;
  slideOpBarcode.set(slide.barcode, slide);
});

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
 * Een scan van de zelfscanner.
 *
 * Dezelfde barcode opnieuw = volgend frame, en na het laatste frame weer het
 * eerste. Dat is de expliciete wens van de spreker en staat daarom hier, in één
 * functie, en niet in de pagina's.
 */
function scan(code) {
  if (pack.manifest.clearScan && code === pack.manifest.clearScan) {
    zet(null, 0, 'scan');
    return {ok: true, bekend: true, leeg: true};
  }
  const slide = slideOpBarcode.get(code);
  if (!slide) {
    // Niet in deze lezing: de stand blijft staan, de scanner meldt het.
    return {ok: true, bekend: false, barcode: code};
  }
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
  // antwoordt. Zie docs/04.
  if (p === '/api/hello') {
    return json(res, {app: 'zelfscanner-lezing', pack: pack.naam, ip: lokaalIp(), port});
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
  console.log('');
  console.log(`  Operator: http://localhost:${port}/`);
  console.log(`  Scherm:   http://localhost:${port}/show`);
  console.log(`  Scanner:  http://${ip}:${port}/api/scan   (of via usb: http://127.0.0.1:${port})`);
  console.log('');
});
