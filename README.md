# zelfscanner-lezing

Dashboard plus runtime voor de lezing die de spreker met een zelfscanner in de hand
geeft. Hij scant een barcode, op het scherm verschijnt een slide (afbeelding,
video of html-pagina) en op de zelfscanner staan zijn notes.

Opvolger van `~/Development/2024/zelfscanner-keynote` (public/index.html +
public/show.html + handmatige database.json). De speurtocht is een ander
project: `~/Development/2026/zelfscanner-v2`.

## Wat er nu staat

Het pack-formaat, de validatie en de runner. Het dashboard nog niet.

```bash
node runner/server.js demo
```

Daarna: operator op <http://localhost:8080/>, scherm op
<http://localhost:8080/show>. De zelfscanner POST straks naar
`http://<ip>:8080/api/scan`.

| Map | Wat |
|---|---|
| `shared/manifest-schema.js` | het lezing-formaat plus validatie, één plek |
| `runner/server.js` | http en server-sent events, zonder afhankelijkheden |
| `runner/public/show.html` | de schermpagina voor de beamer |
| `runner/public/operator.html` | handbesturing, status en de notes |
| `runner/packs/demo/` | demo-lezing om mee te testen |
| `tools/check-pack.js` | controleert een pack vóór de lezing |
| `tools/convert-oude-database.js` | zet de oude `database.json` om |

De oude lezing omzetten naar het nieuwe formaat:

```bash
node tools/convert-oude-database.js ~/Development/2024/zelfscanner-keynote/public runner/packs/mijnlezing
```

Hiermee zijn de bugs 1 tot en met 7 uit [doc 02](docs/02-oude-versie.md) weg: de
frame-teller staat op de server, er zit geen ip-adres meer in de html, een
onbekende barcode laat de stand gewoon staan, en de lezing is van de laptop af
te draaien als de scanner het niet doet.



## Documenten

1. [Wensen de spreker](docs/01-wensen.md) — zijn overzichtje, plus de vragen die
   er nog uit volgen.
2. [Oude versie](docs/02-oude-versie.md) — hoe het nu werkt, wat er kapot is,
   wat we hergebruiken uit zelfscanner-v2.
3. [Wat we nodig hebben](docs/03-wat-we-nodig-hebben.md) — opzet in drie delen,
   pack-formaat, de vier keuzes, inschatting.
4. [Architectuur en stack](docs/04-architectuur-en-stack.md) — de harde
   randvoorwaarden, hoe we van de router af komen, de stack per onderdeel.
5. [Hergebruik van zelfscanner-v2](docs/05-hergebruik-v2.md) — wat de v2-code
   doet, wat we eruit kopiëren, en het besluit: twee aparte apps.

## De vier delen

- **Dashboard** (Vercel): lezingen bouwen, media uploaden, exporteren.
- **Pack**: `lezing.json` plus `assets/`, één map of zip per lezing.
- **Runner** (lokaal op de laptop, dubbelklik): serveert de schermpagina en de
  operator-pagina op localhost, houdt de packs, pusht naar de scanner over usb.
- **Scanner-app** (eigen app, schil gekopieerd uit zelfscanner-v2): pack
  lokaal, notes offline, stuurt alleen scan-events.

Besluit 2026-10-15: de presentatie wordt een **eigen app**, los van de
speurtocht-app. Eigen applicationId, eigen manifest, eigen dashboard. Wat we uit
zelfscanner-v2 meenemen gaat als kopie mee, niet als afhankelijkheid. Zie doc 5.

Beide kanten hebben de hele lezing lokaal. Over het draadloze netwerk gaat
alleen "barcode X, frame 2". Daarom valt de installatie niet meer om als het
netwerk wegvalt.
