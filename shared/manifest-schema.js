/**
 * Validatie van een lezing-pack -- één plek, gebruikt door de runner
 * (runner/server.js), de controle vooraf (tools/check-pack.js), de conversie
 * van de oude database (tools/convert-oude-database.js) en later het dashboard.
 *
 * Aanpak overgenomen uit zelfscanner-v2 (tools/manifest-schema.js, 2026-09),
 * maar met het formaat van de lezing. Die twee projecten zijn los van elkaar,
 * zie docs/05-hergebruik-v2.md: dit is een kopie, geen afhankelijkheid.
 *
 * Vorm (zie docs/03-wat-we-nodig-hebben.md):
 *   {
 *     version: "1.0.0",
 *     title: "Mijn lezing",
 *     clearScan: "8712345679999",      // optioneel: maakt het scherm leeg
 *     slides: [
 *       {
 *         barcode: "8718781601171",
 *         label: "flyers",             // optioneel, alleen voor de operator
 *         note: "tekst voor de spreker<br>html mag",
 *         frames: [
 *           {src: "assets/07_flyer.png"},
 *           {src: "assets/08_flyer2.jpg", note: "optioneel, per frame"}
 *         ]
 *       }
 *     ]
 *   }
 *
 * Eén slide = één barcode. `frames` is altijd een lijst, ook bij één beeld:
 * daardoor is er één code-pad in plaats van het `multiple`-geval uit de oude
 * database.json. Na het laatste frame springt een nieuwe scan terug naar het
 * eerste (expliciete wens van de spreker).
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Minstens 4 cijfers, want een eigen stuurbarcode (leegmaken) mag korter zijn
// dan een echte EAN. Hoogstens 14: EAN-13 plus checkdigit-varianten.
const BARCODE_RE = /^[0-9]{4,14}$/;

// Soort bestand -> extensies. Het type van een frame leiden we hieruit af, dus
// de spreker hoeft nooit "image" of "page" te typen. Dat was fout nummer één in de
// oude handmatige database.
const EXT = {
  image: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']),
  video: new Set(['.mp4', '.mov', '.webm']),
  page: new Set(['.html', '.htm']),
};

const MAX_NOTE_LENGTH = 4000;

function kindForFile(rel) {
  const ext = path.extname(String(rel || '')).toLowerCase();
  for (const kind of Object.keys(EXT)) {
    if (EXT[kind].has(ext)) {
      return kind;
    }
  }
  return null;
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isString(v) {
  return typeof v === 'string';
}

/**
 * Vult per frame het afgeleide type in en zet het note-veld klaar, zodat de
 * runner en de pagina's niets meer hoeven te raden. Muteert niet: geeft een
 * nieuw object terug.
 */
function normalizeManifest(manifest) {
  const slides = (manifest.slides || []).map(slide => {
    const frames = (slide.frames || []).map(frame => ({
      src: frame.src,
      type: frame.type || kindForFile(frame.src),
      // Een frame zonder eigen note erft die van de slide, zodat de spreker in het
      // gewone geval één keer zijn tekst schrijft.
      note: isString(frame.note) ? frame.note : slide.note || '',
    }));
    return {
      barcode: String(slide.barcode),
      label: slide.label || '',
      note: slide.note || '',
      frames,
    };
  });
  return {
    version: manifest.version || '1.0.0',
    title: manifest.title || '',
    clearScan: manifest.clearScan || '',
    slides,
  };
}

/**
 * Controleert een manifest. `packDir` is de map waarin het manifest staat; is
 * die meegegeven, dan wordt ook gecheckt of elk bestand echt bestaat. Geeft een
 * lijst met foutmeldingen terug, leeg betekent goed.
 */
