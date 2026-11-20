/* 작은 QR 코드 생성기(바이트 모드, 오류 정정 M, 버전 1~10). 외부 라이브러리 없이 동작한다.
   사용: makeQrSvg('https://...') -> SVG 문자열 */
(function (root) {
  'use strict';
  var ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) { var n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }
  function dataCodewords(v) { return Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * NUM_BLOCKS[v]; }
  function bit(x, i) { return ((x >>> i) & 1) !== 0; }

  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z;
  }
  function rsDivisor(deg) {
    var r = []; for (var i = 0; i < deg; i++) r.push(0);
    r[deg - 1] = 1;
    var root = 1;
    for (var k = 0; k < deg; k++) {
      for (var j = 0; j < deg; j++) { r[j] = gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
      root = gfMul(root, 2);
    }
    return r;
  }
  function rsRemainder(data, div) {
    var r = div.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ r.shift(); r.push(0);
      div.forEach(function (c, i) { r[i] ^= gfMul(c, f); });
    });
    return r;
  }

  function utf8(str) {
    var out = [], bytes = unescape(encodeURIComponent(str));
    for (var i = 0; i < bytes.length; i++) out.push(bytes.charCodeAt(i));
    return out;
  }

  function encode(text) {
    var bytes = utf8(text), ver = 0;
    for (var v = 1; v <= 10; v++) {
      var used = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (used <= dataCodewords(v) * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('QR에 담기에는 주소가 너무 깁니다.');
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    var cap = dataCodewords(ver) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0; for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    // 블록 나누기, 오류 정정 코드 붙이기, 섞어 쓰기
    var nb = NUM_BLOCKS[ver], ecl = ECC_PER_BLOCK[ver];
    var total = Math.floor(rawModules(ver) / 8);
    var shortBlocks = nb - total % nb, shortLen = Math.floor(total / nb);
    var div = rsDivisor(ecl), blocks = [], k = 0;
    for (var n = 0; n < nb; n++) {
      var len = shortLen - ecl + (n < shortBlocks ? 0 : 1);
      var d = data.slice(k, k + len); k += len;
      var ec = rsRemainder(d, div);
      if (n < shortBlocks) d.push(0);
      blocks.push(d.concat(ec));
    }
    var out = [];
    for (var c = 0; c < blocks[0].length; c++) {
      blocks.forEach(function (blk, n2) {
        if (c !== shortLen - ecl || n2 >= shortBlocks) out.push(blk[c]);
      });
    }
    return { ver: ver, codewords: out };
  }

  function build(text) {
    var e = encode(text), ver = e.ver, size = ver * 4 + 17;
    var mod = [], isFn = [];
    for (var y = 0; y < size; y++) { mod.push(new Array(size).fill(false)); isFn.push(new Array(size).fill(false)); }
    function setFn(x, y, dark) { mod[y][x] = dark; isFn[y][x] = true; }

    for (var i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2, pos = [6];
      for (var p = size - 7; pos.length < na; p -= step) pos.splice(1, 0, p);
      pos.forEach(function (ax, ai) {
        pos.forEach(function (ay, aj) {
          if ((ai === 0 && aj === 0) || (ai === 0 && aj === na - 1) || (ai === na - 1 && aj === 0)) return;
          for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++)
            setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        });
      });
    }
    function formatBits(mask) {   // 오류 정정 수준 M의 형식 비트는 00
      var data = mask, rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      return ((data << 10) | rem) ^ 0x5412;
    }
    function drawFormat(mask) {
      var b = formatBits(mask), i;
      for (i = 0; i <= 5; i++) setFn(8, i, bit(b, i));
      setFn(8, 7, bit(b, 6)); setFn(8, 8, bit(b, 7)); setFn(7, 8, bit(b, 8));
      for (i = 9; i < 15; i++) setFn(14 - i, 8, bit(b, i));
      for (i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(b, i));
      for (i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(b, i));
      setFn(8, size - 8, true);
    }
    drawFormat(0);
    if (ver >= 7) {
      var rem = ver;
      for (var q = 0; q < 12; q++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vb = (ver << 12) | rem;
      for (var t = 0; t < 18; t++) {
        var a = size - 11 + t % 3, bb = Math.floor(t / 3);
        setFn(a, bb, bit(vb, t)); setFn(bb, a, bit(vb, t));
      }
    }
    // 데이터 배치(지그재그)
    var idx = 0, cw = e.codewords;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, upward = ((right + 1) & 2) === 0, yy2 = upward ? size - 1 - vert : vert;
          if (!isFn[yy2][x] && idx < cw.length * 8) { mod[yy2][x] = bit(cw[idx >>> 3], 7 - (idx & 7)); idx++; }
        }
      }
    }
    var MASKS = [
      function (x, y) { return (x + y) % 2 === 0; },
      function (x, y) { return y % 2 === 0; },
      function (x, y) { return x % 3 === 0; },
      function (x, y) { return (x + y) % 3 === 0; },
      function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
      function (x, y) { return x * y % 2 + x * y % 3 === 0; },
      function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; },
      function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }
    ];
    function applyMask(m) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++)
        if (!isFn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x];
    }
    function penalty() {
      var score = 0, x, y, run, i;
      var pat = [true, false, true, true, true, false, true, false, false, false, false];
      function line(get) {
        run = 1;
        for (i = 1; i < size; i++) {
          if (get(i) === get(i - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
        }
        for (i = 0; i + 11 <= size; i++) {
          var f = true, r = true;
          for (var k = 0; k < 11; k++) { if (get(i + k) !== pat[k]) f = false; if (get(i + k) !== pat[10 - k]) r = false; }
          if (f || r) score += 40;
        }
      }
      for (y = 0; y < size; y++) line(function (k) { return mod[y][k]; });
      for (x = 0; x < size; x++) line(function (k) { return mod[k][x]; });
      for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++)
        if (mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) score += 3;
      var dark = 0; mod.forEach(function (r) { r.forEach(function (v) { if (v) dark++; }); });
      score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      return score;
    }
    var best = 0, bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      var sc = penalty();
      if (sc < bestScore) { bestScore = sc; best = m; }
      applyMask(m);
    }
    applyMask(best); drawFormat(best);
    return mod;
  }

  function makeQrSvg(text) {
    var m = build(text), n = m.length, q = 4, d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++)
      if (m[y][x]) d += 'M' + (x + q) + ',' + (y + q) + 'h1v1h-1z';
    var s = n + q * 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s + ' ' + s + '" shape-rendering="crispEdges" role="img" aria-label="투표 QR 코드">' +
      '<rect width="' + s + '" height="' + s + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  root.makeQrSvg = makeQrSvg;
  root.__qrBuild = build;
})(typeof window !== 'undefined' ? window : globalThis);
