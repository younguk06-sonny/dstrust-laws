#!/usr/bin/env node
// 법대로 — 법령 자동 수집 스크립트
// - LAW_OC(법제처 Open API 인증키)가 있으면 법제처 API에서 직접 받습니다(정확·빠름).
// - 없으면 공개 법령 MCP 서버(mcp.gomdori.app/law, 공용 한도)로 받습니다.
// - 시행 중인 버전(MST)이 바뀐 법령만 다시 받고, 바뀐 내역은 data/changes.json에 남깁니다.
// - 끝나면 회사 PC용 단일 파일 offline.html을 만듭니다.
// 외부 패키지 없이 Node 20+ 에서 돌아갑니다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const LAWDIR = path.join(DATA, 'laws');
const OC = (process.env.LAW_OC || '').trim();
const MCP_URL = process.env.LAW_MCP_URL || 'https://mcp.gomdori.app/law';
const ONLY_BUILD = process.argv.includes('--build-only');
const FORCE = process.argv.includes('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST
const log = (...a) => console.log('[법대로]', ...a);

async function readJSON(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}
async function writeJSON(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj));
}

async function fetchRetry(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw last;
}

/* ───────────────────────── 1) 법제처 Open API (키 있을 때) ───────────────────────── */

const DRF = 'https://www.law.go.kr/DRF';
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

function textOf(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(textOf).filter(Boolean).join('\n');
  if (typeof x === 'object') return Object.values(x).map(textOf).filter(Boolean).join('\n');
  return String(x);
}

async function drfSearch(name) {
  const u = `${DRF}/lawSearch.do?OC=${encodeURIComponent(OC)}&target=law&type=JSON&display=100&query=${encodeURIComponent(name)}`;
  const j = await (await fetchRetry(u)).json();
  const list = arr(j?.LawSearch?.law);
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const hit = list.find((l) => norm(l['법령명한글']) === norm(name) && (l['현행연혁코드'] || '현행') === '현행')
    || list.find((l) => norm(l['법령명한글']) === norm(name));
  if (!hit) return null;
  return {
    name: hit['법령명한글'], mst: String(hit['법령일련번호']), lawId: String(hit['법령ID'] || ''),
    promulgated: String(hit['공포일자'] || ''), effective: String(hit['시행일자'] || ''),
    kind: hit['법령구분명'] || '', dept: hit['소관부처명'] || '',
  };
}

async function drfLaw(meta) {
  const u = `${DRF}/lawService.do?OC=${encodeURIComponent(OC)}&target=law&type=JSON&MST=${meta.mst}`;
  const j = await (await fetchRetry(u)).json();
  const L = j?.['법령'];
  if (!L) throw new Error('법령 본문 응답 형식이 예상과 다름');
  const items = [];
  for (const u of arr(L?.['조문']?.['조문단위'])) {
    const kind = u['조문여부'];
    if (kind === '전문') { // 장·절 제목
      const x = textOf(u['조문내용']).trim();
      if (x) items.push({ t: 'h', x });
      continue;
    }
    const no = String(u['조문번호'] || '').trim();
    const br = String(u['조문가지번호'] || '').trim();
    const label = `제${no}조${br && br !== '0' ? '의' + br : ''}`;
    const lines = [textOf(u['조문내용']).trim()];
    for (const h of arr(u['항'])) {
      lines.push(textOf(h['항내용']).trim());
      for (const ho of arr(h['호'])) {
        lines.push(textOf(ho['호내용']).trim());
        for (const mok of arr(ho['목'])) lines.push(textOf(mok['목내용']).trim());
      }
    }
    items.push({ t: 'a', n: label, title: String(u['조문제목'] || '').trim(), x: lines.filter(Boolean).join('\n') });
  }
  const b = L['기본정보'] || {};
  return {
    ...meta,
    dept: meta.dept || textOf(b['소관부처']).split('\n')[0] || '',
    items,
  };
}

