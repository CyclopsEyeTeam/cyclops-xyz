// The map: light for an agent from the first moment. Z/MAP.md says what a project is, how to run and test it,
// where things live, what to be careful with and what is moving. Facts are refreshed by the auto-saver;
// the "Kept by hand" part is never touched, so what agents write there stays.
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { latestSnapshot } from './save.mjs';
import { listReceipts } from './receipts.mjs';
import { aboutFrom } from './project.mjs';

export const HAND = '## Kept by hand';
const HAND_STARTER = `${HAND}\n\n(Anything the next agent should know that the facts above can't show: why it's built this way,\ntraps, the one command that matters. Everything below this heading is kept when the map refreshes.)\n`;
const CODE = /\.(m?js|cjs|ts|tsx|jsx|py|rs|go|sh|rb|java|kt|swift|c|cc|cpp|h|lua|gd)$/;
const ENTRY = /^(main|index|app|server|cli|run|start|__main__|manage)\.[a-z]+$/;

const readHead = (f, n = 1200) => { try { const fd = openSync(f, 'r'), b = Buffer.alloc(n); const k = readSync(fd, b, 0, n, 0); closeSync(fd); return b.subarray(0, k).toString('utf8'); } catch { return ''; } };
const json = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const clip = (s, n) => (s = String(s).replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s;

const firstSentence = t => { t = t.replace(/\s+/g, ' ').trim(); const m = t.match(/^(.{12,}?[.!?])(\s|$)/); return clip(m ? m[1] : t, 110); };

/** The first comment of a code file (joined across its lines), as a one-sentence "what this is". */
export function firstComment(file) {
  const lines = readHead(file, 2000).split('\n').map(l => l.trim());
  let i = 0;
  while (i < lines.length && (!lines[i] || lines[i].startsWith('#!') || /^(['"])use strict\1;?$/.test(lines[i]) || /coding[:=]|^\/\/\s*@ts-|eslint/.test(lines[i]))) i++;
  const opener = lines[i] ?? '';
  const take = [];
  if (/^("""|\'\'\'|\/\*)/.test(opener)) {
    const close = opener.startsWith('/*') ? '*/' : opener.slice(0, 3);
    let first = opener.slice(opener.startsWith('/**') ? 3 : opener.startsWith('/*') ? 2 : 3);
    for (let j = i, cur = first; j < lines.length && take.length < 6; cur = lines[++j]) {
      const done = j > i ? cur?.includes(close) : first.includes(close);
      take.push(String(cur ?? '').replace(close, '').replace(/^\*\s?/, ''));
      if (done) break;
    }
  } else {
    const mark = opener.match(/^(\/\/+|#+|--)/)?.[1];
    if (!mark) return '';
    for (let j = i; j < lines.length && lines[j].startsWith(mark) && take.length < 6; j++) take.push(lines[j].slice(mark.length));
  }
  const text = take.join(' ').trim();
  if (!text || /^(SPDX|Copyright|-\*-|prettier|type:)/i.test(text)) return '';
  return firstSentence(text);
}

function folderPurpose(y, dir, files, projectName = '') {
  const about = aboutFrom(join(y, dir));
  if (about) return clip(about, 110);
  const rank = f => { const b = basename(f).replace(/\.[^.]+$/, '').toLowerCase(); return ENTRY.test(basename(f)) || b === dir.toLowerCase() || b === projectName.toLowerCase() ? 0 : 1; };
  const code = files.filter(f => CODE.test(f) && !f.slice(dir.length + 1).includes('/')).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  // a random file's comment would mislead about a big folder: use an entry file, or a small folder's files
  const trusted = code.length <= 8 ? code.slice(0, 4) : code.filter(f => rank(f) === 0).slice(0, 2);
  for (const f of trusted) { const c = firstComment(join(y, f)); if (c) return c; }
  return '';
}

/** How to run and test: from package.json, pyproject, Makefile, Cargo, bin/, entry-like files and xyz.json. */
function howTo(p, files) {
  const y = p.y, run = [], test = [];
  const pkg = json(join(y, 'package.json'));
  if (pkg) {
    for (const [k, v] of Object.entries(pkg.scripts ?? {})) (/test|check|lint|spec/.test(k) ? test : run).push(`npm run ${k}  →  ${clip(v, 80)}`);
    const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin ?? {};
    for (const [k, v] of Object.entries(bins)) run.push(`bin ${k}  →  ${v}`);
    if (pkg.main) run.push(`main: ${pkg.main}`);
  }
  const py = existsSync(join(y, 'pyproject.toml')) ? readFileSync(join(y, 'pyproject.toml'), 'utf8') : '';
  const scripts = py.match(/\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/);
  if (scripts) for (const l of scripts[1].split('\n')) { const m = l.match(/^\s*([\w.-]+)\s*=\s*"([^"]+)"/); if (m) run.push(`${m[1]}  →  ${m[2]}`); }
  if (/\[tool\.pytest/.test(py) || files.some(f => /(^|\/)(conftest\.py|pytest\.ini)$/.test(f))) test.push('pytest');
  if (existsSync(join(y, 'Makefile'))) {
    const targets = [...readFileSync(join(y, 'Makefile'), 'utf8').matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)].map(m => m[1]).slice(0, 10);
    if (targets.length) (targets.some(t => /test|check/.test(t)) ? test : run).push(`make ${targets.join(' | ')}`);
  }
  if (existsSync(join(y, 'Cargo.toml'))) { run.push('cargo run'); test.push('cargo test'); }
  if (existsSync(join(y, 'go.mod'))) { run.push('go run .'); test.push('go test ./...'); }
  for (const f of files.filter(f => /^bin\/[^/]+$/.test(f)).slice(0, 6)) run.push(`${f}${CODE.test(f) ? `  —  ${firstComment(join(y, f)) || ''}` : ''}`.replace(/\s+—\s+$/, ''));
  const entries = files.filter(f => ENTRY.test(basename(f)) && f.split('/').length <= 2 && !/^(tests?|node_modules|vendor)\//.test(f)).slice(0, 6);
  for (const f of entries) if (!run.some(r => r.includes(f))) run.push(`${f}${firstComment(join(y, f)) ? `  —  ${firstComment(join(y, f))}` : ''}`);
  const testDirs = [...new Set(files.map(f => f.split('/')[0]).filter(d => /^(tests?|spec|__tests__)$/.test(d)))];
  // a project's own test runners (e.g. test/shell/run.mjs) beat a guess
  for (const f of files.filter(f => /^(tests?|spec)\/(.+\/)?(run|runner|all)\.(m?js|py|sh)$/.test(f)).slice(0, 6)) test.push(`${f.endsWith('.py') ? 'python3' : f.endsWith('.sh') ? 'bash' : 'node'} ${f}`);
  if (testDirs.length && !test.length) {
    const kinds = new Set(files.filter(f => testDirs.includes(f.split('/')[0])).map(f => f.split('.').pop()));
    test.push(kinds.has('py') ? `pytest ${testDirs.join(' ')}` : kinds.has('mjs') || kinds.has('js') ? `node --test ${testDirs[0]}/` : `tests in ${testDirs.join(', ')}/`);
  }
  if (p.config.check) test.unshift(`xyz promote runs: ${p.config.check}`);
  return { run: run.slice(0, 10), test: test.slice(0, 6) };
}

/** Text as whole items: bullets and paragraphs with their wrapped lines joined. */
function items(text) {
  const out = []; let cur = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) { if (cur) out.push(cur); cur = null; continue; }
    if (/^\s*([-*+]|\d+[.)])\s/.test(raw)) { if (cur) out.push(cur); cur = raw.replace(/^\s*([-*+]|\d+[.)])\s+/, ''); }
    else cur = cur ? `${cur} ${raw.trim()}` : raw.trim();
  }
  if (cur) out.push(cur);
  return out;
}

const WARN = /\bHOLD\b|\bdo not\b|\bdon['’]t\b|\bnever\b|\bmust not\b/i;
// the machine-wide rules already say these; repeating them would only dim the rest
const COMMON = /xyz save|xyz undo|\bcommit\b|Z\/NOTES\.md|handover files|xyz <?project|`xyz [A-Za-z]/i;

/** Sentences from NOTES.md (and AGENTS.md/CLAUDE.md in Y) that warn: HOLDs, "do not", "never". */
function careful(p) {
  const out = [], seen = new Set();
  for (const f of [join(p.z, 'NOTES.md'), join(p.y, 'AGENTS.md'), join(p.y, 'CLAUDE.md')]) {
    let text = ''; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const item of items(text)) {
      for (const sent of item.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z*`(])/)) {
        if (sent.length < 16 || !WARN.test(sent) || COMMON.test(sent)) continue;
        const k = clip(sent.replace(/\*\*/g, ''), 200); if (seen.has(k)) continue; seen.add(k); out.push(k);
        if (out.length >= 8) return out;
      }
    }
  }
  return out;
}

/** Files that changed most over the last receipts, and the recent "why"s. */
function moving(p) {
  const rs = listReceipts(p.z, 30), count = new Map();
  for (const r of rs) if (r.kind !== 'adopt' && r.kind !== 'convert') for (const f of [...(r.changed ?? []), ...(r.added ?? [])]) count.set(f, (count.get(f) ?? 0) + 1);
  const hot = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([f, n]) => `${f} (${n}×)`);
  const whys = rs.filter(r => r.why && r.kind !== 'auto').slice(0, 5).map(r => `${r.id} ${new Date(r.at).toISOString().slice(0, 10)} ${r.who}: ${clip(r.why, 140)}`);
  return { hot, whys };
}

/** Build the facts part of the map (no timestamp, so an unchanged project gives an unchanged map). */
export function buildFacts(p) {
  const snap = latestSnapshot(p.z), files = Object.keys(snap?.files ?? {}).sort();
  let about = '';
  try { about = readFileSync(join(p.z, 'NOTES.md'), 'utf8').split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#')) ?? ''; } catch {}
  about ||= aboutFrom(p.y);
  const top = new Map();
  for (const f of files) { const d = f.includes('/') ? f.split('/')[0] : null; if (d) top.set(d, [...(top.get(d) ?? []), f]); }
  const dirs = [...top].sort((a, b) => b[1].length - a[1].length).slice(0, 14).sort((a, b) => a[0].localeCompare(b[0]));
  const topFiles = files.filter(f => !f.includes('/'));
  const how = howTo(p, files), warn = careful(p), mv = moving(p);
  const L = [`# ${p.name} — map`, '', clip(about || '(No description yet: write one at the top of Z/NOTES.md.)', 500), ''];
  L.push(`Y (work here): ${p.y}`, `Z (memory): ${p.z}  ·  notes: Z/NOTES.md`, `${files.length} files kept` + (top.size > dirs.length ? ` in ${top.size} folders (the ${dirs.length} biggest below)` : ''), '');
  L.push('## Run and test', '');
  if (!how.run.length && !how.test.length) L.push('(Nothing obvious found. Once you know, leave it for the next agent: xyz save "why" --learned "run: <command> · test: <command>")');
  for (const r of how.run) L.push(`- run: ${r}`);
  for (const t of how.test) L.push(`- test: ${t}`);
  L.push('', '## Where things live', '');
  for (const [d, fs] of dirs) { const why = folderPurpose(p.y, d, fs, p.name); L.push(`- \`${d}/\` (${fs.length})${why ? ` — ${why}` : ''}`); }
  if (topFiles.length) L.push(`- top level: ${topFiles.slice(0, 16).join(', ')}${topFiles.length > 16 ? `, and ${topFiles.length - 16} more` : ''}`);
  if (warn.length) { L.push('', '## Careful', ''); for (const w of warn) L.push(`- ${w}`); }
  L.push('', '## What is moving', '');
  if (mv.hot.length) L.push(`Most changed lately: ${mv.hot.join(', ')}`, '');
  for (const w of mv.whys) L.push(`- ${w}`);
  if (!mv.hot.length && !mv.whys.length) L.push('(No changes since it came into XYZ.)');
  return L.join('\n') + '\n';
}

export const mapFile = p => join(p.z, 'MAP.md');

/** The hand-kept part of an existing map (from its heading to the end), or the starter. */
function handPart(text) { const i = text.indexOf(`\n${HAND}`); return i >= 0 ? text.slice(i + 1) : HAND_STARTER; }

/** Refresh Z/MAP.md. Writes only when the facts changed (or there is no map). Returns true when written. */
export function refreshMap(p) {
  const f = mapFile(p);
  let old = ''; try { old = readFileSync(f, 'utf8'); } catch {}
  const next = buildFacts(p) + '\n' + handPart(old);
  if (next === old) return false;
  writeAtomic(f, next);
  return true;
}

/** Is the map older than the latest snapshot (or missing)? */
export function mapStale(p) {
  try { return statSync(mapFile(p)).mtimeMs < statSync(join(p.z, 'head')).mtimeMs; } catch { return true; }
}

/** One section of NOTES.md by heading word (e.g. "In progress"), trimmed. */
function notesSection(p, word, max) {
  let t = ''; try { t = readFileSync(join(p.z, 'NOTES.md'), 'utf8'); } catch { return ''; }
  const m = t.match(new RegExp(`^##+\\s*${word}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi'));
  if (!m) return '';
  const s = m[1].replace(/^\((What someone is working on|How to start it|What this is)[^\n]*\)\s*$/gm, '').trim();
  return s.length > max ? s.slice(0, max).replace(/\n[^\n]*$/, '') + '\n…(more in Z/NOTES.md)' : s;
}

/** The arrival packet: short enough to inject at the start of every session (~1–2k tokens). */
export function arrive(p, { unsaved = null, live = null } = {}) {
  if (mapStale(p)) { try { refreshMap(p); } catch {} }
  let map = ''; try { map = readFileSync(mapFile(p), 'utf8'); } catch {}
  const section = (name, max) => { const m = map.match(new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm')); const s = (m?.[1] ?? '').trim(); return s.length > max ? s.slice(0, max).replace(/\n[^\n]*$/, '') + '\n- …' : s; };
  const about = (map.split('\n\n')[1] ?? '').trim();
  const hand = handPart(map).slice(HAND.length).trim();
  const L = [`━━ You are in ${p.name} (an XYZ project) ━━`, about, '',
    `Y (work here): ${p.y}`, `Map: ${mapFile(p)}  ·  Notes: ${join(p.z, 'NOTES.md')}`];
  if (live) L.push(live);
  if (unsaved) L.push(unsaved);
  const add = (title, body) => { if (body) L.push('', `▸ ${title}`, body); };
  add('In progress', notesSection(p, 'In progress', 900));
  add('Run and test', section('Run and test', 700));
  add('Where things live', section('Where things live', 1100));
  add('Careful', section('Careful', 700));
  add('What is moving', section('What is moving', 700));
  if (hand && !hand.startsWith('(Anything the next agent')) add('Kept by hand', hand.length > 900 ? hand.slice(0, 900) + '…' : hand);
  L.push('', 'When you finish a piece: xyz save "why" --who <your name> --learned "<one thing about this terrain>"',
    "If your sandbox can't write Z, save and --learned wait in Y and the auto-saver keeps them within 15 min: don't retry.");
  return L.join('\n');
}

/** Leave light behind: add one dated line about the terrain to the hand-kept part of the map. */
export function learn(p, text, who = 'agent') {
  text = clip(text, 300); if (!text) return;
  if (!existsSync(mapFile(p))) refreshMap(p);
  let map = readFileSync(mapFile(p), 'utf8');
  if (!map.includes(`\n${HAND}`)) map = map.trimEnd() + '\n\n' + HAND_STARTER;
  map = map.replace(/\(Anything the next agent[\s\S]*?refreshes\.\)\n?/, '');
  writeAtomic(mapFile(p), map.trimEnd() + `\n- ${new Date().toISOString().slice(0, 10)} ${who}: ${text}\n`);
}
