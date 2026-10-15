#!/usr/bin/env node
/**
 * Controleert runner/public/barcode.js.
 *
 *   node tools/test-barcodes.js
 *
 * Een barcode die er goed uitziet maar verkeerd gecodeerd is, merk je pas als
 * de scanner in de zaal niets doet. Daarom hier geen plaatjesvergelijking maar
 * een decoder: de strepen worden teruggelezen en moeten precies de cijfers
 * opleveren die erin gingen.
 */
'use strict';

const B = require('../runner/public/barcode.js');

let fouten = 0;
function check(naam, voorwaarde, detail) {
  if (voorwaarde) {
    console.log(`  ok   ${naam}`);
  } else {
    console.log(`  FOUT ${naam}${detail ? ' -- ' + detail : ''}`);
    fouten++;
  }
}

// ---------------------------------------------------------------- decoders

function decodeerEan13(m) {
  if (m.length !== 95) { throw new Error('lengte ' + m.length + ' in plaats van 95'); }
  if (m.slice(0, 3) !== '101') { throw new Error('startpatroon klopt niet'); }
  if (m.slice(45, 50) !== '01010') { throw new Error('middenpatroon klopt niet'); }
  if (m.slice(92, 95) !== '101') { throw new Error('eindpatroon klopt niet'); }

  let pariteit = '';
  let cijfers = '';
  for (let i = 0; i < 6; i++) {
    const stuk = m.slice(3 + i * 7, 10 + i * 7);
    const l = B.L.indexOf(stuk);
    const g = B.G.indexOf(stuk);
    if (l >= 0) { pariteit += 'L'; cijfers += l; }
    else if (g >= 0) { pariteit += 'G'; cijfers += g; }
    else { throw new Error('linkercijfer ' + (i + 1) + ' niet herkend'); }
  }
  const eerste = B.PARITEIT.indexOf(pariteit);
  if (eerste < 0) { throw new Error('pariteitspatroon ' + pariteit + ' bestaat niet'); }

  let rechts = '';
  for (let j = 0; j < 6; j++) {
    const stuk = m.slice(50 + j * 7, 57 + j * 7);
    const r = B.R.indexOf(stuk);
    if (r < 0) { throw new Error('rechtercijfer ' + (j + 1) + ' niet herkend'); }
    rechts += r;
  }
  return String(eerste) + cijfers + rechts;
}

function decodeerEan8(m) {
  if (m.length !== 67) { throw new Error('lengte ' + m.length + ' in plaats van 67'); }
  if (m.slice(0, 3) !== '101' || m.slice(31, 36) !== '01010' || m.slice(64, 67) !== '101') {
    throw new Error('hulppatronen kloppen niet');
  }
  let uit = '';
  for (let i = 0; i < 4; i++) {
    const l = B.L.indexOf(m.slice(3 + i * 7, 10 + i * 7));
    if (l < 0) { throw new Error('linkercijfer ' + (i + 1) + ' niet herkend'); }
    uit += l;
  }
  for (let j = 0; j < 4; j++) {
    const r = B.R.indexOf(m.slice(36 + j * 7, 43 + j * 7));
    if (r < 0) { throw new Error('rechtercijfer ' + (j + 1) + ' niet herkend'); }
    uit += r;
  }
  return uit;
}