/* ───────────────────────── 2) 공개 법령 MCP 서버 (키 없을 때) ───────────────────────── */

let mcpSession = null;
let rpcId = 0;
async function mcpPost(body) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (mcpSession) headers['mcp-session-id'] = mcpSession;
  const res = await fetchRetry(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) mcpSession = sid;
  const raw = await res.text();
  if (!body.id) return null; // 알림
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${raw.slice(0, 200)}`);
  let msg;
  if ((res.headers.get('content-type') || '').includes('event-stream')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { const m = JSON.parse(line.slice(5).trim()); if (m.id === body.id) msg = m; } catch {}
    }
  } else msg = JSON.parse(raw);
  if (!msg) throw new Error('MCP 응답을 읽지 못함');
  if (msg.error) throw new Error('MCP 오류: ' + JSON.stringify(msg.error).slice(0, 200));
  return msg.result;
}
async function mcpInit() {
  if (mcpSession !== null) return;
  mcpSession = '';
  await mcpPost({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'beopdaero-collector', version: '1.0' } } });
  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
async function mcpTool(name, args) {
  await mcpInit();
  const r = await mcpPost({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  const t = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r?.isError) throw new Error(t.slice(0, 300));
  return t;
}

async function mcpSearch(name) {
  const t = await mcpTool('search_law', { query: name, display: 20 });
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const re = /^\s*\d+\.\s+(.+?)\s+\[(현행|[^\]]*)\]\s*$/;
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m || norm(m[1]) !== norm(name)) continue;
    const block = lines.slice(i + 1, i + 8).join('\n');
    const g = (k) => (block.match(new RegExp(k + ':\\s*([^\\s/]+)')) || [])[1] || '';
    return { name: m[1], mst: g('MST'), lawId: g('법령ID'), promulgated: g('공포일'), effective: g('시행일'), kind: g('구분'), dept: '' };
  }
  return null;
}

// 공개 서버의 본문 형식:
//   제1조 목적                ← 조문 머리(제목) 줄
//   이 영은 …                 ← 항이 없는 조문은 바로 본문
//   제3조 서류의 보존기간 등
//   제3조(서류의 보존기간 등)  ← 항이 있는 조문은 괄호 머리 줄이 한 번 더 나옴
//   ① …
const ART_PAREN = /^(제\d+조(?:의\d+)?)\s*\(([^)]*)\)\s*(.*)$/;
const ART_PLAIN = /^(제\d+조(?:의\d+)?)\s+(.+)$/;
const HEAD_RE = /^제\d+(?:편|장|절|관)(?:의\d+)?\s/;
const STOP_RE = /^(💡|ℹ️|⚠️|🔜|\[Instructions|부칙\s*\d+건|─{3,}|특정 조문 조회:|여러 조문 일괄 조회:)/;
function parseLawText(text) {
  const items = [];
  let cur = null;
  let started = false;
  let stopped = false;
  const newArt = (n, title) => { cur = { t: 'a', n, title: title.trim(), x: `${n}(${title.trim()})`, body: 0 }; items.push(cur); };
  for (const rawLine of text.split('\n')) {
    if (stopped) break;
    const line = rawLine.trim();
    if (!line) continue;
    if (started && STOP_RE.test(line)) { stopped = true; break; }
    let m = line.match(ART_PAREN);
    if (m) {
      started = true;
      if (cur && cur.n === m[1] && cur.body === 0) { // 머리 줄의 반복 → 건너뜀
        if (m[3]) { cur.x += '\n' + m[3]; cur.body++; }
        continue;
      }
      if (!cur) { newArt(m[1], m[2]); if (m[3]) { cur.x += '\n' + m[3]; cur.body++; } continue; }
      // 그 밖의 "제N조(…)…" 줄은 다른 조문을 인용하는 본문(예: "제419조(제2항…)는 … 준용한다")
      cur.x += '\n' + line; cur.body++;
      continue;
    }
    m = line.match(ART_PLAIN);
    if (m && m[2].length <= 80 && !/다\.\s*$/.test(m[2]) && !/^(제\d|및\s|또는\s|부터|까지|에\s|의\s)/.test(m[2])) {
      started = true;
      newArt(m[1], m[2]);
      continue;
    }
    if (!started) continue;
    if (HEAD_RE.test(line)) { cur = null; items.push({ t: 'h', x: line }); continue; }
    if (!cur) continue;
    cur.x += '\n' + line; cur.body++;
  }
  for (const it of items) delete it.body;
  return items;
}

// 긴 법령은 공개 서버가 조문 목록(제목)만 돌려주므로, 본문이 빠진 조문을 묶음 조회로 채웁니다.
const hasBody = (a) => a.x.includes('\n');
async function fillBodies(meta, items) {
  const empty = items.filter((i) => i.t === 'a' && !hasBody(i));
  if (!empty.length) return 0;
  const byN = new Map(items.filter((i) => i.t === 'a').map((i) => [i.n, i]));
  let filled = 0;
  const run = async (chunk) => {
    const t = await mcpTool('execute_tool', { tool_name: 'get_batch_articles', params: { mst: meta.mst, articles: chunk.map((a) => a.n) } });
    for (const got of parseLawText(t)) {
      const it = byN.get(got.n);
      if (it && hasBody(got) && !hasBody(it)) { it.x = got.x; if (!it.title) it.title = got.title; filled++; }
    }
  };
  const SIZE = 25;
  for (let i = 0; i < empty.length; i += SIZE) {
    const chunk = empty.slice(i, i + SIZE);
    try { await run(chunk); }
    catch (e) { // 응답이 너무 크면 반으로 나눠 다시
      log(`  묶음 재시도(${chunk[0].n}~): ${e.message.slice(0, 80)}`);
      for (const half of [chunk.slice(0, 12), chunk.slice(12)]) { if (half.length) { await sleep(800); try { await run(half); } catch {} } }
    }
    await sleep(500);
  }
  return filled;
}

async function mcpLaw(meta) {
  const t = await mcpTool('get_law_text', { mst: meta.mst });
  const items = parseLawText(t);
  if (!items.some((i) => i.t === 'a')) throw new Error('조문을 찾지 못함');
  const filled = await fillBodies(meta, items);
  if (filled) log(`  본문 ${filled}개를 묶음 조회로 채움`);
  const missing = items.filter((i) => i.t === 'a' && !hasBody(i) && !/삭제/.test(i.title)).length;
  if (missing > 3) log(`  ⚠ 본문 없는 조문 ${missing}개`);
  return { ...meta, items, missing };
}

/* ───────────────────────── 3) 수집 실행 ───────────────────────── */

async function collect() {
  const cfg = await readJSON(path.join(ROOT, 'laws.config.json'));
  const index = await readJSON(path.join(DATA, 'index.json'), { laws: [] });
  const changes = await readJSON(path.join(DATA, 'changes.json'), []);
  const prev = new Map(index.laws.map((l) => [l.name, l]));
  const source = OC ? 'law.go.kr' : 'mcp';
  log(OC ? '법제처 Open API로 수집합니다.' : '인증키가 없어 공개 법령 서버(공용 한도)로 수집합니다.');

  const search = OC ? drfSearch : mcpSearch;
  const fetchLaw = OC ? drfLaw : mcpLaw;
  const out = [];
  const failed = [];

  for (const cat of cfg.categories) {
    for (const name of cat.laws) {
      const old = prev.get(name);
      try {
        const meta = await search(name);
        await sleep(400);
        if (!meta || !meta.mst) { failed.push(`${name}: 검색 결과 없음`); if (old) out.push({ ...old, cat: cat.id }); continue; }
        const id = meta.lawId || meta.mst;
        const file = path.join(LAWDIR, `${id}.json`);
        const exists = await fs.stat(file).then(() => true).catch(() => false);
        if (!FORCE && old && old.mst === meta.mst && exists && !old.sample && !(old.missing > 3)) {
          out.push({ ...old, cat: cat.id });
          log(`그대로  ${name} (MST ${meta.mst})`);
          continue;
        }
        const law = await fetchLaw(meta);
        await sleep(600);
        const articles = law.items.filter((i) => i.t === 'a').length;
        await writeJSON(file, { id, name: law.name, mst: law.mst, kind: law.kind, dept: law.dept,
          promulgated: law.promulgated, effective: law.effective, fetched: today(), source, items: law.items });
        const entry = { id, cat: cat.id, name: law.name, mst: law.mst, kind: law.kind, dept: law.dept,
          promulgated: law.promulgated, effective: law.effective, fetched: today(), articles, missing: law.missing || 0,
          bytes: JSON.stringify(law.items).length };
        out.push(entry);
        if (old && old.mst !== meta.mst && !old.sample) {
          changes.unshift({ date: today(), name: law.name, id, fromMst: old.mst, toMst: law.mst,
            fromEffective: old.effective, toEffective: law.effective, promulgated: law.promulgated });
          log(`개정반영 ${name} (${old.effective} → ${law.effective})`);
        } else log(`새로받음 ${name} — 조문 ${articles}개`);
      } catch (e) {
        failed.push(`${name}: ${e.message}`);
        if (old) out.push({ ...old, cat: cat.id });
        log(`실패    ${name}: ${e.message}`);
      }
    }
  }

  const newIndex = {
    updated: today(), source,
    categories: cfg.categories.map((c) => ({ id: c.id, name: c.name })),
    laws: out, failed,
  };
  await writeJSON(path.join(DATA, 'index.json'), newIndex);
  await writeJSON(path.join(DATA, 'changes.json'), changes.slice(0, 200));

  // 목록에서 빠진 법령 파일 정리
  const keep = new Set(out.map((l) => `${l.id}.json`));
  for (const f of await fs.readdir(LAWDIR).catch(() => [])) if (!keep.has(f)) await fs.unlink(path.join(LAWDIR, f));

  log(`완료: ${out.length}건 저장, 실패 ${failed.length}건`);
  if (failed.length) failed.forEach((f) => log('  -', f));
  if (!out.length) process.exitCode = 1;
}

/* ───────────────────────── 4) 회사 PC용 단일 파일 ───────────────────────── */

async function buildOffline() {
  const index = await readJSON(path.join(DATA, 'index.json'), null);
  if (!index) { log('data/index.json이 없어 offline.html을 만들지 않습니다.'); return; }
  const laws = {};
  for (const l of index.laws) {
    const d = await readJSON(path.join(LAWDIR, `${l.id}.json`), null);
    if (d) laws[l.id] = d;
  }
  const changes = await readJSON(path.join(DATA, 'changes.json'), []);
  const payload = JSON.stringify({ index, laws, changes }).replace(/</g, '\\u003c');
  let html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const iconB64 = await fs.readFile(path.join(ROOT, 'icon.svg')).then((b) => b.toString('base64')).catch(() => '');
  html = html
    .replace(/<link rel="manifest"[^>]*>\s*/g, '')
    .replace(/<link rel="preconnect"[^>]*>\s*/g, '')
    .replace(/<link[^>]*pretendard[^>]*>\s*/g, '')
    .replace(/<link rel="apple-touch-icon"[^>]*>\s*/g, '')
    .replace(/<link rel="icon"[^>]*>/, () => `<link rel="icon" href="data:image/svg+xml;base64,${iconB64}">`)
    .replace('<!--EMBED-->', () => `<script>window.__LAW_DATA__=${payload};</script>`);
  await fs.writeFile(path.join(ROOT, 'offline.html'), html);
  log(`offline.html 생성 (${(html.length / 1048576).toFixed(1)}MB, 법령 ${Object.keys(laws).length}건)`);
}

export { parseLawText, buildOffline };
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!ONLY_BUILD) await collect();
  await buildOffline();
}
