/**
 * Barcodes tekenen als SVG. Geen afhankelijkheden, draait in de browser én in
 * node (voor tools/test-barcodes.js).
 *
 * EAN-13 en EAN-8 als de code die lengte heeft én het controlecijfer klopt.
 * Anders Code 128 (set B), want dat leest elke scanner en er zit geen
 * controlecijfer-eis op: zo kan je ook een eigen stuurbarcode van vier cijfers
 * maken zonder dat hij onleesbaar wordt.
 *
 * De modules (1 = streep, 0 = wit) worden eerst als string opgebouwd en pas
 * daarna getekend. Daardoor kan de test de string teruglezen en controleren of
 * er echt uitkomt wat erin ging.
 */
(function (root) {
  'use strict';

  // -------------------------------------------------------------- EAN-13 / 8

  var L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  var G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
  var R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];

  // Het eerste cijfer van een EAN-13 staat niet in strepen, maar in het patroon
  // van L en G in de linkerhelft.
  var PARITEIT = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

  function cijfers(code) {
    return String(code).split('').map(Number);
  }

  function controlecijferEan13(eerste12) {
    var som = 0;
    for (var i = 0; i < 12; i++) {
      som += eerste12[i] * (i % 2 === 0 ? 1 : 3);
    }
    return (10 - (som % 10)) % 10;
  }

  function controlecijferEan8(eerste7) {
    var som = 0;
    for (var i = 0; i < 7; i++) {
      som += eerste7[i] * (i % 2 === 0 ? 3 : 1);
    }
    return (10 - (som % 10)) % 10;
  }

  function modulesEan13(code) {
    var d = cijfers(code);
    var patroon = PARITEIT[d[0]];
    var uit = '101';
    for (var i = 1; i <= 6; i++) {
      uit += (patroon[i - 1] === 'L' ? L : G)[d[i]];
    }
    uit += '01010';
    for (var j = 7; j <= 12; j++) {
      uit += R[d[j]];
    }
    return uit + '101';
  }

  function modulesEan8(code) {
    var d = cijfers(code);
    var uit = '101';
    for (var i = 0; i < 4; i++) {
      uit += L[d[i]];
    }
    uit += '01010';
    for (var j = 4; j < 8; j++) {
      uit += R[d[j]];
    }
    return uit + '101';
  }

  // ------------------------------------------------------------------ Code 128

  // Breedtes van de 6 elementen per teken (streep, wit, streep, wit, ...).
  // Alles telt op tot 11, behalve het stopteken (13). tools/test-barcodes.js
  // controleert dat, want één typefout hier levert een barcode op die niet
  // gelezen wordt.
  var C128 = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112',
  ];

  function modulesCode128B(tekst) {
    var waarden = [104]; // start B
    for (var i = 0; i < tekst.length; i++) {
      var c = tekst.charCodeAt(i);
      if (c < 32 || c > 126) {
        throw new Error('teken past niet in Code 128 set B: ' + tekst[i]);
      }
      waarden.push(c - 32);
    }
    var som = waarden[0];
    for (var j = 1; j < waarden.length; j++) {
      som += waarden[j] * j;
    }
    waarden.push(som % 103);
    waarden.push(106); // stop

    var uit = '';
    for (var k = 0; k < waarden.length; k++) {
      var breedtes = C128[waarden[k]];
      for (var e = 0; e < breedtes.length; e++) {
        // Even index = streep, oneven = wit.
        uit += new Array(Number(breedtes[e]) + 1).join(e % 2 === 0 ? '1' : '0');
      }
    }
    return uit;
  }

  // --------------------------------------------------------------------- kiezen

  /**
   * Bepaalt welke symbologie bij een code past.
   * Geeft {soort, modules, stil, waarschuwing}.
   */
  function codeer(code) {
    var tekst = String(code).trim();
    var alleenCijfers = /^[0-9]+$/.test(tekst);

    if (alleenCijfers && tekst.length === 13) {
      var d13 = cijfers(tekst);
      if (controlecijferEan13(d13.slice(0, 12)) === d13[12]) {
        return {soort: 'EAN-13', modules: modulesEan13(tekst), stil: [11, 7]};
      }
      return {
        soort: 'Code 128',
        modules: modulesCode128B(tekst),
        stil: [10, 10],
        waarschuwing: 'controlecijfer klopt niet voor EAN-13, daarom Code 128',
      };
    }

    // UPC-A is een EAN-13 met een nul ervoor. Amerikaanse producten hebben
    // deze code. De strepen zijn dus
    // gewoon EAN-13, alleen staat het cijfer vooraan niet in de tekst.
    if (alleenCijfers && tekst.length === 12) {
      var d12 = cijfers('0' + tekst);
      if (controlecijferEan13(d12.slice(0, 12)) === d12[12]) {
        return {soort: 'UPC-A', modules: modulesEan13('0' + tekst), stil: [11, 7]};
      }
      return {
        soort: 'Code 128',
        modules: modulesCode128B(tekst),
        stil: [10, 10],
        waarschuwing: 'controlecijfer klopt niet voor UPC-A, daarom Code 128',
      };
    }

    if (alleenCijfers && tekst.length === 8) {
      var d8 = cijfers(tekst);
      if (controlecijferEan8(d8.slice(0, 7)) === d8[7]) {
        return {soort: 'EAN-8', modules: modulesEan8(tekst), stil: [7, 7]};
      }
      return {
        soort: 'Code 128',
        modules: modulesCode128B(tekst),
        stil: [10, 10],
        waarschuwing: 'controlecijfer klopt niet voor EAN-8, daarom Code 128',
      };
    }

    return {soort: 'Code 128', modules: modulesCode128B(tekst), stil: [10, 10]};
  }

  // ----------------------------------------------------------------- tekenen

  /**
   * SVG van een barcode. `hoogte` is de hoogte van de strepen in modules;
   * de breedte volgt uit het aantal modules, zodat de verhouding altijd klopt
   * en de scanner geen vervormde strepen ziet.
   */
  function svg(code, opties) {
    opties = opties || {};
    var res = codeer(code);
    var m = res.modules;
    var stilLinks = res.stil[0];
    var stilRechts = res.stil[1];
    var hoogte = opties.hoogte || 70;
    var tekstRuimte = opties.tekst === false ? 4 : 16;
    var breedte = stilLinks + m.length + stilRechts;
    // Bij EAN steken de begin-, midden- en eindstrepen iets door, dat is het
    // herkenbare patroon en het helpt de scanner.
    var langer = {};
    if (res.soort === 'EAN-13' || res.soort === 'UPC-A') {
      [0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94].forEach(function (i) { langer[i] = true; });
    } else if (res.soort === 'EAN-8') {
      [0, 1, 2, 31, 32, 33, 34, 35, 64, 65, 66].forEach(function (i) { langer[i] = true; });
    }

    var strepen = '';
    var i = 0;
    while (i < m.length) {
      if (m[i] === '0') { i++; continue; }
      var start = i;
      while (i < m.length && m[i] === '1') { i++; }
      var h = hoogte;
      for (var k = start; k < i; k++) {
        if (langer[k]) { h = hoogte + 5; }
      }
      strepen += '<rect x="' + (stilLinks + start) + '" y="0" width="' + (i - start) +
        '" height="' + h + '" fill="#000"/>';
    }

    var tekst = '';
    if (opties.tekst !== false) {
      var y = hoogte + 13;
      var stijl = 'font-family="Helvetica,Arial,sans-serif" font-size="9" fill="#000"';
      if (res.soort === 'EAN-13') {
        tekst += '<text x="' + (stilLinks - 3) + '" y="' + y + '" text-anchor="end" ' + stijl + '>' +
          code[0] + '</text>';
        tekst += '<text x="' + (stilLinks + 35) + '" y="' + y + '" text-anchor="middle" ' + stijl + '>' +
          code.slice(1, 7) + '</text>';
        tekst += '<text x="' + (stilLinks + 71) + '" y="' + y + '" text-anchor="middle" ' + stijl + '>' +
          code.slice(7) + '</text>';
      } else if (res.soort === 'EAN-8') {
        tekst += '<text x="' + (stilLinks + 17) + '" y="' + y + '" text-anchor="middle" ' + stijl + '>' +
          code.slice(0, 4) + '</text>';
        tekst += '<text x="' + (stilLinks + 50) + '" y="' + y + '" text-anchor="middle" ' + stijl + '>' +
          code.slice(4) + '</text>';
      } else if (res.soort === 'UPC-A') {
        tekst += '<text x="' + (stilLinks + 53) + '" y="' + y + '" text-anchor="middle" ' + stijl + '>' +
          code + '</text>';
      } else {
        tekst += '<text x="' + (breedte / 2) + '" y="' + y + '" text-anchor="middle" ' + stijl + '>' +
          code + '</text>';
      }
    }

    var totaal = hoogte + 5 + tekstRuimte;
    return {
      soort: res.soort,
      waarschuwing: res.waarschuwing || null,
      // Aantal modules breed, inclusief de stille marges. De pagina
      // vermenigvuldigt dit met de gekozen modulebreedte: een barcode moet op
      // het scherm groot genoeg zijn, anders leest de scanner hem niet.
      breedte: breedte,
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + breedte + ' ' + totaal + '" ' +
        'preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">' +
        '<rect x="0" y="0" width="' + breedte + '" height="' + totaal + '" fill="#fff"/>' +
        strepen + tekst + '</svg>',
    };
  }

  var api = {
    codeer: codeer,
    svg: svg,
    modulesEan13: modulesEan13,
    modulesEan8: modulesEan8,
    modulesCode128B: modulesCode128B,
    controlecijferEan13: controlecijferEan13,
    controlecijferEan8: controlecijferEan8,
    C128: C128,
    L: L, G: G, R: R, PARITEIT: PARITEIT,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Barcode = api;
  }
})(typeof window !== 'undefined' ? window : this);
