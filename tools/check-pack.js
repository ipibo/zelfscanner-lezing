#!/usr/bin/env node
/**
 * Controleert een lezing-pack vóór de lezing.
 *
 *   node tools/check-pack.js [pack-map]
 *
 * Zonder argument: elke map in runner/packs/. Print per pack de fouten, of een
 * samenvatting als alles klopt. Exit-code 1 bij fouten, zodat dit ook in een
 * script kan.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {validateManifest, normalizeManifest} = require('../shared/manifest-schema');

const PACKS_DIR = path.join(__dirname, '..', 'runner', 'packs');

function packMappen() {
  const arg = process.argv[2];
  if (arg) {
    return [path.resolve(arg)];
  }
  if (!fs.existsSync(PACKS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(PACKS_DIR)
    .map(name => path.join(PACKS_DIR, name))
    .filter(p => fs.statSync(p).isDirectory());
}

const mappen = packMappen();
if (mappen.length === 0) {
  console.log('geen packs gevonden in runner/packs/');
  process.exit(0);
}

let fouten = 0;

for (const dir of mappen) {
  const naam = path.basename(dir);
  const file = path.join(dir, 'lezing.json');
  if (!fs.existsSync(file)) {
    console.log(`${naam}: FOUT -- geen lezing.json`);
    fouten++;
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`${naam}: FOUT -- lezing.json is geen geldige JSON: ${e.message}`);
    fouten++;
    continue;
  }
  const errors = validateManifest(manifest, dir);
  if (errors.length) {
    console.log(`${naam}: ${errors.length} fout(en)`);
    errors.forEach(e => console.log('  - ' + e));
    fouten += errors.length;
    continue;
  }
  const m = normalizeManifest(manifest);
  const frames = m.slides.reduce((n, s) => n + s.frames.length, 0);
  const meerdere = m.slides.filter(s => s.frames.length > 1).length;
  const zonderNote = m.slides.filter(s => !s.note && !s.frames.some(f => f.note)).length;
  const types = {};
  m.slides.forEach(s => s.frames.forEach(f => (types[f.type] = (types[f.type] || 0) + 1)));
  console.log(
    `${naam}: ok -- ${m.slides.length} slides, ${frames} frames ` +
      `(${Object.keys(types).map(t => `${types[t]} ${t}`).join(', ')}), ` +
      `${meerdere} met meerdere frames` +
      (zonderNote ? `, ${zonderNote} zonder note` : ''),
  );
}

process.exit(fouten ? 1 : 0);
