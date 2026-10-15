#!/usr/bin/env node
/**
 * Zet de oude handmatige database.json om naar een lezing-pack.
 *
 *   node tools/convert-oude-database.js <oude-public-map> <nieuwe-pack-map>
 *
 * Bijvoorbeeld:
 *   node tools/convert-oude-database.js \
 *     ~/Development/2024/zelfscanner-keynote/public \
 *     runner/packs/mijnlezing
 *
 * Leest <oude-public-map>/database.json, schrijft
 * <nieuwe-pack-map>/lezing.json en kopieert elk bestand waar het manifest naar
 * wijst mee naar <nieuwe-pack-map>/assets/ (met dezelfde submappen, dus
 * images/foo.png wordt assets/images/foo.png).
 *
 * Het oude formaat:
 *   "8718781601171": {"multiple": true, "note": "...",
 *                     "0": {"url": "images/a.png", "type": "image"},
 *                     "1": {"url": "images/b.jpg", "type": "image"}}
 *   "4019787601948": {"url": "images/schroeven.jpg", "type": "image", "note": "..."}
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {validateManifest, kindForFile} = require('../shared/manifest-schema');

function fail(msg) {
  console.error('FOUT: ' + msg);
  process.exit(1);
}

const [srcArg, dstArg] = process.argv.slice(2);
if (!srcArg || !dstArg) {
  fail('gebruik: node tools/convert-oude-database.js <oude-public-map> <nieuwe-pack-map>');
}

const srcDir = path.resolve(srcArg.replace(/^~/, process.env.HOME || '~'));
const dstDir = path.resolve(dstArg);
const dbFile = path.join(srcDir, 'database.json');

if (!fs.existsSync(dbFile)) {
  fail(`geen database.json in ${srcDir}`);
}

// De oude database EXAMPLE begint met een //-regel: geen geldige JSON, maar wel
// wat er in het veld staat. Dus die regels eerst eruit.
const raw = fs
  .readFileSync(dbFile, 'utf8')
  .split('\n')
  .filter(line => !/^\s*\/\//.test(line))
  .join('\n');

let oud;
try {
  oud = JSON.parse(raw);
} catch (e) {
  fail(`database.json is geen geldige JSON: ${e.message}`);
}

/**
 * In de sprekers echte database staat "note" twee keer in hetzelfde blok: eerst kort
 * de productnaam ("PRODUCT"), daarna zijn voorleestekst. JSON houdt bij
 * dubbele sleutels alleen de laatste over, dus die productnaam gaat bij een
 * gewone JSON.parse verloren. Zonde: het is precies het label waarmee je in de
 * operator-lijst een slide terugvindt. Daarom halen we hem met een scan over de
 * ruwe tekst alsnog op.
 */
function leesRuweTekst(tekst) {
  const labels = new Map();
  const volgorde = [];
  const START = /"(\d{4,14})"\s*:\s*\{/g;
  const NOTE = /"note"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

  const starts = [];
  let m;
  while ((m = START.exec(tekst)) !== null) {
    starts.push({code: m[1], at: m.index});
  }
  starts.forEach((s, i) => {
    volgorde.push(s.code);
    const blok = tekst.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : tekst.length);
    const notes = [];
    let n;
    NOTE.lastIndex = 0;
    while ((n = NOTE.exec(blok)) !== null) {
      notes.push(n[1]);
    }
    // Alleen als er écht twee staan en de eerste kort is: anders is het gewoon
    // de voorleestekst en verzinnen we geen label.
    if (notes.length > 1 && notes[0].length <= 60) {
      labels.set(s.code, notes[0].trim());
    }
  });
  return {labels, volgorde};
}

const {labels, volgorde} = leesRuweTekst(raw);

/**
 * De volgorde in het bestand is de volgorde van de lezing. Object.keys() geeft
 * die NIET terug: JavaScript zet sleutels die op een array-index lijken
 * vooraan, dus een barcode van 8 cijfers springt voor eentje van 13. Daardoor
 * stond in de eerste conversie PRODUCT bovenaan in plaats van PRODUCT. Voor
 * het scannen maakt de volgorde niet uit, voor de lijst en de pijltjes op de
 * operator-pagina wel.
 */
function barcodesInVolgorde(db) {
  const uit = volgorde.filter(c => Object.prototype.hasOwnProperty.call(db, c));
  for (const c of Object.keys(db)) {
    if (!uit.includes(c)) {
      uit.push(c);
    }
  }
  return uit;
}