/** Leest de modules terug als breedtes en daarmee als Code 128-waarden. */
function decodeerCode128B(m) {
  const breedtes = [];
  let i = 0;
  while (i < m.length) {
    const teken = m[i];
    let n = 0;
    while (i < m.length && m[i] === teken) { n++; i++; }
    breedtes.push(n);
  }
  // Het stopteken heeft 7 elementen in plaats van 6, dus dat blijft buiten de
  // lus: anders leest hij de eerste zes daarvan als een gewoon teken.
  const waarden = [];
  for (let k = 0; k + 6 <= breedtes.length - 7; k += 6) {
    const patroon = breedtes.slice(k, k + 6).join('');
    const v = B.C128.indexOf(patroon);
    if (v < 0) { throw new Error('patroon ' + patroon + ' bestaat niet'); }
    waarden.push(v);
  }
  const staart = breedtes.slice(breedtes.length - 7).join('');
  if (staart !== B.C128[106]) { throw new Error('stopteken klopt niet: ' + staart); }

  const start = waarden.shift();
  if (start !== 104) { throw new Error('startteken is geen set B'); }
  const controle = waarden.pop();
  let som = 104;
  waarden.forEach((w, n) => { som += w * (n + 1); });
  if (som % 103 !== controle) { throw new Error('controlegetal klopt niet'); }
  return waarden.map(w => String.fromCharCode(w + 32)).join('');
}

// ------------------------------------------------------------------- tests

console.log('\nCode 128-tabel');
let tabelGoed = true;
B.C128.forEach((p, i) => {
  const som = p.split('').reduce((n, c) => n + Number(c), 0);
  const verwacht = i === 106 ? 13 : 11;
  const lengte = i === 106 ? 7 : 6;
  if (p.length !== lengte || som !== verwacht || /[^1-4]/.test(p)) {
    console.log(`  FOUT patroon ${i} = ${p} (som ${som}, verwacht ${verwacht})`);
    tabelGoed = false;
  }
});
check('alle 107 patronen hebben de juiste breedte', tabelGoed && B.C128.length === 107);

console.log('\nEAN-13 heen en terug');
['8718781601171', '8000050828809', '7613036600996', '5000112658637', '8710400186601'].forEach(code => {
  let uit = null;
  let fout = null;
  try { uit = decodeerEan13(B.modulesEan13(code)); } catch (e) { fout = e.message; }
  check(code, uit === code, fout || 'kwam terug als ' + uit);
});

console.log('\nEAN-8 heen en terug');
['87158212', '96385074'].forEach(code => {
  let uit = null;
  let fout = null;
  try { uit = decodeerEan8(B.modulesEan8(code)); } catch (e) { fout = e.message; }
  check(code, uit === code, fout || 'kwam terug als ' + uit);
});

console.log('\nCode 128 heen en terug');
['8712345679999', '1234', '12345', '870001234567890'].forEach(code => {
  let uit = null;
  let fout = null;
  try { uit = decodeerCode128B(B.modulesCode128B(code)); } catch (e) { fout = e.message; }
  check(code, uit === code, fout || 'kwam terug als ' + uit);
});

console.log('\nUPC-A (12 cijfers) gaat als EAN-13 met een nul ervoor');
['051111407592', '036000291452'].forEach(code => {
  let uit = null;
  let fout = null;
  try { uit = decodeerEan13(B.codeer(code).modules); } catch (e) { fout = e.message; }
  check(code, uit === '0' + code, fout || 'kwam terug als ' + uit);
});

console.log('\nKeuze van de symbologie');
check('geldige EAN-13 wordt EAN-13', B.codeer('8718781601171').soort === 'EAN-13');
check('geldige EAN-8 wordt EAN-8', B.codeer('87158212').soort === 'EAN-8');
check(
  'EAN-13 met fout controlecijfer valt terug op Code 128',
  B.codeer('8718781601170').soort === 'Code 128',
);
check('vier cijfers worden Code 128', B.codeer('1234').soort === 'Code 128');
check('geldige UPC-A wordt UPC-A', B.codeer('051111407592').soort === 'UPC-A');
check(
  'UPC-A met fout controlecijfer valt terug op Code 128',
  B.codeer('051111407593').soort === 'Code 128',
);

console.log('\nSVG');
const s = B.svg('8718781601171');
check('svg bevat rechthoeken', s.svg.indexOf('<rect') > 0);
check('svg heeft een viewBox', /viewBox="0 0 113 /.test(s.svg), s.svg.slice(0, 120));

console.log(fouten ? `\n${fouten} fout(en)\n` : '\nalles goed\n');
process.exit(fouten ? 1 : 0);
