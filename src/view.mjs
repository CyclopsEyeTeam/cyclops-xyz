// What people see: one project on one screen, and the list of all projects.
import { existsSync, readFileSync, readlinkSync, statSync, readdirSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { scan, diff } from './scan.mjs';
import { listReceipts, when } from './receipts.mjs';
import { changesNow, loadSnapshot } from './save.mjs';
import { allHomes, openProject } from './project.mjs';
import { laneLines } from './lane.mjs';

const ago = at => { const s = (Date.now() - at) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
const lastLine = f => { try { const ls = readFileSync(f, 'utf8').trim().split('\n'); return JSON.parse(ls.at(-1)); } catch { return null; } };

export function liveInfo(p) {
  let current = null; try { current = basename(readlinkSync(join(p.x, 'current'))); } catch {}
  const h = lastLine(join(p.x, 'history.jsonl'));
  let label = null; try { const seen = [...new Set(readFileSync(join(p.x, 'history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.kind === 'promote').map(x => x.version))]; if (current) label = `v${seen.indexOf(current) + 1}`; } catch {}
  return { current, label, since: h?.at ?? null, receipt: h?.receipt ?? null, servicesFromX: !!p.config.servicesFromX, services: p.config.services };
}

/** A promoted (or being-checked) copy of a saved state that cwd is inside, for this project: { dir, version } or null. */
export function copyHere(p, cwd = process.cwd()) {
  // copies live in X/versions/ (in a single project X is the project folder, so Y and Z sit beside versions/)
  const versions = join(p.x, 'versions');
  for (let d = resolve(cwd); d.startsWith(versions + '/'); d = dirname(d)) {
    try { const v = JSON.parse(readFileSync(join(d, '.xyz-version'), 'utf8')); return { dir: d, version: v.version }; } catch {}
  }
  return null;
}

/** Inside a copy: what differs from the saved state it was built from (e.g. files a check wrote into the tree). */
function copyChanges(p, c) {
  const snap = loadSnapshot(p.z, c.version);
  const { files, unreadable } = scan(c.dir, p.z, { skip: [...(p.config.skip ?? []), '.xyz-version', ...(p.config.deps ?? [])], prev: snap.files });
  return { ...diff(snap.files, files), unreadable };
}

export function projectInfo(p) {
  const copy = copyHere(p);
  let about = '';
  try { about = readFileSync(join(p.z, 'NOTES.md'), 'utf8').split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#')) ?? ''; } catch {}
  let unsaved; try { const c = copy ? copyChanges(p, copy) : changesNow(p); unsaved = { added: c.added, removed: c.removed, changed: c.changed, unreadable: c.unreadable }; } catch (e) { unsaved = { error: e.message }; }
  return { name: p.name, ...(copy ? { copy: { dir: copy.dir, version: copy.version, note: 'unsaved = differences from the saved state this copy was built from' } } : {}), about, places: { X: p.x, Y: p.y, Z: p.z, notes: join(p.z, 'NOTES.md') }, live: liveInfo(p), unsaved, receipts: listReceipts(p.z, 5), lastTry: lastLine(join(p.z, 'tries.jsonl')), settings: p.config };
}

export function projectView(p) {
  const i = projectInfo(p), L = [];
  L.push(`━━ ${i.name} ━━`);
  if (i.copy) L.push(`(You are in a saved copy, ${i.copy.version}: "unsaved" below means changed since it was built.)`);
  if (i.about) L.push(i.about.replace(/\s+/g, ' ').slice(0, 400));
  L.push('', `X: ${i.places.X}   (live)`, `Y: ${i.places.Y}   (source — work here)`, `Z: ${i.places.Z}   (memory — notes: Z/NOTES.md)`, '');
  const lv = i.live;
  L.push(lv.current ? `Live: ${lv.label ?? lv.current} (${lv.current})${lv.since ? `, since ${when(lv.since)}` : ''}` : 'Live: nothing promoted yet (xyz promote puts Y live)');
  if (lv.services.length) L.push(lv.servicesFromX ? `      services run from X: ${lv.services.join(', ')}` : `      live services still run from Y: ${lv.services.join(', ')}`);
  const u = i.unsaved;
  if (u.error) L.push(`Unsaved: could not look (${u.error})`);
  else {
    const all = [...u.changed.map(f => `~ ${f}`), ...u.added.map(f => `+ ${f}`), ...u.removed.map(f => `- ${f}`)];
    L.push(all.length ? `Unsaved in Y: ${all.length} file${all.length === 1 ? '' : 's'} (xyz save "why" keeps them)` : 'Unsaved in Y: nothing, all kept');
    for (const f of all.slice(0, 10)) L.push(`   ${f}`);
    if (all.length > 10) L.push(`   … and ${all.length - 10} more (all of them, with who edited each: xyz changed)`);
  }
  try { const ls = laneLines(p); if (ls.length) { L.push('', 'Open lanes:'); for (const l of ls) L.push(`  ${l}`); } } catch {}
  L.push('', 'Latest receipts:');
  for (const r of i.receipts) L.push(`  ${r.id}  ${ago(r.at).padEnd(12)} ${r.who.padEnd(10)} ${r.title}`);
  if (!i.receipts.length) L.push('  none yet');
  if (i.lastTry) L.push('', `Last RAM try: "${i.lastTry.command}" ${i.lastTry.ok ? 'passed' : `failed (exit ${i.lastTry.code})`}, ${ago(i.lastTry.at)}`);
  return L.join('\n');
}

export function listInfo() {
  return allHomes().map(h => {
    try {
      const p = openProject(h), last = listReceipts(p.z, 1)[0];
      let unsaved = null, c = null; try { c = changesNow(p); unsaved = c.added.length + c.removed.length + c.changed.length; } catch {}
      let about = ''; try { about = readFileSync(join(p.z, 'NOTES.md'), 'utf8').split(/\n\s*\n/).map(x => x.trim()).find(x => x && !x.startsWith('#')) ?? ''; } catch {}
      if (/^What this is, in a sentence/.test(about)) about = '';
      let lanes = 0; try { lanes = laneLines(p).length; } catch {}
      const lv = liveInfo(p);
      // last activity: a receipt, a signed edit, a lane checkpoint or an unsaved file — whichever is newest
      const mt = f => { try { return statSync(f).mtimeMs; } catch { return 0; } };
      let active = Math.max(last?.at ?? 0, mt(join(p.z, 'receipts.jsonl')), mt(join(p.z, 'touches.jsonl')));
      try { for (const l of readdirSync(join(p.z, 'lanes'))) active = Math.max(active, mt(join(p.z, 'lanes', l, 'lane.json')), mt(join(p.z, 'lanes', l, 'checkpoint.json'))); } catch {}
      if (unsaved && c) for (const r of [...c.added, ...c.changed]) active = Math.max(active, mt(join(p.y, r)));
      return { name: p.name, home: h, y: p.y, x: p.x, z: p.z, active, about: about.replace(/\s+/g, ' ').slice(0, 300), last: last ? { id: last.id, at: last.at, title: last.title, who: last.who } : null, unsaved, live: lv.current, liveLabel: lv.label, lanes, layout: p.layout };
    } catch (e) { return { name: basename(h), home: h, error: e.message }; }
  });
}

export function listView() {
  const rows = listInfo();
  if (!rows.length) return 'No XYZ projects yet. Start one with: xyz new <Name>   or bring one in: xyz convert <folder>';
  const w = Math.max(...rows.map(r => r.name.length)) + 2;
  return rows.map(r => r.error ? `${r.name.padEnd(w)} ⚠ ${r.error}` :
    `${r.name.padEnd(w)} ${r.last ? `${ago(r.last.at).padEnd(12)} ${r.last.title}` : 'no receipts'}${r.unsaved ? `  · ${r.unsaved} unsaved` : ''}${r.live ? '  · live' : ''}${r.layout === 'single' ? `  · single: ${r.home}` : ''}`).join('\n');
}
