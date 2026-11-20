// 엑셀(.xlsx) 읽기: zip을 직접 풀고 XML에서 필요한 값만 꺼낸다(외부 라이브러리 없음).
const BAD = '엑셀(.xlsx) 파일을 읽지 못했습니다. 형식을 확인하세요.';
const MAX_UNZIPPED = 30 * 1024 * 1024;
const utf8 = (u8) => new TextDecoder('utf-8').decode(u8);

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const needed = (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels'
  || (n.startsWith('xl/worksheets/') && n.endsWith('.xml'));

async function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(BAD);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true), declared = 0;
  const files = {};
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error(BAD);
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = utf8(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    declared += usize;
    if (declared > MAX_UNZIPPED) throw new Error('파일이 너무 큽니다.');
    if (name.endsWith('/') || !needed(name)) continue;
    if (lho + 30 > buf.length || dv.getUint32(lho, true) !== 0x04034b50) throw new Error(BAD);
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const data = buf.subarray(start, start + csize);
    let out;
    if (method === 0) out = data;
    else if (method === 8) out = await inflate(data);
    else throw new Error(BAD);
    if (out.length > MAX_UNZIPPED) throw new Error('파일이 너무 큽니다.');
    files[name] = out;
  }
  return files;
}

const decodeEntities = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
  if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>';
  if (e === 'quot') return '"'; if (e === 'apos') return "'";
  const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  try { return String.fromCodePoint(code); } catch { return ''; }
});
const attr = (tag, name) => { const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(tag); return m ? decodeEntities(m[1]) : null; };
const allText = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1])).join('');
const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref) { if (/[A-Za-z]/.test(ch)) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64); else break; }
  return n - 1;
};

/** 첫 시트를 행 배열로 돌려준다. 숫자는 number, 나머지는 문자열. */
export async function readXlsx(u8, maxRows) {
  let files;
  try { files = await unzip(u8); } catch (e) { throw e.message === '파일이 너무 큽니다.' ? e : new Error(BAD); }
  try {
    const shared = [];
    if (files['xl/sharedStrings.xml']) {
      for (const m of utf8(files['xl/sharedStrings.xml']).matchAll(/<si(?:\s[^>]*)?\/>|<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
        shared.push(m[1] === undefined ? '' : allText(m[1]));
      }
    }
    let sheetPath = null;
    try {
      const wb = utf8(files['xl/workbook.xml']), rels = utf8(files['xl/_rels/workbook.xml.rels']);
      const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)[1];
      for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        if (attr(m[0], 'Id') === rid) {
          const t = attr(m[0], 'Target') || '';
          sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t;
        }
      }
    } catch { sheetPath = null; }
    if (!sheetPath || !files[sheetPath]) {
      const cands = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort();
      if (!cands.length) throw new Error('엑셀 파일에서 시트를 찾지 못했습니다.');
      sheetPath = cands[0];
    }
    const rows = [];
    for (const rm of utf8(files[sheetPath]).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rAttr = attr(rm[1], 'r');
      const rIdx = rAttr ? parseInt(rAttr, 10) : rows.length + 1;
      if (rIdx > maxRows + 5) throw new Error(`행이 너무 많습니다. ${maxRows}행 이하로 올려 주세요.`);
      const cells = new Map();
      let maxCol = -1;
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const t = attr(cm[1], 't'), inner = cm[2] || '';
        const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        const text = vm ? decodeEntities(vm[1]) : null;
        let val;
        if (t === 's') val = text ? shared[parseInt(text, 10)] ?? '' : '';
        else if (t === 'inlineStr') val = allText(inner);
        else if (t === 'str' || t === 'e') val = text || '';
        else if (t === 'b') val = text === '1' ? '1' : '';
        else if (text === null || text === '') val = '';
        else { val = Number(text); if (Number.isNaN(val)) val = text; }
        const idx = colIndex(attr(cm[1], 'r') || 'A1');
        cells.set(idx, val);
        if (idx > maxCol) maxCol = idx;
      }
      while (rows.length < rIdx - 1) rows.push([]);
      const line = [];
      for (let i = 0; i <= maxCol; i++) line.push(cells.has(i) ? cells.get(i) : '');
      rows.push(line);
    }
    return rows;
  } catch (e) {
    if (e.message && e.message !== 'undefined' && /^(행이|엑셀 파일에서)/.test(e.message)) throw e;
    throw new Error(BAD);
  }
}
