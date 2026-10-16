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

Of zonder naam, als er maar één lezing is. Daarna:

| Pagina | Waarvoor |
|---|---|
| <http://localhost:8080/editor> | lezingen bouwen: barcodes, frames, notes, uploads |
| <http://localhost:8080/> | operator: handbesturing, status, scanner-test |
| <http://localhost:8080/show> | het beeld voor de beamer |
| <http://localhost:8080/barcodes> | alle barcodes van de lezing, om van het scherm te scannen of te printen |

De zelfscanner POST straks naar `http://<ip>:8080/api/scan`.

**Een lezing naar de zelfscanner sturen:** in de editor op "Naar de scanner".
Die laat de aangesloten apparaten zien, stuurt de lezing en de notes erheen (een
paar kilobyte, de media blijven hier) en herstart de app. Met het vinkje "ook op
de beamer zetten" gaat de runner meteen dezelfde lezing draaien, anders horen de
notes in de sprekers hand bij iets anders dan het scherm laat zien.

Daarvoor roept de runner het push-script aan van het app-project, dat hij naast
zichzelf verwacht (`../zelfscanner-lezing-app`, of `LEZING_APP_DIR`). Staat dat
er niet, dan zegt de knop dat. De twee projecten blijven los van elkaar: dit is
een aanroep van een tool, geen afhankelijkheid in de code.

**Een lezing doorgeven:** in de editor op "Exporteren". Dat geeft één bestand,
`naam.lezing`, met de tekst en alle media erin (een gewone zip). Geef dat
persoonlijk door; de ander zet het met "Importeren" in zijn eigen runner.
Importeren overschrijft nooit iets: bestaat de naam al, dan wordt het `naam-2`.

Echte lezingen staan met opzet niet in git, alleen `runner/packs/demo` gaat
mee. de sprekers tekst hoort niet op internet.

**Zonder device testen:** hang een barcodescanner aan de laptop, zet op de
operator-pagina "Scanner-test" aan en scan. Die toetsaanslagen gaan dan naar
dezelfde `/api/scan` als straks vanaf het device.

| Map | Wat |
|---|---|
| `shared/manifest-schema.js` | het lezing-formaat plus validatie, één plek |
| `runner/server.js` | http en server-sent events, zonder afhankelijkheden |
| `runner/public/show.html` | de schermpagina voor de beamer |
| `runner/public/operator.html` | handbesturing, status en de notes |
| `runner/public/editor.html` | de editor: slides, frames, notes, uploads |
| `runner/packs/demo/` | demo-lezing om mee te testen |
| `runner/public/barcode.js` | EAN-13, EAN-8, UPC-A en Code 128 als svg |
| `shared/lezing-bestand.js` | een lezing in- en uitpakken als `.lezing`-bestand |
| `tools/check-pack.js` | controleert een pack vóór de lezing |
| `tools/test-barcodes.js` | leest de barcodes terug en controleert of ze kloppen |
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
