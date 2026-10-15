/**
 * Vangt de toetsaanslagen van een barcodescanner die aan de laptop hangt en
 * stuurt ze naar /api/scan, precies zoals het device het straks doet.
 *
 * Een scanner is een toetsenbord: hij tikt de cijfers er in één burst in en
 * sluit af met Enter -- of met niets, afhankelijk van hoe hij is ingesteld.
 * Daarom afsluiten op Enter én als het getik 200 ms stil valt. Zelfde aanpak
 * als in de v2-app (App.tsx, SCAN_IDLE_MS).
 *
 * Gebruik:
 *   var vanger = Scanvanger({aan: true, bij: function (tekst, gelukt) {...}});
 *   vanger.zet(false);
 */
(function (root) {
  'use strict';

  function Scanvanger(opties) {
    opties = opties || {};
    var aan = !!opties.aan;
    var bij = opties.bij || function () {};
    var buffer = '';
    var timer = null;

    function commit() {
      if (timer) { clearTimeout(timer); timer = null; }
      var code = buffer.replace(/[^0-9]/g, '');
      buffer = '';
      if (code.length < 4) { return; }
      fetch('/api/scan', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({barcode: code}),
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.bekend === false) {
            bij(code + ' staat niet in deze lezing', false);
          } else if (j && j.leeg) {
            bij(code + ' — scherm leeg', true);
          } else if (j) {
            bij(
              code + ' — ' + (j.label || 'slide ' + (j.slideIndex + 1)) +
                (j.frameCount > 1 ? ', frame ' + (j.frameIndex + 1) + ' van ' + j.frameCount : ''),
              true,
            );
          }
        })
        .catch(function (e) { bij('runner niet bereikbaar: ' + e.message, false); });
    }

    document.addEventListener('keydown', function (e) {
      if (!aan) { return; }
      // Niet meeluisteren terwijl iemand in een veld typt: daar hoort de scan
      // in het veld zelf terecht te komen.
      var t = e.target && e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') { return; }
      if (e.metaKey || e.ctrlKey || e.altKey) { return; }
      if (e.key === 'Enter') {
        if (buffer) { e.preventDefault(); commit(); }
        return;
      }
      if (e.key.length !== 1) { return; }
      buffer += e.key;
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(commit, 200);
    });

    return {
      zet: function (nieuw) { aan = !!nieuw; return aan; },
      staat: function () { return aan; },
    };
  }

  root.Scanvanger = Scanvanger;
})(window);
