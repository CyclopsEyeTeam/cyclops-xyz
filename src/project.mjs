// Projects: where X, Y and Z are, their settings, making new ones and adopting existing folders.
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { writeAtomic } from './atomic.mjs';
import { save } from './save.mjs';

export const ROOT = () => process.env.XYZ_ROOT || join(homedir(), 'XYZ');
export const DEFAULT_SKIP = ['node_modules', '.git', '.venv', 'venv', '__pycache__', '*.pyc', '.tmp', '*.sqlite', '*.sqlite-*', '*.sqlite3', '*.sqlite3-*', '*.db', '*.db-*', '*-journal', '*.duckdb', '*.duckdb.wal', '*.mdb', '*.ldb', '*.pid', '*.log', '.remember', '.cyclops', '.xyz', '.xyz-pending.jsonl', '.xyz-pending.*', '.DS_Store'];
export const squash = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export function readConfig(home) {
  let c = {}; try { c = JSON.parse(readFileSync(join(home, 'xyz.json'), 'utf8')); } catch {}
  return { name: basename(home), deps: [], check: '', services: [], servicesFromX: false, tryMaxMB: 2048, ...c, skip: [...new Set([...DEFAULT_SKIP, ...(c.skip ?? [])])] };
}

export function openProject(home) {
  home = resolve(home);
  if (!existsSync(join(home, 'xyz.json'))) throw new Error(`${home} is not an XYZ project home`);
  const config = readConfig(home);
  let y = join(home, 'Y'); try { y = realpathSync(y); } catch { throw new Error(`${config.name}: its source (Y) is missing — ${join(home, 'Y')} points nowhere`); }
  return { name: config.name, home, x: join(home, 'X'), y, z: join(home, 'Z'), config };
}

/** Every project home under the root (real folders or links to homes elsewhere). */
export function allHomes() {
  const r = ROOT(); if (!existsSync(r)) return [];
  return readdirSync(r).filter(n => !n.startsWith('.')).map(n => join(r, n)).filter(h => existsSync(join(h, 'xyz.json')));
}

function notesStarter(name, about = '') {
  return `# ${name}\n\n${about || 'What this is, in a sentence or two.'}\n\n## How it runs\n\n(How to start it, where it lives, which services.)\n\n## In progress\n\n(What someone is working on right now, and what is next.)\n\n## For the next person\n\nRun \`xyz ${name}\` to see everything about this project. Work in Y. When you finish something, \`xyz save "why"\`.\n`;
}

function writeConfig(home, extra = {}) {
  writeAtomic(join(home, 'xyz.json'), JSON.stringify({ name: basename(home), skip: [], deps: [], check: '', services: [], servicesFromX: false, tryMaxMB: 2048, ...extra }, null, 2) + '\n');
}

/** A brand-new project. With at: made in that folder and linked from the root. */
export function newProject(name, { at = null, who = 'owner' } = {}) {
  if (!/^[\w][\w .-]*$/.test(name)) throw new Error(`"${name}" can't be a project name; use letters, numbers, spaces, - or _`);
  const link = join(ROOT(), name), home = at ? join(resolve(at), name) : link;
  for (const h of new Set([home, link])) if (existsSync(h)) throw new Error(`${name} already exists at ${h}`);
  for (const d of ['X', 'Y', 'Z']) mkdirSync(join(home, d), { recursive: true });
  if (home !== link) { mkdirSync(ROOT(), { recursive: true }); symlinkSync(home, link); }
  writeConfig(home);
  writeAtomic(join(home, 'Y', '.xyz'), home + '\n');
  writeAtomic(join(home, 'Z', 'NOTES.md'), notesStarter(name));
  const p = openProject(home);
  save(p, { kind: 'adopt', who, why: `New project ${name}`, title: `Started ${name}`, force: true });
  return p;
}

/** Bring an existing folder in, in place: the folder becomes Y. */
export function adopt(folder, { who = 'owner', kind = 'adopt', title = null, why = null, note = null, notes = null, extraSkip = [], extra = {} } = {}) {
  folder = resolve(folder);
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${folder} is not a folder`);
  const mark = join(folder, '.xyz');
  if (existsSync(mark)) throw new Error(`${basename(folder)} is already in XYZ (home: ${readFileSync(mark, 'utf8').trim()}); see it with: xyz ${basename(folder)}`);
  const name = basename(folder), home = join(ROOT(), name);
  if (existsSync(home)) throw new Error(`a project called ${name} already exists at ${home}; rename the folder first`);
  mkdirSync(join(home, 'X'), { recursive: true }); mkdirSync(join(home, 'Z'), { recursive: true });
  symlinkSync(folder, join(home, 'Y'));
  writeConfig(home, { deps: existsSync(join(folder, 'node_modules')) ? ['node_modules'] : [], skip: extraSkip });
  writeAtomic(mark, home + '\n');
  writeAtomic(join(home, 'Z', 'NOTES.md'), notes ?? notesStarter(name, aboutFrom(folder)));
  const p = openProject(home);
  save(p, { kind, who, why: why ?? `Brought ${name} into XYZ where it is (${folder})`, title: title ?? `Brought ${name} into XYZ`, force: true, note, extra });
  return p;
}

/** First paragraph of a README, as a starting "what this is". */
export function aboutFrom(folder) {
  for (const f of ['README.md', 'readme.md', 'README.txt', 'README']) {
    const p = join(folder, f); if (!existsSync(p)) continue;
    const para = readFileSync(p, 'utf8').split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#') && !s.startsWith('![') && !s.startsWith('<'));
    if (para) return para.slice(0, 600);
  }
  return '';
}

/** Find a project: by loose name, or from where you are standing. */
export function resolveProject(query, cwd = process.cwd()) {
  if (!query) {
    for (let d = resolve(cwd); ; d = dirname(d)) {
      if (existsSync(join(d, '.xyz'))) return openProject(readFileSync(join(d, '.xyz'), 'utf8').trim());
      if (existsSync(join(d, 'xyz.json')) && existsSync(join(d, 'Z'))) return openProject(d);
      if (d === dirname(d)) return null;
    }
  }
  const q = squash(query), homes = allHomes();
  const named = homes.map(h => ({ h, k: squash(readConfig(h).name) }));
  const exact = named.filter(n => n.k === q);
  if (exact.length === 1) return openProject(exact[0].h);
  const part = named.filter(n => n.k.includes(q));
  if (part.length === 1) return openProject(part[0].h);
  if (part.length > 1) throw new Error(`"${query}" could be ${part.map(n => readConfig(n.h).name).join(', ')}; say which`);
  return null;
}

export function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
