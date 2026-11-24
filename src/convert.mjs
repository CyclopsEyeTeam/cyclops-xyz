// Converting git folders: bring them in where they are, keep their story, leave .git as a read-only archive.
import { readdirSync, lstatSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { adopt, aboutFrom, ROOT } from './project.mjs';

const NO_DESCEND = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.tmp']);
const git = (cwd, ...a) => { try { return execFileSync('git', ['-c', 'core.quotepath=off', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim(); } catch { return ''; } };
const companionHome = p => p.startsWith(join(homedir(), '.local', 'share') + '/'); // app data, never projects
const releaseCopy = p => /\/(outputs|public-release|releases?)\//.test(p + '/') || /-source\//.test(p + '/');

function sizeMB(dir) {
  let n = 0;
  const w = p => { let es; try { es = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of es) { if (e.isDirectory()) { if (!NO_DESCEND.has(e.name)) w(join(p, e.name)); } else if (e.isFile()) { try { n += statSync(join(p, e.name)).size; } catch {} } } };
  w(dir); return Math.round(n / 1048576 * 10) / 10;
}

/** Remote without its address details (addresses can carry tokens): "origin (github.com)". */
function remoteOf(path) {
  const name = git(path, 'remote').split('\n')[0]; if (!name) return null;
  const url = git(path, 'remote', 'get-url', name);
  const host = (url.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)/i) ?? url.match(/^[^@]+@([^:]+):/))?.[1] ?? 'somewhere';
  return `${name} (${host})`;
}

export function findGitFolders(root, { maxDepth = 4 } = {}) {
  root = resolve(root); const found = [];
  const walk = (dir, depth) => {
    if (companionHome(dir)) return;
    const g = join(dir, '.git');
    let st = null; try { st = lstatSync(g); } catch {}
    if (st) {
      const nested = found.some(f => f.kind === 'repo' && dir.startsWith(f.path + '/'));
      found.push({ path: dir, name: basename(dir), kind: st.isDirectory() ? (releaseCopy(dir) ? 'release-copy' : 'repo') : 'worktree-link', nested });
    }
    if (depth >= maxDepth) return;
    let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) if (e.isDirectory() && !NO_DESCEND.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return found;
}

/** A real git folder: git agrees its own .git is this one (an empty or broken .git makes git look elsewhere). */
export const workingGit = path => git(path, 'rev-parse', '--absolute-git-dir') === join(resolve(path), '.git');

export function gitStory(path) {
  const log = git(path, 'log', '-10', '--format=%ct%x09%an%x09%s').split('\n').filter(Boolean).map(l => { const [t, who, ...m] = l.split('\t'); return { at: Number(t) * 1000, who, msg: m.join('\t') }; });
  const unsaved = git(path, 'status', '--porcelain').split('\n').filter(Boolean).length;
  return { lastAt: log[0]?.at ?? null, lastWho: log[0]?.who ?? null, messages: log.map(l => l.msg), unsaved };
}

function notesFor(folder, story) {
  const about = aboutFrom(folder), name = basename(folder);
  const docs = readdirSync(folder).filter(f => /\.(md|txt)$/i.test(f) && statSync(join(folder, f)).isFile()).sort();
  const subDocs = existsSync(join(folder, 'docs')) ? ['docs/'] : [];
  return `# ${name}\n\n${about || 'What this is, in a sentence or two.'}\n\n## How it runs\n\n(How to start it, where it lives, which services.)\n\n## In progress\n\n(What someone is working on right now, and what is next.)\n\n` +
    `## Older notes (left where they are)\n\n${[...docs, ...subDocs].map(d => `- [${d}](${join(folder, d)})`).join('\n') || '- none'}\n\n` +
    `## Before XYZ\n\nThis project used git until ${story.lastAt ? new Date(story.lastAt).toDateString() : 'it was converted'}. Its old history is still readable in \`.git\` (left as an archive).\n\n` +
    `## For the next person\n\nRun \`xyz ${name}\` to see everything about this project. Work in Y. When you finish something, \`xyz save "why"\`. Don't commit to git here.\n`;
}

export function convert(path, { includeOnline = false, who = 'agent', all = null, dryRun = false } = {}) {
  path = resolve(path);
  const g = join(path, '.git');
  if (dryRun) {
    // the same checks as the real thing, and nothing changed
    if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new Error(`${path} is not a folder`);
    if (existsSync(join(path, '.xyz'))) throw new Error(`${basename(path)} is already in XYZ (home: ${readFileSync(join(path, '.xyz'), 'utf8').trim()})`);
    if (existsSync(join(ROOT(), basename(path)))) throw new Error(`a project called ${basename(path)} already exists at ${join(ROOT(), basename(path))}; rename the folder first`);
  }
  if (!existsSync(g)) return dryRun ? { dryRun: true, name: basename(path), path, how: 'adopt (no git here)' } : adopt(path, { who });
  if (!lstatSync(g).isDirectory()) throw new Error(`${basename(path)} is a git worktree link (its history lives elsewhere); convert the main folder instead, or bring this folder in as it is with: xyz adopt ${path}`);
  if (!workingGit(path)) throw new Error(`${basename(path)}/.git is not a working git folder (empty or broken); use: xyz adopt ${path}`);
  if (existsSync(join(path, '.xyz'))) throw new Error(`${basename(path)} is already in XYZ (home: ${readFileSync(join(path, '.xyz'), 'utf8').trim()})`);
  const remote = remoteOf(path);
  if (remote && !includeOnline) throw new Error(`${basename(path)} has an online copy (${remote}); converting would stop it being kept up to date there. Add --include-online to bring it in anyway`);
  const kids = (all ?? findGitFolders(path)).filter(f => f.path !== path && f.path.startsWith(path + '/')).map(f => relative(path, f.path) + '/');
  const s = gitStory(path);
  if (dryRun) return { dryRun: true, name: basename(path), path, how: 'convert from git', lastSaved: s.lastAt ? new Date(s.lastAt).toLocaleString('en-GB') : null, unsaved: s.unsaved, messages: s.messages.slice(0, 5), leftOut: kids, remote };
  const note = `Before XYZ (git): last saved ${s.lastAt ? new Date(s.lastAt).toLocaleString('en-GB') : 'never'}${s.lastWho ? ` by ${s.lastWho}` : ''}; ${s.unsaved} unsaved file${s.unsaved === 1 ? '' : 's'} at conversion (all kept in this first snapshot).\n` +
    (s.messages.length ? `Last git messages:\n${s.messages.map(m => `  - ${m}`).join('\n')}\n` : '') +
    (kids.length ? `Git folders inside, left out of this project (not kept by XYZ until converted on their own): ${kids.join(', ')}\n` : '') +
    (remote ? `Online copy: ${remote}\n` : '') +
    `The old history stays readable in .git, left as it is.`;
  return adopt(path, { who, kind: 'convert', title: `Brought ${basename(path)} in from git`, why: `Converted from git, in place (${path})`, note, notes: notesFor(path, s), extraSkip: kids, extra: { git: { ...s, remote } } });
}

export function convertAll(root, { dryRun = false, includeOnline = false, who = 'agent' } = {}) {
  root = resolve(root);
  const all = findGitFolders(root), plan = { convert: [], inside: [], skipped: [], converted: [], failed: [] };
  const top = [];
  for (const f of all) {
    if (f.path === root) continue; // never the folder being looked through
    if (top.some(t => f.path.startsWith(t + '/'))) { plan.inside.push({ path: f.path, parent: top.find(t => f.path.startsWith(t + '/')) }); continue; }
    if (f.kind === 'worktree-link') { plan.skipped.push({ path: f.path, reason: 'worktree link' }); continue; }
    if (f.kind === 'release-copy') { plan.skipped.push({ path: f.path, reason: 'release copy' }); continue; }
    if (!workingGit(f.path)) { plan.skipped.push({ path: f.path, reason: 'not a working git folder (empty or broken .git)' }); continue; }
    top.push(f.path);
    if (existsSync(join(f.path, '.xyz'))) { plan.skipped.push({ path: f.path, reason: 'already in XYZ' }); continue; }
    const remote = remoteOf(f.path);
    if (remote && !includeOnline) { plan.skipped.push({ path: f.path, reason: `online copy: ${remote}` }); continue; }
    plan.convert.push({ name: f.name, path: f.path, sizeMB: sizeMB(f.path), unsaved: gitStory(f.path).unsaved });
  }
  if (dryRun) return plan;
  for (const c of plan.convert) {
    try { const p = convert(c.path, { includeOnline, who, all }); plan.converted.push({ name: p.name, path: c.path }); }
    catch (e) { plan.failed.push({ path: c.path, reason: e.message }); }
  }
  return plan;
}

export function convertCli({ rest, flags, who, out, fail }) {
  if (flags.all) {
    const root = resolve(rest[0] || join(homedir(), 'Documents'));
    const r = convertAll(root, { dryRun: !!flags['dry-run'], includeOnline: !!flags['include-online'], who });
    const L = [];
    L.push(flags['dry-run'] ? `Would bring in ${r.convert.length} git folder${r.convert.length === 1 ? '' : 's'} (nothing changed yet):` : `Brought in ${r.converted.length}:`);
    for (const c of flags['dry-run'] ? r.convert : r.converted) {
      const info = r.convert.find(x => x.path === c.path);
      L.push(`  ${c.name.padEnd(34)} ${String(info?.sizeMB ?? '').padStart(7)} MB  ${info?.unsaved ? `${info.unsaved} unsaved` : ''}${info?.sizeMB > 1024 ? '  (big: lots of data in it)' : ''}`);
    }
    if (r.inside.length) {
      const byParent = {}; for (const i of r.inside) byParent[i.parent] = (byParent[i.parent] ?? 0) + 1;
      L.push('', 'Git folders inside those projects (left out of the parent; convert one by name if it is a real project):');
      for (const [par, n] of Object.entries(byParent)) L.push(`  ${n} inside ${basename(par)}`);
    }
    if (r.failed.length) { L.push('', 'Could not bring in:'); for (const f of r.failed) L.push(`  ${f.path}: ${f.reason}`); }
    if (r.skipped.length) { L.push('', 'Left alone:'); for (const s of r.skipped) L.push(`  ${s.path} — ${s.reason}`); }
    return out(r, L.join('\n'));
  }
  if (!rest[0]) fail('which folder? xyz convert <folder>   or all of them: xyz convert --all [folder] --dry-run');
  const p = convert(rest[0], { includeOnline: !!flags['include-online'], who, dryRun: !!flags['dry-run'] });
  if (p.dryRun) return out(p, `Would bring ${p.name} into XYZ (${p.how}), right where it is; nothing changed yet.\n  ${p.path}${p.lastSaved ? `\n  Last git save: ${p.lastSaved}; ${p.unsaved} unsaved file${p.unsaved === 1 ? '' : 's'} (they'd all be kept)` : ''}${p.leftOut?.length ? `\n  Git folders inside, left out: ${p.leftOut.join(', ')}` : ''}${p.remote ? `\n  It has an online copy (${p.remote}): add --include-online to convert it anyway` : ''}\n  Do it with: xyz convert ${p.path}`);
  out({ name: p.name, home: p.home }, `${p.name} is in XYZ now, right where it was. Its git story is in the first receipt.\n  See it all: xyz ${p.name}`);
}
