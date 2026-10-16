/**
 * Een lezing als één bestand: `naam.lezing`, om door te geven en weer in te
 * lezen. Zo hoeft de inhoud van een echte lezing nooit in git of op internet:
 * je exporteert hem in de editor, geeft het bestand persoonlijk door, en de
 * ander importeert het.
 *
 * Het is een gewone zip (hernoem naar .zip en de Finder pakt hem uit):
 *
 *   lezing.json
 *   assets/images/...
 *   assets/videos/...
 *   assets/pages/...
 *
 * Geen afhankelijkheden, net als de runner: alleen zlib uit Node. Media
 * (jpg, mp4, ...) gaat ongecomprimeerd mee, want die is al gecomprimeerd en
 * inpakken kost dan alleen tijd. Bij het inlezen accepteren we ook een zip die
 * de Finder heeft gemaakt: met één map eromheen en een __MACOSX-map erbij.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const AL_GECOMPRIMEERD = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.webm', '.mp3', '.m4a', '.zip',
]);

const MAX_BESTANDEN = 5000;
const MAX_UITGEPAKT = 2 * 1024 * 1024 * 1024; // 2 GB

// ----------------------------------------------------------------------- crc32

const CRC_TABEL = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABEL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------- inpakken

/** Alle bestanden onder `dir`, als relatieve paden met /, zonder verborgen bestanden. */
function bestandenIn(dir, rel) {
  const uit = [];
  for (const naam of fs.readdirSync(path.join(dir, rel || '')).sort()) {
    if (naam.startsWith('.')) {
      continue;
    }
    const r = rel ? rel + '/' + naam : naam;
    const stat = fs.statSync(path.join(dir, r));
    if (stat.isDirectory()) {
      uit.push(...bestandenIn(dir, r));
    } else if (stat.isFile()) {
      uit.push(r);
    }
  }
  return uit;
}