const slides = [];
const kopieren = new Set();
const waarschuwingen = [];

function frameVan(entry, waar) {
  if (!entry || typeof entry.url !== 'string' || entry.url === '') {
    waarschuwingen.push(`${waar}: geen url, overgeslagen`);
    return null;
  }
  const rel = entry.url.replace(/^\.?\//, '');
  const kind = kindForFile(rel);
  if (!kind) {
    waarschuwingen.push(`${waar}: "${rel}" heeft een onbekende extensie, overgeslagen`);
    return null;
  }
  if (entry.type && entry.type !== kind) {
    // In de oude database stond het type met de hand ingevuld en dat ging mis.
    waarschuwingen.push(
      `${waar}: type stond op "${entry.type}" maar de extensie zegt "${kind}" -- "${kind}" gebruikt`,
    );
  }
  kopieren.add(rel);
  const frame = {src: 'assets/' + rel};
  if (typeof entry.note === 'string' && entry.note !== '') {
    frame.note = entry.note;
  }
  return frame;
}

for (const barcode of barcodesInVolgorde(oud)) {
  const entry = oud[barcode];
  if (!entry || typeof entry !== 'object') {
    waarschuwingen.push(`${barcode}: geen object, overgeslagen`);
    continue;
  }

  const frames = [];
  if (entry.multiple) {
    // Genummerde sleutels, op nummer gesorteerd: "0", "1", "2", ...
    const nummers = Object.keys(entry)
      .filter(k => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    for (const n of nummers) {
      const frame = frameVan(entry[n], `${barcode} frame ${n}`);
      if (frame) {
        frames.push(frame);
      }
    }
  } else {
    // Zonder "multiple" staat de note op dezelfde hoogte als de url. Die hoort
    // bij de slide, niet bij het frame -- anders staat hij er twee keer in.
    const frame = frameVan({url: entry.url, type: entry.type}, barcode);
    if (frame) {
      frames.push(frame);
    }
  }

  if (frames.length === 0) {
    waarschuwingen.push(`${barcode}: geen bruikbare frames, slide overgeslagen`);
    continue;
  }

  const slide = {barcode: String(barcode), frames};
  const label = labels.get(String(barcode));
  if (label) {
    slide.label = label;
  }
  if (typeof entry.note === 'string' && entry.note !== '') {
    slide.note = entry.note;
  }
  slides.push(slide);
}

if (slides.length === 0) {
  fail('geen enkele slide kunnen omzetten');
}

const manifest = {
  version: '1.0.0',
  title: path.basename(dstDir),
  slides,
};

const errors = validateManifest(manifest); // nog zonder packDir: bestanden komen hierna
if (errors.length) {
  fail('het omgezette manifest klopt niet:\n  - ' + errors.join('\n  - '));
}

// Bestanden kopiëren
fs.mkdirSync(dstDir, {recursive: true});
let gekopieerd = 0;
const ontbreekt = [];
for (const rel of kopieren) {
  const from = path.join(srcDir, rel);
  const to = path.join(dstDir, 'assets', rel);
  if (!fs.existsSync(from)) {
    ontbreekt.push(rel);
    continue;
  }
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.copyFileSync(from, to);
  gekopieerd++;
}

fs.writeFileSync(path.join(dstDir, 'lezing.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`${slides.length} slides omgezet naar ${path.join(dstDir, 'lezing.json')}`);
console.log(`${gekopieerd} van ${kopieren.size} bestanden gekopieerd naar ${path.join(dstDir, 'assets')}`);
console.log(`${slides.filter(s => s.label).length} labels overgenomen uit de dubbele note-sleutels`);
const meerdere = slides.filter(s => s.frames.length > 1);
if (meerdere.length) {
  console.log(`${meerdere.length} barcodes met meerdere frames: ${meerdere.map(s => s.barcode).join(', ')}`);
}
if (ontbreekt.length) {
  console.log('\nDeze bestanden stonden niet in de oude map (zet ze er zelf bij):');
  ontbreekt.forEach(r => console.log('  - ' + r));
}
if (waarschuwingen.length) {
  console.log('\nLet op:');
  waarschuwingen.forEach(w => console.log('  - ' + w));
}
console.log('\nControleer daarna met: node tools/check-pack.js ' + dstArg);
