(function () {
  'use strict';
  var app = document.getElementById('app');
  var RULE = { half: '과반', twothirds: '3분의 2 이상' };
  var STAT = { none: ['미접수', ''], issued: ['QR 발급', 'warn'], used: ['투표 완료', 'ok'], offline: ['오프라인 투표', 'acc'] };
  var ACTION = {
    'election.create': '선거 생성', 'election.delete': '선거 삭제', 'election.update': '선거 정보 수정', 'election.start': '투표 시작', 'election.close': '투표 종료',
    'people.import': '교적부 불러오기', 'people.member_ok': '무흠 입교 체크', 'roll.lock': '선거인명부 확정', 'roll.unlock': '선거인명부 확정 취소',
    'race.create': '투표 항목 추가', 'race.rule': '가결 기준 변경', 'race.delete': '투표 항목 삭제',
    'candidate.add': '후보 추가', 'candidate.delete': '후보 삭제', 'photo.upload': '후보 사진 등록', 'photo.delete': '후보 사진 삭제',
    'ticket.issue': 'QR 발급', 'ticket.reissue': 'QR 재발급',
    'offline.checkin': '오프라인 투표 확인', 'offline.cancel': '오프라인 확인 취소', 'offline.results': '오프라인 투표 결과 입력'
  };
  var S = {
    admin: null, elections: [], eid: null, prog: null, tab: 'roster', people: [], races: [], desk: [],
    results: null, audit: [], q: { roster: '', voters: '', desk: '' }, msg: '', err: '', issued: null,
    confirmClose: false, showNew: false, showPw: false, showDel: false, imported: null, pv: {}, offline: null, offForm: null, offDirty: false
  };

  /* ---------- 도우미 ---------- */
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
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden') { if (v) el.setAttribute(k, ''); }
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function api(method, path, body, raw) {
    var opt = { method: method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
    if (raw) { opt.body = raw.body; opt.headers['Content-Type'] = raw.type || 'application/octet-stream'; }
    else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    return fetch('/api/admin' + path, opt).then(function (r) {
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
  function isChair() { return S.admin && S.admin.role === 'chair'; }
  function base() { return '/elections/' + S.eid; }
  function act(fn) {
    S.msg = ''; S.err = '';
    return Promise.resolve().then(fn).catch(function (e) { S.err = e.message; }).then(refresh);
  }
  function ruleLabel(r) { return RULE[r] || r; }
  function pill(text, kind) { return h('span', { class: 'pill' + (kind ? ' ' + kind : '') }, text); }
  function photo(c, size) {
    var cls = 'ph' + (size ? ' ' + size : '');
    if (c.photo_url) return h('span', { class: cls }, h('img', { src: c.photo_url + '?v=' + (S.pv[c.person_id] || 0), alt: c.name + ' 사진' }));
    return h('span', { class: cls, 'aria-hidden': 'true' }, c.name.charAt(0));
  }
  function stat(n, label) { return h('div', { class: 'stat' }, h('b', null, String(n)), h('span', null, label)); }
  function notice() {
    return [S.err ? h('div', { class: 'msg err', role: 'alert' }, S.err) : null, S.msg ? h('div', { class: 'msg good' }, S.msg) : null];
  }
  function searchBox(key, onChange) {
    var input = h('input', { type: 'text', class: 'grow', placeholder: '이름 또는 직분 검색', 'aria-label': '검색', value: S.q[key] });
    input.addEventListener('input', function () { S.q[key] = input.value; onChange(); });
    return input;
  }
  function matches(key, p) {
    var q = S.q[key].trim();
    return !q || (p.name + p.role).indexOf(q) >= 0;
  }
  function fillRows(tbody, rows, cols, empty) {
    tbody.replaceChildren();
    if (!rows.length) { tbody.appendChild(h('tr', null, h('td', { colspan: cols, class: 'note' }, empty))); return; }
    rows.forEach(function (r) { tbody.appendChild(r); });
  }

  /* ---------- 데이터 불러오기 ---------- */
  function tabs() {
    var all = [['roster', '교적부'], ['voters', '선거인명부'], ['cands', '후보·기준'], ['desk', '접수'], ['tally', '진행·개표']];
    return isChair() ? all : all.filter(function (t) { return t[0] === 'desk' || t[0] === 'tally'; });
  }
  function refresh() {
    if (!S.admin) return Promise.resolve();
    return api('GET', '/elections').then(function (list) {
      S.elections = list;
      if (!S.eid || !list.some(function (e) { return e.id === S.eid; })) S.eid = list.length ? list[0].id : null;
      if (!tabs().some(function (t) { return t[0] === S.tab; })) S.tab = tabs()[0][0];
      if (!S.eid) { S.prog = null; return null; }
      var jobs = [api('GET', base() + '/progress').then(function (d) { S.prog = d; })];
      if (isChair() && ['roster', 'voters', 'cands'].indexOf(S.tab) >= 0) jobs.push(api('GET', base() + '/people').then(function (d) { S.people = d; }));
      if (isChair() && S.tab === 'cands') jobs.push(api('GET', base() + '/races').then(function (d) { S.races = d; }));
      if (S.tab === 'desk') jobs.push(api('GET', base() + '/desk').then(function (d) { S.desk = d; }));
      return Promise.all(jobs).then(function () {
        if (S.tab === 'tally' && isChair()) {
          var more = [api('GET', base() + '/audit').then(function (d) { S.audit = d; })];
          S.results = null; S.offline = null;
          if (S.prog.phase === 'closed') {
            more.push(api('GET', base() + '/results').then(function (d) { S.results = d; }));
            more.push(api('GET', base() + '/offline-results').then(function (d) { S.offline = d; if (!S.offDirty) S.offForm = null; }));
          }
          return Promise.all(more);
        }
      });
    }).catch(function (e) { if (e.status !== 401) S.err = e.message; }).then(render);
  }

  /* ---------- 로그인 ---------- */
  function renderLogin(message) {
    var u = h('input', { type: 'text', id: 'u', autocomplete: 'username' });
    var p = h('input', { type: 'password', id: 'p', autocomplete: 'current-password' });
    var go = function () {
      api('POST', '/login', { username: u.value, password: p.value }).then(function () { return api('GET', '/me'); })
        .then(function (me) { S.admin = me; S.tab = me.role === 'chair' ? 'roster' : 'desk'; return refresh(); })
        .catch(function (e) { renderLogin(e.message); });
    };
    p.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    app.replaceChildren(h('div', { class: 'card login' }, h('h1', null, '교회 선출투표 관리'),
      h('label', { class: 'f', for: 'u' }, '아이디', u), h('label', { class: 'f', for: 'p' }, '비밀번호', p),
      message ? h('div', { class: 'msg err', role: 'alert' }, message) : null,
      h('button', { class: 'btn primary', onclick: go }, '로그인')));
  }

  /* ---------- 비밀번호 변경 ---------- */
  function passwordCard() {
    var cur = h('input', { type: 'password', id: 'pw0', autocomplete: 'current-password' });
    var nw = h('input', { type: 'password', id: 'pw1', autocomplete: 'new-password' });
    var nw2 = h('input', { type: 'password', id: 'pw2', autocomplete: 'new-password' });
    var out = h('div', { role: 'status' });
    var show = function (text, kind) { out.replaceChildren(h('div', { class: 'msg ' + kind }, text)); };
    var go = function () {
      if (nw.value.length < 12) return show('새 비밀번호는 12자 이상이어야 합니다.', 'err');
      if (nw.value !== nw2.value) return show('새 비밀번호 확인이 서로 다릅니다.', 'err');
      api('POST', '/password', { current: cur.value, next: nw.value }).then(function () {
        cur.value = nw.value = nw2.value = '';
        show('비밀번호를 바꿨습니다. 다른 곳에서 로그인한 기기는 로그아웃됩니다.', 'good');
      }).catch(function (e) { show(e.message, 'err'); });
    };
    return h('section', { class: 'card' }, h('h2', null, '비밀번호 변경'),
      h('label', { class: 'f', for: 'pw0' }, '현재 비밀번호', cur),
      h('label', { class: 'f', for: 'pw1' }, '새 비밀번호 (12자 이상)', nw),
      h('label', { class: 'f', for: 'pw2' }, '새 비밀번호 확인', nw2), out,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: go }, '변경'),
        h('button', { class: 'btn', onclick: function () { S.showPw = false; render(); } }, '닫기')));
  }

  /* ---------- 선거 삭제 ---------- */
  function deleteCard() {
    var el = S.elections.find(function (e) { return e.id === S.eid; });
    if (!el) return null;
    var input = h('input', { type: 'text', id: 'delTitle', autocomplete: 'off', 'aria-label': '삭제할 선거 이름 입력' });
    var out = h('div', { role: 'status' });
    var go = function () {
      if (input.value.trim() !== el.title.trim()) { out.replaceChildren(h('div', { class: 'msg err' }, '선거 이름이 일치하지 않습니다.')); return; }
      api('DELETE', '/elections/' + el.id, { confirm_title: input.value }).then(function () {
        S.showDel = false; S.eid = null; S.prog = null; S.msg = '선거 "' + el.title + '"와 모든 자료를 삭제했습니다.'; S.err = '';
        return refresh();
      }).catch(function (e) { out.replaceChildren(h('div', { class: 'msg err' }, e.message)); });
    };
    return h('section', { class: 'card' }, h('h2', null, '선거 삭제'),
      h('p', { class: 'lead' }, '"' + el.title + '"의 교적부, 선거인명부, QR, 투표함, 후보 사진, 오프라인 결과, 작업 기록이 모두 지워지고 되돌릴 수 없습니다. 결과 보고서를 먼저 저장하세요. 삭제하려면 선거 이름을 아래에 똑같이 입력하세요.'),
      h('label', { class: 'f', for: 'delTitle' }, '선거 이름', input), out,
      h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: go }, '완전히 삭제'),
        h('button', { class: 'btn', onclick: function () { S.showDel = false; render(); } }, '취소')));
  }

  /* ---------- 공통 화면 ---------- */
  function header() {
    var el = S.elections.find(function (e) { return e.id === S.eid; });
    var sel = h('select', { 'aria-label': '선거 선택' }, S.elections.map(function (e) {
      var o = h('option', { value: e.id }, e.title); if (e.id === S.eid) o.selected = true; return o;
    }));
    sel.addEventListener('change', function () { S.eid = +sel.value; S.issued = null; S.imported = null; S.confirmClose = false; refresh(); });
    var left = h('div', null, h('h1', null, el ? el.title : '교회 선출투표'),
      h('div', { class: 'row', style: 'margin-top:6px' }, S.elections.length > 1 ? sel : null,
        isChair() ? h('button', { class: 'btn sm', onclick: function () { S.showNew = !S.showNew; render(); } }, '새 선거') : null,
        isChair() && el && S.prog && S.prog.phase !== 'open' ? h('button', { class: 'btn sm danger', onclick: function () { S.showDel = !S.showDel; render(); } }, '선거 삭제') : null));
    var right = h('div', { class: 'row' }, phaseControls(), h('span', { class: 'note' }, S.admin.username + ' (' + (isChair() ? '선거관리위원장' : '접수 담당') + ')'),
      h('button', { class: 'btn sm', onclick: function () { S.showPw = !S.showPw; render(); } }, '비밀번호 변경'),
      h('button', { class: 'btn sm', onclick: function () { api('POST', '/logout').catch(function () {}).then(function () { S.admin = null; renderLogin(); }); } }, '로그아웃'));
    return h('header', { class: 'top noprint' }, left, right);
  }
  function phaseControls() {
    var d = S.prog, box = h('div', { class: 'row' });
    if (!d) return box;
    if (d.phase === 'setup') {
      box.appendChild(pill('준비 중', 'warn'));
      if (isChair()) box.appendChild(h('button', { class: 'btn primary', onclick: function () { act(function () { return api('POST', base() + '/start').then(function () { S.tab = 'desk'; S.msg = '투표를 시작했습니다.'; }); }); } }, '투표 시작'));
    } else if (d.phase === 'open') {
      box.appendChild(pill('투표 진행 중', 'ok'));
      box.appendChild(h('span', { class: 'note' }, '참여 ' + (d.voted + d.offline) + ' / ' + d.voters + '명'));
      if (isChair()) {
        if (S.confirmClose) {
          box.appendChild(h('span', { class: 'note' }, '종료하면 되돌릴 수 없고 미사용 QR은 모두 무효가 됩니다.'));
          box.appendChild(h('button', { class: 'btn danger', onclick: function () { S.confirmClose = false; act(function () { return api('POST', base() + '/close').then(function (r) { S.tab = 'tally'; S.msg = '투표를 종료했습니다. 투표함 ' + r.ballots + '표.'; }); }); } }, '종료 확정'));
          box.appendChild(h('button', { class: 'btn', onclick: function () { S.confirmClose = false; render(); } }, '취소'));
        } else box.appendChild(h('button', { class: 'btn', onclick: function () { S.confirmClose = true; render(); } }, '투표 종료'));
      }
    } else box.appendChild(pill('투표 종료', 'acc'));
    return box;
  }
  function newElectionCard() {
    var title = h('input', { type: 'text', id: 'nt', placeholder: '예: 2026년 직분자 선출', 'aria-label': '선거 이름' });
    var date = h('input', { type: 'date', id: 'nd', 'aria-label': '선거일' });
    return h('section', { class: 'card noprint' }, h('h3', null, '새 선거 만들기'),
      h('div', { class: 'row' }, h('label', { class: 'f grow' }, '선거 이름', title), h('label', { class: 'f' }, '선거일(만 나이 기준일)', date),
        h('button', { class: 'btn primary', style: 'align-self:flex-end', onclick: function () {
          act(function () { return api('POST', '/elections', { title: title.value, base_date: date.value }).then(function (r) { S.eid = r.id; S.showNew = false; S.tab = 'roster'; S.imported = null; S.msg = '선거를 만들었습니다. 교적부를 올려 주세요.'; }); });
        } }, '만들기')));
  }

  /* ---------- 1. 교적부 ---------- */
  function tabRoster() {
    var d = S.prog, locked = d.phase !== 'setup' || d.roster_locked;
    var file = h('input', { type: 'file', id: 'xl', accept: '.xlsx,.csv', hidden: true, disabled: locked });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; if (!f) return;
      act(function () {
        return f.arrayBuffer().then(function (buf) { return api('POST', base() + '/people/import?name=' + encodeURIComponent(f.name), undefined, { body: buf }); })
          .then(function (r) { S.imported = r; S.msg = r.imported + '명을 불러왔습니다.' + (r.excluded.length ? ' ' + r.excluded.length + '행은 오류로 제외했습니다.' : ''); });
      });
    });
    var tb = h('tbody');
    function fill() {
      fillRows(tb, S.people.filter(function (p) { return matches('roster', p); }).map(function (p) {
        return h('tr', null, h('td', null, p.role), h('td', null, p.name), h('td', null, p.birth), h('td', null, p.reg_date), h('td', { class: 'num' }, p.age));
      }), 5, '표시할 교인이 없습니다.');
    }
    fill();
    var out = [h('section', { class: 'card' }, h('h2', null, '교적부 불러오기'),
      h('p', { class: 'lead' }, '직분, 이름, 생년월일, 등록일이 들어 있는 엑셀(.xlsx) 또는 CSV 파일을 올리세요. 첫 행은 제목 행으로 읽고, 형식이 틀린 행과 중복 행은 제외합니다. 열 제목에 "무흠" 또는 "입교"가 들어간 열이 있으면 무흠 입교 여부로 함께 읽습니다.'),
      h('div', { class: 'row' }, h('label', { class: 'btn primary', for: 'xl', style: locked ? 'opacity:.45;pointer-events:none' : '' }, '파일 선택'), file,
        h('a', { href: '/static/sample.csv', download: 'sample.csv', class: 'btn' }, '예시 파일 받기')),
      locked ? h('p', { class: 'note' }, '명부가 확정되었거나 투표가 시작되어 다시 올릴 수 없습니다.') : h('p', { class: 'note' }, '다시 올리면 기존 교적부, 후보, 사진이 모두 새로 시작됩니다.'),
      notice())];
    out.push(h('section', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, '불러온 교적부 ', pill(S.people.length + '명')), searchBox('roster', fill)),
      h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, ['직분', '이름', '생년월일', '등록일'].map(function (t) { return h('th', null, t); }), h('th', { class: 'num' }, '만 나이'))), tb)),
      S.imported && S.imported.excluded.length ? h('details', { open: true }, h('summary', null, '제외된 행 ' + S.imported.excluded.length + '개'),
        h('div', { class: 'log' }, S.imported.excluded.map(function (x) { return h('span', null, x.row + '행 ' + x.name + ': ' + x.reason); }))) : null));
    return out;
  }

  /* ---------- 2. 선거인명부 ---------- */
  function tabVoters() {
    var d = S.prog, locked = d.phase !== 'setup' || d.roster_locked, setupOnly = d.phase !== 'setup';
    var adult = S.people.filter(function (p) { return p.age >= 18; }).length;
    var mug = S.people.filter(function (p) { return p.member_ok; }).length;
    var elig = S.people.filter(function (p) { return !p.ineligible_reason; }).length;
    var base_ = h('input', { type: 'date', id: 'bd', value: d.base_date, disabled: locked });
    base_.addEventListener('change', function () { if (base_.value) act(function () { return api('PATCH', base() + '', { base_date: base_.value }); }); });
    var tb = h('tbody');
    function fill() {
      fillRows(tb, S.people.filter(function (p) { return matches('voters', p); }).map(function (p) {
        var cb = h('input', { type: 'checkbox', 'aria-label': p.name + ' 무흠 입교인', checked: p.member_ok, disabled: locked });
        cb.addEventListener('change', function () { act(function () { return api('POST', base() + '/people/member-ok', { person_ids: [p.id], value: cb.checked }); }); });
        var status = d.roster_locked ? (p.in_roll ? pill('선거인', 'ok') : pill(p.ineligible_reason || '명부 확정 전 제외', 'no'))
          : (p.ineligible_reason ? pill(p.ineligible_reason, 'no') : pill('선거인', 'ok'));
        return h('tr', null, h('td', null, p.role), h('td', null, p.name), h('td', null, p.birth), h('td', { class: 'num' }, p.age), h('td', null, cb), h('td', null, status));
      }), 6, '표시할 교인이 없습니다.');
    }
    fill();
    function bulk(v) { return h('button', { class: 'btn sm', disabled: locked, onclick: function () { act(function () { return api('POST', base() + '/people/member-ok', { person_ids: null, value: v }); }); } }, v ? '전체 무흠 체크' : '전체 해제'); }
    return [h('section', { class: 'card' }, h('h2', null, '선거인명부'),
      h('p', { class: 'lead' }, '선거일 기준 만 18세 이상이면서 무흠 입교인으로 체크된 교인이 선거인입니다. 확정하면 명부와 후보를 바꿀 수 없습니다.'),
      h('div', { class: 'row' }, h('label', { class: 'f' }, '선거일(만 나이 기준일)', base_)),
      h('div', { class: 'stats' }, stat(S.people.length, '교적부 전체'), stat(adult, '만 18세 이상'), stat(mug, '무흠 입교 체크'), stat(d.roster_locked ? d.voters : elig, '선거인')),
      h('div', { class: 'row' }, d.roster_locked ? pill('명부 확정됨', 'ok') : null,
        d.roster_locked ? (setupOnly ? null : null) : null,
        d.roster_locked && !setupOnly ? h('button', { class: 'btn', onclick: function () { act(function () { return api('POST', base() + '/roll/unlock').then(function () { S.msg = '확정을 취소했습니다.'; }); }); } }, '확정 취소') : null,
        !d.roster_locked && !setupOnly ? h('button', { class: 'btn primary', disabled: !S.people.length, onclick: function () { act(function () { return api('POST', base() + '/roll/lock').then(function (r) { S.msg = '선거인 ' + r.voters + '명으로 확정했습니다.'; }); }); } }, '선거인명부 확정') : null,
        !locked ? [bulk(true), bulk(false)] : null),
      notice()),
      h('section', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, '전체 명단'), searchBox('voters', fill)),
        h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, ['직분', '이름', '생년월일'].map(function (t) { return h('th', null, t); }), h('th', { class: 'num' }, '만 나이'), h('th', null, '무흠 입교'), h('th', null, '자격'))), tb)))];
  }

  /* ---------- 3. 후보와 기준 ---------- */
  function resizePhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) return reject(new Error('이미지 파일을 선택하세요.'));
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('사진을 읽지 못했습니다.')); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('사진 형식을 읽지 못했습니다. JPG나 PNG 파일을 사용하세요.')); };
        img.onload = function () {
          var W = 360, H = 480, c = document.createElement('canvas'); c.width = W; c.height = H;
          var x = c.getContext('2d'), sc = Math.max(W / img.width, H / img.height), w = img.width * sc, hh = img.height * sc;
          x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
          x.drawImage(img, (W - w) / 2, (H - hh) * 0.2, w, hh);   // 얼굴이 위쪽에 있는 경우가 많아 위쪽에 맞춰 자른다
          c.toBlob(function (b) { b ? resolve(b) : reject(new Error('사진을 변환하지 못했습니다.')); }, 'image/jpeg', 0.82);
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  function tabCands() {
    var lock = S.prog.phase !== 'setup';
    var name = h('input', { type: 'text', id: 'rn', placeholder: '예: 장로 장립 투표', 'aria-label': '투표 항목 이름' });
    var rule = h('select', { id: 'rr', 'aria-label': '가결 기준' }, h('option', { value: 'half' }, '과반'), h('option', { value: 'twothirds' }, '3분의 2 이상'));
    var out = [h('section', { class: 'card' }, h('h2', null, '후보와 가결 기준'),
      h('p', { class: 'lead' }, '투표 항목(예: 장로 장립)마다 가결 기준을 정하고 후보를 등록합니다. 후보 사진은 투표 화면에 이름과 함께 표시됩니다. 유권자는 모든 후보에 가 또는 부를 선택해야 제출할 수 있습니다.'),
      lock ? h('p', { class: 'note' }, '투표가 시작되어 수정할 수 없습니다.') :
        h('div', { class: 'row' }, h('label', { class: 'f grow' }, '투표 항목 이름', name), h('label', { class: 'f' }, '가결 기준', rule),
          h('button', { class: 'btn primary', style: 'align-self:flex-end', onclick: function () { act(function () { return api('POST', base() + '/races', { name: name.value, rule: rule.value }); }); } }, '항목 추가')),
      notice())];
    S.races.forEach(function (r) {
      var used = {}; r.candidates.forEach(function (c) { used[c.person_id] = 1; });
      var avail = S.people.filter(function (p) { return !used[p.id]; });
      var sel = h('select', { class: 'grow', 'aria-label': r.name + ' 후보 선택', disabled: !avail.length }, avail.length ? avail.map(function (p) { return h('option', { value: p.id }, p.name + ' (' + p.role + ')'); }) : h('option', null, '추가할 교인이 없습니다'));
      var rsel = h('select', { 'aria-label': r.name + ' 가결 기준', disabled: lock }, h('option', { value: 'half' }, '과반'), h('option', { value: 'twothirds' }, '3분의 2 이상'));
      rsel.value = r.rule;
      rsel.addEventListener('change', function () { act(function () { return api('PATCH', base() + '/races/' + r.id, { rule: rsel.value }); }); });
      var card = h('section', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, r.name),
        h('label', { class: 'row note' }, '가결 기준', rsel),
        lock ? null : h('button', { class: 'btn sm danger', onclick: function () { act(function () { return api('DELETE', base() + '/races/' + r.id); }); } }, '항목 삭제')),
        h('ul', { class: 'cl' }, r.candidates.length ? r.candidates.map(function (c) {
          var fi = h('input', { type: 'file', id: 'ph-' + c.id, accept: 'image/*', hidden: true });
          fi.addEventListener('change', function () {
            var f = fi.files && fi.files[0]; if (!f) return;
            act(function () {
              return resizePhoto(f).then(function (blob) { return api('PUT', base() + '/people/' + c.person_id + '/photo', undefined, { body: blob, type: 'image/jpeg' }); })
                .then(function () { S.pv[c.person_id] = Date.now(); S.msg = c.name + ' 후보의 사진을 저장했습니다.'; });
            });
          });
          return h('li', null, h('span', { class: 'cand' }, photo(c, ''), h('span', null, h('b', null, c.name), h('br'), h('span', { class: 'note' }, c.role), c.photo_url ? null : [' ', pill('사진 없음', 'warn')])),
            lock ? null : h('span', { class: 'row' }, h('label', { class: 'btn sm', for: 'ph-' + c.id }, c.photo_url ? '사진 변경' : '사진 올리기'), fi,
              c.photo_url ? h('button', { class: 'btn sm', onclick: function () { act(function () { return api('DELETE', base() + '/people/' + c.person_id + '/photo'); }); } }, '사진 삭제') : null,
              h('button', { class: 'btn sm', onclick: function () { act(function () { return api('DELETE', base() + '/candidates/' + c.id); }); } }, '후보 삭제')));
        }) : h('li', { class: 'note' }, '후보가 없습니다.')),
        lock ? null : h('div', { class: 'row' }, sel, h('button', { class: 'btn', disabled: !avail.length, onclick: function () { act(function () { return api('POST', base() + '/races/' + r.id + '/candidates', { person_id: +sel.value }); }); } }, '후보 추가')));
      out.push(card);
    });
    if (!S.races.length) out.push(h('section', { class: 'card' }, h('p', { class: 'note' }, '투표 항목이 아직 없습니다. 위에서 항목을 추가하세요.')));
    return out;
  }

  /* ---------- 4. 접수 ---------- */
  function tabDesk() {
    var d = S.prog;
    if (d.phase === 'setup') return [h('section', { class: 'card' }, h('h2', null, '접수'), h('p', { class: 'lead' }, '선거인명부를 확정하고 후보를 등록한 뒤 투표를 시작하면 접수할 수 있습니다.'))];
    if (d.phase === 'closed') return [h('section', { class: 'card' }, h('h2', null, '접수'), h('p', { class: 'lead' }, '투표가 종료되었습니다. 미사용 QR은 모두 무효 처리되었습니다.'))];
    var out = [h('section', { class: 'card noprint' }, h('h2', null, '현장 접수'),
      h('p', { class: 'lead' }, '신분증과 생년월일로 본인을 확인한 뒤, 스마트폰으로 투표하는 분에게는 QR을 발급하고 종이 투표를 하는 분은 "오프라인 투표"로 표시하세요. QR은 1회용이고 발급 직후에만 화면에 보이며, 분실하면 재발급으로 기존 QR을 무효화합니다. 이미 QR을 받은 분을 오프라인으로 바꾸면 그 QR은 무효가 됩니다. 종이 투표 결과는 투표 종료 후 "진행·개표" 탭에서 입력합니다.'),
      h('div', { class: 'stats' }, stat(d.voters, '선거인'), stat(d.issued, 'QR 발급'), stat(d.voted, '온라인 투표 완료'), stat(d.waiting, '발급 후 미투표'), stat(d.offline, '오프라인 투표 확인')), notice())];
    if (S.issued) {
      var q = h('div', { class: 'qr' });
      try { q.innerHTML = window.makeQrSvg(S.issued.url); } catch (e) { q.textContent = ''; }
      out.push(h('section', { class: 'card', id: 'qrcard' }, h('h3', null, '발급된 QR · ' + S.issued.name + ' ' + S.issued.role),
        h('div', { class: 'qrbox' }, q, h('div', { class: 'row', style: 'flex-direction:column;align-items:flex-start' },
          h('span', { class: 'note' }, 'QR이 스캔되지 않을 때 투표 화면에 입력하는 코드'), h('span', { class: 'tok' }, S.issued.token),
          h('span', { class: 'note' }, '이 QR로 한 번만 투표할 수 있습니다.'),
          h('div', { class: 'row noprint' }, h('button', { class: 'btn primary', onclick: function () { window.print(); } }, 'QR 카드 인쇄'),
            h('button', { class: 'btn', onclick: function () { S.issued = null; render(); } }, '닫기'))))));
    }
    var tb = h('tbody');
    function fill() {
      fillRows(tb, S.desk.filter(function (p) { return matches('desk', p); }).map(function (p) {
        var st = STAT[p.status], actions = null;
        function go(re) {
          act(function () {
            return api('POST', base() + (re ? '/tickets/reissue' : '/tickets'), { person_id: p.person_id }).then(function (r) { S.issued = { name: p.name, role: p.role, token: r.token, url: r.url }; });
          }).then(function () { window.scrollTo(0, 0); });
        }
        var offBtn = h('button', { class: 'btn sm', onclick: function () {
          act(function () { return api('POST', base() + '/offline', { person_id: p.person_id }).then(function () { S.issued = null; S.msg = p.name + ' 님을 오프라인 투표로 확인했습니다.'; }); });
        } }, '오프라인 투표');
        if (p.status === 'none') actions = h('span', { class: 'row' }, h('button', { class: 'btn sm primary', onclick: function () { go(false); } }, 'QR 발급'), offBtn);
        else if (p.status === 'issued') actions = h('span', { class: 'row' }, h('button', { class: 'btn sm danger', onclick: function () { go(true); } }, '재발급'), offBtn);
        else if (p.status === 'offline') actions = h('button', { class: 'btn sm danger', onclick: function () {
          act(function () { return api('DELETE', base() + '/offline/' + p.person_id).then(function () { S.msg = p.name + ' 님의 오프라인 투표 확인을 취소했습니다.'; }); });
        } }, '오프라인 취소');
        else actions = h('span', { class: 'note' }, '—');
        return h('tr', null, h('td', null, p.name), h('td', null, p.role), h('td', null, p.birth), h('td', null, pill(st[0], st[1])), h('td', null, actions));
      }), 5, '해당하는 선거인이 없습니다.');
    }
    fill();
    out.push(h('section', { class: 'card noprint' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, '선거인 접수 현황'), searchBox('desk', fill)),
      h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, ['이름', '직분', '생년월일', '상태', '처리'].map(function (t) { return h('th', null, t); }))), tb))));
    return out;
  }

  /* ---------- 5. 진행과 개표 ---------- */
  function isCount(v) { return v !== '' && v != null && Number.isInteger(Number(v)) && Number(v) >= 0; }

  function offlineCard() {
    var o = S.offline;
    if (!o) return null;
    if (!o.checked_in) {
      return h('section', { class: 'card' }, h('h3', null, '오프라인 투표 결과'), h('p', { class: 'note' }, '오프라인 투표로 확인된 선거인이 없어 입력할 내용이 없습니다.'));
    }
    if (!S.offForm) {
      var counts = {};
      o.races.forEach(function (r) { r.candidates.forEach(function (c) { counts[c.id] = { yes: c.yes == null ? '' : String(c.yes), no: c.no == null ? '' : String(c.no) }; }); });
      S.offForm = { ballots: o.ballots == null ? '' : String(o.ballots), invalid: o.invalid == null ? '0' : String(o.invalid), counts: counts };
      S.offDirty = false;
    }
    var F = S.offForm, checks = [], saveBtn = h('button', { class: 'btn primary' }, '결과 저장'), hint = h('p', { class: 'note', role: 'status' });
    function mark() { S.offDirty = true; validate(); }
    function numInput(label, get, set) {
      var i = h('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', 'aria-label': label, value: get() });
      i.addEventListener('input', function () { set(i.value); mark(); });
      return i;
    }
    function validate() {
      var msg = '', mismatch = false, b = F.ballots, inv = F.invalid;
      if (!isCount(b) || !isCount(inv)) msg = '유효 투표지 수와 무효 투표지 수를 입력하세요.';
      else if (Number(b) + Number(inv) > o.checked_in) msg = '투표지 합계(' + (Number(b) + Number(inv)) + '장)가 오프라인 투표 확인 인원(' + o.checked_in + '명)보다 많습니다.';
      checks.forEach(function (ck) {
        var c = F.counts[ck.id], filled = c.yes !== '' && c.no !== '';
        var ok = isCount(c.yes) && isCount(c.no) && isCount(b) && Number(c.yes) + Number(c.no) === Number(b);
        ck.el.textContent = !filled ? '' : (ok ? '일치' : '가+부 ' + (Number(c.yes) + Number(c.no)) + '표, 유효 투표지 ' + (isCount(b) ? b : '?') + '장과 다릅니다');
        ck.el.className = 'note ' + (!filled ? '' : (ok ? 'okc' : 'errc'));
        if (!ok) mismatch = true;
      });
      if (!msg && mismatch) msg = '모든 후보의 가+부가 유효 투표지 수와 같아야 저장할 수 있습니다.';
      saveBtn.disabled = !!msg;
      hint.textContent = msg || '입력이 모두 맞습니다. 저장하면 전체 통계에 반영됩니다.';
    }
    var racesUi = o.races.map(function (r) {
      var tb = h('tbody');
      r.candidates.forEach(function (c) {
        var chk = h('span', { class: 'note' });
        checks.push({ id: c.id, name: c.name, el: chk });
        tb.appendChild(h('tr', null,
          h('td', null, h('span', { class: 'cand' }, photo({ photo_url: c.photo_url, name: c.name, person_id: c.person_id }, 'sm'), h('span', null, h('b', null, c.name), ' ', h('span', { class: 'note' }, c.role)))),
          h('td', null, numInput(c.name + ' 가', function () { return F.counts[c.id].yes; }, function (v) { F.counts[c.id].yes = v; })),
          h('td', null, numInput(c.name + ' 부', function () { return F.counts[c.id].no; }, function (v) { F.counts[c.id].no = v; })),
          h('td', null, chk)));
      });
      return h('div', null, h('h3', null, r.name), h('div', { class: 'tw' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, '후보'), h('th', null, '가'), h('th', null, '부'), h('th', null, '확인'))), tb)));
    });
    saveBtn.addEventListener('click', function () {
      var body = { ballots: Number(F.ballots), invalid: Number(F.invalid), counts: {} };
      Object.keys(F.counts).forEach(function (id) { body.counts[id] = { yes: Number(F.counts[id].yes), no: Number(F.counts[id].no) }; });
      act(function () { return api('PUT', base() + '/offline-results', body).then(function () { S.offDirty = false; S.offForm = null; S.msg = '오프라인 투표 결과를 저장했고 전체 통계에 반영했습니다.'; }); });
    });
    var ballots = numInput('유효 투표지 수', function () { return F.ballots; }, function (v) { F.ballots = v; });
    var invalid = numInput('무효 투표지 수', function () { return F.invalid; }, function (v) { F.invalid = v; });
    var card = h('section', { class: 'card' }, h('h2', null, '오프라인 투표 결과 입력'),
      h('p', { class: 'lead' }, '종이 투표지를 개표한 합계를 입력하세요. 오프라인 투표로 확인된 선거인은 ' + o.checked_in + '명입니다. 후보마다 가+부는 유효 투표지 수와 같아야 합니다. 저장한 뒤에도 다시 입력해 고칠 수 있고, 입력한 결과는 온라인 결과와 합산됩니다.'),
      h('div', { class: 'row' }, h('label', { class: 'f' }, '유효 투표지 수(장)', ballots), h('label', { class: 'f' }, '무효 투표지 수(장)', invalid),
        o.entered ? pill('입력됨 · ' + o.entered_at.replace('T', ' ').replace('Z', ' UTC'), 'ok') : pill('아직 입력하지 않음', 'warn')),
      racesUi, hint, h('div', { class: 'row' }, saveBtn));
    validate();
    return card;
  }

  function tabTally() {
    var d = S.prog, part = d.voted + d.offline;
    var out = [h('section', { class: 'card' }, h('h2', null, '투표 현황'),
      h('div', { class: 'stats' }, stat(d.voters, '선거인'), stat(d.issued, 'QR 발급'), stat(d.offline, '오프라인 투표 확인'), stat(d.voted, '온라인 투표 완료'),
        stat(d.voters ? Math.round(part / d.voters * 100) + '%' : '0%', '참여율')),
      d.phase !== 'closed' ? h('p', { class: 'note' }, '개표 결과는 투표를 종료한 뒤에만 볼 수 있습니다. 진행 중에는 득표 수가 어디에도 표시되지 않습니다.') : null,
      notice())];
    if (d.phase === 'closed' && S.results) {
      var r = S.results;
      if (r.offline_pending) out.push(h('div', { class: 'msg warn' }, '오프라인 투표자 ' + r.offline_checked_in + '명의 종이 투표 결과가 아직 입력되지 않았습니다. 아래 결과는 온라인 투표만 반영한 잠정 결과입니다.'));
      out[0].appendChild(h('div', { class: 'msg ' + (r.consistent ? 'good' : 'err') }, (r.consistent
        ? '온라인 투표함 ' + r.online_ballots + '표와 온라인 투표 완료 ' + r.used_tickets + '명이 일치합니다.'
        : '온라인 투표함 ' + r.online_ballots + '표와 온라인 투표 완료 ' + r.used_tickets + '명이 다릅니다. 확인이 필요합니다.')
        + ' 합계 ' + r.ballots + '표 = 온라인 ' + r.online_ballots + '표 + 오프라인 ' + r.offline_ballots + '표' + (r.offline_invalid ? ' (오프라인 무효 ' + r.offline_invalid + '장 제외)' : '') + '.'));
      if (isChair()) out.push(offlineCard());
      r.races.forEach(function (race) {
        var mark = race.rule === 'half' ? 50 : 66.67;
        out.push(h('section', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, race.name), pill(ruleLabel(race.rule)), r.offline_pending ? pill('잠정', 'warn') : null),
          h('p', { class: 'note' }, '온라인과 오프라인을 합산한 투표자 ' + race.voters + '명 기준 · 가결에는 가 ' + race.need + '표 이상 필요'),
          h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, h('th', null, '후보'), h('th', { class: 'num' }, '가'), h('th', { class: 'num' }, '부'), h('th', null, '득표율'), h('th', null, '판정'))),
            h('tbody', null, race.candidates.map(function (c) {
              var pct = race.voters ? c.yes / race.voters * 100 : 0;
              var bar = h('div', { class: 'bar', title: '가 ' + pct.toFixed(1) + '%' }, h('i', { style: 'width:' + pct + '%' }), h('u', { style: 'left:' + mark + '%' }));
              return h('tr', null, h('td', null, h('span', { class: 'cand' }, photo({ photo_url: c.photo_url, name: c.name, person_id: c.candidate_id }, 'sm'), h('span', null, h('b', null, c.name), ' ', h('span', { class: 'note' }, c.role)))),
                
                h('td', { class: 'num' }, c.yes), h('td', { class: 'num' }, c.no), h('td', null, bar, h('span', { class: 'note' }, pct.toFixed(1) + '%')), h('td', null, pill(c.passed ? '가결' : '부결', c.passed ? 'ok' : 'no')));
            }))))));
      });
    }
    if (isChair()) {
      out.push(h('section', { class: 'card' }, h('details', null, h('summary', null, '감사 기록 ' + S.audit.length + '건'),
        h('div', { class: 'log' }, S.audit.map(function (a) {
          var det = Object.keys(a.detail || {}).map(function (k) { return k + '=' + a.detail[k]; }).join(', ');
          return h('span', null, a.at.replace('T', ' ').replace('Z', ' UTC') + ' · ' + (a.username || '-') + ' · ' + (ACTION[a.action] || a.action) + (det ? ' (' + det + ')' : ''));
        })))));
    }
    return out.filter(Boolean);
  }

  /* ---------- 전체 그리기 ---------- */
  function render() {
    if (!S.admin) return;
    var y = window.scrollY, nodes = [header()];
    if (S.showPw) nodes.push(passwordCard());
    if (S.showDel && isChair()) { var dc = deleteCard(); if (dc) nodes.push(dc); }
    if (S.showNew && isChair()) nodes.push(newElectionCard());
    if (!S.eid || !S.prog) {
      nodes.push(h('section', { class: 'card' }, h('h2', null, '선거가 없습니다'),
        h('p', { class: 'lead' }, isChair() ? '위의 "새 선거" 버튼으로 선거를 만드세요.' : '선거관리위원장이 선거를 만들 때까지 기다려 주세요.'), notice()));
    } else {
      nodes.push(h('nav', { class: 'steps noprint', 'aria-label': '진행 단계' }, tabs().map(function (t) {
        return h('button', { 'aria-current': String(S.tab === t[0]), onclick: function () { if (S.tab !== t[0]) { S.tab = t[0]; S.msg = ''; S.err = ''; refresh(); } } }, t[1]);
      })));
      var view = { roster: tabRoster, voters: tabVoters, cands: tabCands, desk: tabDesk, tally: tabTally }[S.tab];
      nodes = nodes.concat(view());
    }
    app.replaceChildren.apply(app, nodes);
    window.scrollTo(0, y);
  }

  // 접수·개표 화면은 10초마다 진행 상황을 새로 고친다(입력 중일 때는 건너뛴다).
  setInterval(function () {
    var tag = document.activeElement && document.activeElement.tagName;
    if (S.admin && (S.tab === 'desk' || S.tab === 'tally') && tag !== 'INPUT' && tag !== 'SELECT' && !document.hidden && !S.offDirty && !S.showPw && !S.showDel) { S.msg = ''; refresh(); }
  }, 10000);

  api('GET', '/me').then(function (me) { S.admin = me; S.tab = me.role === 'chair' ? 'roster' : 'desk'; return refresh(); })
    .catch(function () { renderLogin(); });
})();