/** Een pack-map inpakken tot de inhoud van een .lezing-bestand. */
function pakIn(packDir) {
  const lokaal = [];
  const centraal = [];
  let offset = 0;

  const bestanden = ['lezing.json'].concat(
    fs.existsSync(path.join(packDir, 'assets'))
      ? bestandenIn(packDir, 'assets')
      : [],
  );

  for (const rel of bestanden) {
    const data = fs.readFileSync(path.join(packDir, rel));
    const naam = Buffer.from(rel, 'utf8');
    const crc = crc32(data);
    const inpakken = !AL_GECOMPRIMEERD.has(path.extname(rel).toLowerCase());
    const opgeslagen = inpakken ? zlib.deflateRawSync(data) : data;
    const methode = inpakken ? 8 : 0;

    const kop = Buffer.alloc(30);
    kop.writeUInt32LE(0x04034b50, 0);
    kop.writeUInt16LE(20, 4); // versie nodig
    kop.writeUInt16LE(0x0800, 6); // vlag: namen in utf-8
    kop.writeUInt16LE(methode, 8);
    kop.writeUInt16LE(0, 10); // tijd
    kop.writeUInt16LE(0x21, 12); // datum: 1980-01-01
    kop.writeUInt32LE(crc, 14);
    kop.writeUInt32LE(opgeslagen.length, 18);
    kop.writeUInt32LE(data.length, 22);
    kop.writeUInt16LE(naam.length, 26);
    kop.writeUInt16LE(0, 28);
    lokaal.push(kop, naam, opgeslagen);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(methode, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(opgeslagen.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(naam.length, 28);
    c.writeUInt32LE(offset, 42);
    centraal.push(c, naam);

    offset += kop.length + naam.length + opgeslagen.length;
    if (offset > 0xffffffff) {
      throw new Error('lezing groter dan 4 GB, dat kan dit formaat niet');
    }
  }

  const centraalBuf = Buffer.concat(centraal);
  const eind = Buffer.alloc(22);
  eind.writeUInt32LE(0x06054b50, 0);
  eind.writeUInt16LE(bestanden.length, 8);
  eind.writeUInt16LE(bestanden.length, 10);
  eind.writeUInt32LE(centraalBuf.length, 12);
  eind.writeUInt32LE(offset, 16);
  return Buffer.concat(lokaal.concat([centraalBuf, eind]));
}

// ------------------------------------------------------------------- uitpakken

/** De zip lezen: [{naam, data}], zonder iets op schijf te zetten. */
function leesZip(buf) {
  let eind = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eind = i;
      break;
    }
  }
  if (eind < 0) {
    throw new Error('dit is geen .lezing-bestand (geen zip)');
  }
  const aantal = buf.readUInt16LE(eind + 10);
  let p = buf.readUInt32LE(eind + 16);
  if (aantal === 0xffff || p === 0xffffffff) {
    throw new Error('zip64 wordt niet ondersteund');
  }
  if (aantal > MAX_BESTANDEN) {
    throw new Error(`te veel bestanden in de zip (${aantal})`);
  }

  const uit = [];
  let totaal = 0;
  for (let n = 0; n < aantal; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('zip is beschadigd');
    }
    const vlag = buf.readUInt16LE(p + 8);
    const methode = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const ingepakt = buf.readUInt32LE(p + 20);
    const grootte = buf.readUInt32LE(p + 24);
    const naamLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lokaalOffset = buf.readUInt32LE(p + 42);
    const naam = buf.toString(vlag & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + naamLen);
    p += 46 + naamLen + extraLen + commentLen;

    if (naam.endsWith('/')) {
      continue; // map
    }
    if (vlag & 1) {
      throw new Error('versleutelde zip wordt niet ondersteund');
    }
    totaal += grootte;
    if (totaal > MAX_UITGEPAKT) {
      throw new Error('uitgepakt groter dan 2 GB');
    }

    const lNaam = buf.readUInt16LE(lokaalOffset + 26);
    const lExtra = buf.readUInt16LE(lokaalOffset + 28);
    const start = lokaalOffset + 30 + lNaam + lExtra;
    const ruw = buf.subarray(start, start + ingepakt);
    let data;
    if (methode === 0) {
      data = ruw;
    } else if (methode === 8) {
      data = zlib.inflateRawSync(ruw, {maxOutputLength: Math.max(grootte, 1)});
    } else {
      throw new Error(`${naam}: inpakmethode ${methode} wordt niet ondersteund`);
    }
    if (data.length !== grootte || crc32(data) !== crc) {
      throw new Error(`${naam}: beschadigd in de zip`);
    }
    uit.push({naam, data});
  }
  return uit;
}

/**
 * Een .lezing uitpakken naar `doelDir` (bestaat nog niet). Alleen lezing.json
 * en wat onder assets/ staat komt mee; een pad dat buiten de map wil (../)
 * wordt geweigerd.
 */
function pakUit(buf, doelDir) {
  doelDir = path.resolve(doelDir);
  let bestanden = leesZip(buf).filter(
    b => !b.naam.startsWith('__MACOSX/') && !path.posix.basename(b.naam).startsWith('.'),
  );

  // De Finder zet er een map omheen: "mijnlezing/lezing.json". Die map halen we weg.
  if (!bestanden.some(b => b.naam === 'lezing.json')) {
    const json = bestanden.filter(b => /^[^/]+\/lezing\.json$/.test(b.naam));
    if (json.length !== 1) {
      throw new Error('geen lezing.json in dit bestand');
    }
    const voor = json[0].naam.slice(0, -'lezing.json'.length);
    bestanden = bestanden
      .filter(b => b.naam.startsWith(voor))
      .map(b => ({naam: b.naam.slice(voor.length), data: b.data}));
  }

  fs.mkdirSync(doelDir, {recursive: true});
  for (const b of bestanden) {
    const rel = path.posix.normalize(b.naam);
    if (rel !== 'lezing.json' && !rel.startsWith('assets/')) {
      continue;
    }
    const abs = path.resolve(doelDir, rel);
    if (!abs.startsWith(doelDir + path.sep)) {
      throw new Error(`${b.naam}: pad buiten de lezing`);
    }
    fs.mkdirSync(path.dirname(abs), {recursive: true});
    fs.writeFileSync(abs, b.data);
  }
}

module.exports = {pakIn, pakUit, leesZip};
