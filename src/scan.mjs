// Look at Y: which files are there now (skipping junk and runtime state), and what changed.
import { readdirSync, lstatSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { putBlob } from './store.mjs';

/** Glob to regex: * within a segment, ? one char, ** across folders. */
function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Rules from patterns (skip list or .gitignore lines), relative to folder `base` ('' = top of Y). */
export function makeRules(lines, base = '') {
  const rules = [];
  for (let l of lines) {
    l = String(l).replace(/\s+$/, ''); if (!l || l.startsWith('#')) continue;
    const neg = l.startsWith('!'); if (neg) l = l.slice(1);
    const dirOnly = l.endsWith('/'); l = l.replace(/\/+$/, '');
    if (!l) continue;
    const anchored = l.replace(/^\*\*\//, '').includes('/') || l.startsWith('/');
    l = l.replace(/^\//, '');
    rules.push({ base, neg, dirOnly, anchored, re: globToRe(anchored ? l : l.replace(/^\*\*\//, '')) });
  }
  return rules;
}

const gitignoreRules = (y, rel) => {
  const f = join(y, rel, '.gitignore');
  try { return existsSync(f) ? makeRules(readFileSync(f, 'utf8').split('\n'), rel) : []; } catch { return []; }
};

/** Is this path skipped? Rules are checked in order and the last one that matches wins (like git). */
export function skipped(rules, rel, isDir) {
  let out = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && !rel.startsWith(r.base + '/')) continue;
    const sub = r.base ? rel.slice(r.base.length + 1) : rel;
    if (r.anchored ? r.re.test(sub) : r.re.test(sub.split('/').at(-1))) out = !r.neg;
  }
  return out;
}

/** Returns skip(relPath, isDir) for the skip list plus Y's top .gitignore (sub-folder ones are added by scan). */
export function loadSkip(y, skip = []) {
  const rules = [...makeRules(skip), ...gitignoreRules(y, '')];
  return (rel, isDir) => skipped(rules, rel, isDir);
}

/** Scan Y. Stores new content in Z. prev: last snapshot's files, reused when size+mtime match,
 *  and carried forward for anything that can't be read right now (so unreadable never looks removed). */
export function scan(y, z, { skip = [], prev = {}, skipFn = null } = {}) {
  const files = {}, unreadable = [];
  const keepPrev = rel => { for (const k of Object.keys(prev)) if (k === rel || k.startsWith(rel + '/')) files[k] = prev[k]; };
  const walk = (rel, rules) => {
    let names;
    try { names = readdirSync(rel ? join(y, rel) : y); } catch { if (rel) { unreadable.push(rel); keepPrev(rel); } return; }
    rules = [...rules, ...gitignoreRules(y, rel)];
    const isSkipped = skipFn ?? ((r, d) => skipped(rules, r, d));
    for (const name of names.sort()) {
      const r = rel ? `${rel}/${name}` : name, abs = join(y, r);
      let st; try { st = lstatSync(abs); } catch { unreadable.push(r); keepPrev(r); continue; }
      if (st.isDirectory()) {
        // another checkout or project living inside Y (e.g. an agent's git worktree) is its own thing
        if (!isSkipped(r, true) && !existsSync(join(abs, '.git')) && !existsSync(join(abs, '.xyz'))) walk(r, rules);
        continue;
      }
      if (isSkipped(r, false)) continue;
      if (st.isSymbolicLink()) { try { files[r] = { link: readlinkSync(abs), mode: 0o777, size: 0, mtimeMs: st.mtimeMs }; } catch { unreadable.push(r); keepPrev(r); } continue; }
      if (!st.isFile()) continue;
      const mode = st.mode & 0o7777, p = prev[r];
      if (p && !p.link && p.size === st.size && p.mtimeMs === st.mtimeMs && p.mode === mode) { files[r] = p; continue; }
      try { files[r] = { hash: putBlob(z, readFileSync(abs)), size: st.size, mode, mtimeMs: st.mtimeMs }; }
      catch { unreadable.push(r); keepPrev(r); }
    }
  };
  walk('', makeRules(skip));
  return { files, unreadable };
}

const same = (a, b) => (a.link !== undefined || b.link !== undefined) ? a.link === b.link : (a.hash === b.hash && (a.mode ?? 0) === (b.mode ?? 0));

export function diff(a = {}, b = {}) {
  const added = [], removed = [], changed = [];
  for (const k of Object.keys(b)) { if (!(k in a)) added.push(k); else if (!same(a[k], b[k])) changed.push(k); }
  for (const k of Object.keys(a)) if (!(k in b)) removed.push(k);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