function validateManifest(manifest, packDir) {
  const errors = [];

  if (!isObject(manifest)) {
    return ['manifest is geen object'];
  }
  if (manifest.multiple || manifest['0']) {
    return [
      'dit lijkt de oude database.json (met "multiple" en genummerde slides) -- ' +
        'draai eerst tools/convert-oude-database.js',
    ];
  }
  if (!Array.isArray(manifest.slides) || manifest.slides.length === 0) {
    return ['manifest heeft geen slides'];
  }
  if (manifest.title !== undefined && !isString(manifest.title)) {
    errors.push('title moet tekst zijn');
  }

  function checkBarcode(label, code) {
    if (!isString(code) || !BARCODE_RE.test(code)) {
      errors.push(`${label}: "${code}" is geen geldige barcode (4 tot 14 cijfers)`);
      return false;
    }
    return true;
  }

  function checkFile(label, rel) {
    const kind = kindForFile(rel);
    if (!kind) {
      errors.push(
        `${label}: "${rel}" heeft geen bekende extensie ` +
          `(afbeelding, video of html-pagina)`,
      );
      return;
    }
    if (!packDir) {
      return;
    }
    // Nooit buiten de pack-map kijken: een manifest komt straks uit het
    // dashboard en mag niet naar willekeurige bestanden op de laptop wijzen.
    const abs = path.resolve(packDir, rel);
    if (abs !== packDir && !abs.startsWith(packDir + path.sep)) {
      errors.push(`${label}: "${rel}" wijst buiten de pack-map`);
      return;
    }
    if (!fs.existsSync(abs)) {
      errors.push(`${label}: bestand "${rel}" staat niet in de pack-map`);
    }
  }

  function checkNote(label, note) {
    if (note === undefined || note === null || note === '') {
      return;
    }
    if (!isString(note)) {
      errors.push(`${label}: note moet tekst zijn`);
    } else if (note.length > MAX_NOTE_LENGTH) {
      errors.push(`${label}: note is langer dan ${MAX_NOTE_LENGTH} tekens`);
    }
  }

  const seen = new Map();

  manifest.slides.forEach((slide, i) => {
    const label = `slide ${i + 1}`;
    if (!isObject(slide)) {
      errors.push(`${label} is geen object`);
      return;
    }
    if (checkBarcode(`${label} barcode`, slide.barcode)) {
      if (seen.has(slide.barcode)) {
        errors.push(
          `${label}: barcode ${slide.barcode} staat ook op slide ${seen.get(slide.barcode)} -- ` +
            `meerdere beelden achter één barcode zijn frames, geen tweede slide`,
        );
      } else {
        seen.set(slide.barcode, i + 1);
      }
    }
    checkNote(label, slide.note);
    if (slide.label !== undefined && !isString(slide.label)) {
      errors.push(`${label}: label moet tekst zijn`);
    }

    if (!Array.isArray(slide.frames) || slide.frames.length === 0) {
      errors.push(`${label}: geen frames (minstens één beeld per barcode)`);
      return;
    }
    slide.frames.forEach((frame, j) => {
      const flabel = `${label} frame ${j + 1}`;
      if (!isObject(frame)) {
        errors.push(`${flabel} is geen object`);
        return;
      }
      if (!isString(frame.src) || frame.src === '') {
        errors.push(`${flabel}: geen src`);
        return;
      }
      checkFile(flabel, frame.src);
      if (frame.type !== undefined) {
        const kind = kindForFile(frame.src);
        if (frame.type !== kind) {
          errors.push(
            `${flabel}: type "${frame.type}" past niet bij de extensie ` +
              `(dat zou "${kind}" zijn) -- laat type weg, we leiden het af`,
          );
        }
      }
      checkNote(flabel, frame.note);
    });
  });

  if (manifest.clearScan) {
    if (checkBarcode('clearScan', manifest.clearScan) && seen.has(manifest.clearScan)) {
      errors.push(
        `clearScan ${manifest.clearScan} is ook een slide-barcode -- kies een code die verder niets doet`,
      );
    }
  }

  return errors;
}

/** Leest en valideert een pack-map. Gooit met een leesbare melding. */
function loadPack(packDir) {
  const dir = path.resolve(packDir);
  const file = path.join(dir, 'lezing.json');
  if (!fs.existsSync(file)) {
    throw new Error(`geen lezing.json in ${dir}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`lezing.json is geen geldige JSON: ${e.message}`);
  }
  const errors = validateManifest(manifest, dir);
  if (errors.length) {
    throw new Error(`lezing.json klopt niet:\n  - ${errors.join('\n  - ')}`);
  }
  return {dir, manifest: normalizeManifest(manifest)};
}

module.exports = {
  BARCODE_RE,
  EXT,
  kindForFile,
  normalizeManifest,
  validateManifest,
  loadPack,
};
