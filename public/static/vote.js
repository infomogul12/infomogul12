(function () {
  'use strict';
  var BASE = (function () { var m = document.querySelector('meta[name="cv-base"]'); var b = m ? m.getAttribute('content') : ''; return b && b.charAt(0) === '/' ? b : ''; })();
  var app = document.getElementById('app');
  var RULE = { half: '과반', twothirds: '3분의 2 이상' };
  var state = { token: '', data: null, picks: {} };

  // 교회 로고(왼쪽 위): 등록되어 있을 때만 보인다.
  (function () {
    var box = document.getElementById('brand'); if (!box) return;
    var img = document.createElement('img');
    img.className = 'logo'; img.alt = '교회 로고';
    img.addEventListener('load', function () { box.hidden = false; });
    img.addEventListener('error', function () { box.hidden = true; });
    box.appendChild(img);
    img.src = BASE + '/api/logo';
  })();

  function append(el, c) {
    if (Array.isArray(c)) c.forEach(function (x) { append(el, x); });
    else if (c instanceof Node) el.appendChild(c);
    else if (c != null && c !== false) el.appendChild(document.createTextNode(String(c)));
  }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function show() {
    var nodes = [];
    (function flat(list) {
      for (var i = 0; i < list.length; i++) {
        var x = list[i];
        if (Array.isArray(x)) flat(x);
        else if (x) nodes.push(x);
      }
    })(arguments);
    app.replaceChildren.apply(app, nodes);
    window.scrollTo(0, 0);
  }
  function api(path, body) {
    return fetch(BASE + '/api/vote/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) {
          var e = new Error(typeof d.detail === 'string' ? d.detail : '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.');
          e.status = r.status;
          throw e;
        }
        return d;
      });
    });
  }
  function photo(c, small) {
    var cls = 'ph' + (small ? ' sm' : '');
    if (c.photo_url) return h('span', { class: cls }, h('img', { src: c.photo_url, alt: c.name + ' 사진' }));
    return h('span', { class: cls, 'aria-hidden': 'true' }, c.name.charAt(0));
  }
  function allCandidates() {
    var out = [];
    state.data.races.forEach(function (r) { r.candidates.forEach(function (c) { out.push(c); }); });
    return out;
  }

  function screenScan(message) {
    var input = h('input', { id: 'code', type: 'text', placeholder: '예: abcd-efgh-jkmn-pqrs', autocomplete: 'off', autocapitalize: 'off' });
    var go = function () { if (input.value.trim()) lookup(input.value.trim()); };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    show(
      h('h1', null, '투표를 시작합니다'),
      h('div', { class: 'card' },
        h('p', { class: 'lead' }, '접수처에서 받은 QR을 스마트폰 카메라로 스캔하면 자동으로 열립니다. 열리지 않으면 QR 아래 코드를 입력하세요.'),
        h('label', { for: 'code' }, '투표 코드'),
        input,
        message ? h('div', { class: 'msg', role: 'alert' }, message) : null,
        h('button', { class: 'btn primary', onclick: go }, '확인'))
    );
  }

  function lookup(token) {
    api('lookup', { token: token }).then(function (d) {
      state.token = token;
      state.data = d;
      state.picks = {};
      screenBallot();
    }).catch(function (e) { screenScan(e.message); });
  }

  function screenBallot() {
    var total = allCandidates().length, done = Object.keys(state.picks).length;
    var cards = state.data.races.map(function (r) {
      return h('section', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, r.name), h('span', { class: 'pill' }, '가결 기준 ' + RULE[r.rule])),
        r.candidates.map(function (c) {
          var v = state.picks[c.id];
          function pick(val) { return function () { state.picks[c.id] = val; screenBallot(); }; }
          return h('div', { class: 'cand' },
            h('div', { class: 'who' }, photo(c, false),
              h('div', null, h('div', { class: 'nm' }, c.name), h('div', { class: 'lead' }, c.role))),
            h('div', { class: 'seg' },
              h('button', { class: 'y', 'aria-pressed': String(v === 'Y'), onclick: pick('Y') }, '가'),
              h('button', { class: 'n', 'aria-pressed': String(v === 'N'), onclick: pick('N') }, '부')));
        }));
    });
    var y = window.scrollY;
    show(
      h('h1', null, state.data.voter.name + ' 님, 투표해 주세요'),
      h('p', { class: 'lead' }, state.data.election + ' · 모든 후보에 가 또는 부를 선택해야 다음으로 넘어갑니다.'),
      cards,
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('span', { class: 'grow lead' }, '선택 ' + done + ' / ' + total),
          h('button', { class: 'btn primary', disabled: done !== total, onclick: screenConfirm }, '선택 확인')))
    );
    window.scrollTo(0, y);
  }

  function screenConfirm(msg) {
    var submit = h('button', { class: 'btn primary' }, '최종 제출');
    submit.addEventListener('click', function () {
      submit.disabled = true;
      api('submit', { token: state.token, choices: state.picks }).then(function () {
        state.token = ''; state.data = null; state.picks = {};
        show(h('div', { class: 'card' }, h('h1', null, '투표가 완료되었습니다'),
          h('p', { class: 'lead' }, '참여해 주셔서 감사합니다. 이 QR은 더 이상 사용할 수 없으며, 이 화면을 닫으셔도 됩니다.')));
      }).catch(function (e) {
        if (e.status === 409 || e.status === 404) { state.token = ''; screenScan(e.message); return; }
        submit.disabled = false;
        screenConfirm(e.message);
      });
    });
    show(
      h('h1', null, '선택 내용을 확인하세요'),
      h('p', { class: 'lead' }, '제출하면 수정할 수 없습니다.'),
      state.data.races.map(function (r) {
        return h('section', { class: 'card' }, h('h2', null, r.name),
          h('ul', { class: 'sum' }, r.candidates.map(function (c) {
            var yes = state.picks[c.id] === 'Y';
            return h('li', { class: yes ? 'is-y' : 'is-n' }, h('span', { class: 'who' }, photo(c, true), h('b', null, c.name)),
              h('span', { class: 'pick ' + (yes ? 'y' : 'n'), 'aria-label': c.name + ' ' + (yes ? '가' : '부') }, yes ? '가' : '부'));
          })));
      }),
      h('div', { class: 'card' },
        typeof msg === 'string' ? h('div', { class: 'msg', role: 'alert' }, msg) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: screenBallot }, '수정'),
          submit))
    );
  }

  // QR 주소는 /v#토큰 형태다. 토큰은 읽자마자 주소창에서 지워 어깨너머나 화면 공유로 보이지 않게 한다.
  function consumeHash() {
    var raw = '';
    try { raw = decodeURIComponent(location.hash.slice(1)); } catch (e) { raw = ''; }
    if (!raw) return false;
    history.replaceState(null, '', location.pathname);
    lookup(raw);
    return true;
  }
  // 같은 화면에서 다른 QR을 다시 스캔해도(태블릿 투표 부스) 새 QR로 바로 바뀐다.
  window.addEventListener('hashchange', consumeHash);
  if (!consumeHash()) screenScan();
})();
