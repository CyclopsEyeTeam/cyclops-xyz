// `xyz test`: the project's test files run side by side, and a file whose footprint has not changed since it last passed
// keeps that pass instead of running again. Built in CyclopsCLI by the "full suite test buffering" session (24 Nov 2026,
// 44 min serial → 18.7 min at 6 jobs, an unchanged rerun in 0.3 s) and moved into XYZ so every project has it.
//
//   xyz test [--full] [--jobs N] [--bail] [--log FILE] [--max-age-hours H] [file ...]
//
// The project says how in its xyz.json (all optional):
//   "tests": {
//     "files": "tests/*.test.mjs",              one pattern or a list (* is one folder level, ** any depth)
//     "run": ["node", "--test", "{file}"],      how one file runs (a list, or a string for sh -c); {file} is relative
//     "salt": ["scripts/test.sh"],              files the recorder cannot see that every test depends on (a wrapper)
//     "saltEnv": ["MY_FLAG"],                   environment variables every test depends on (TZ, LANG, LC_ALL always)
//     "unsetEnv": ["MY_HOME"],                  variables taken away before a file runs
//     "env": { "MY_SCRATCH": "{scratch}" },     variables given to every file ({scratch}, {work}, {tree} filled in)
//     "ignore": ["{scratch}/cyt"],              folders whose reads are never noted (shared temporary homes)
//     "scratch": "/fast/disk",                  where each run's own folder goes (else XYZ_TEST_SCRATCH, else the temp dir)
//     "recorder": "node",                       how a file's footprint is seen: "node" (Node processes, fast), "strace"
//                                               (any language, every process; needs strace, ~10–30% slower) or "none"
//                                               (no buffer: just side by side, fresh state each, failures judged alone)
//     "jobs": 6, "maxAgeHours": 24, "memoryMax": "20G"
//   }
//
// What it asks of the tests: one command runs one test file; files are independent of each other given fresh state; and
// nothing relies on the clock or the network beyond what the max age covers. (Prior art for the idea: Go's test cache,
// pytest-testmon.)
//
// Each file runs in its own XDG homes, so files cannot see each other's state. src/footprint.mjs rides along in every Node
// process the file starts and notes what it loads, reads, checks, lists and hands to other programs. When the file
// passes, a fingerprint of each of those is kept with the pass in Z/test-buffer, shared by Y, every lane and promote's
// check copy (paths inside the tree are kept relative). Next time, a file whose fingerprints all still match counts
// from the buffer; the rest run. What keeps it honest:
// - Only passes are kept; a failure always runs again. A pass is kept only when nothing it used changed while it ran.
// - The whole buffer starts over when Node, the salt files, the salt env or this runner's VERSION change.
// - A pass older than maxAgeHours (default 24) runs again anyway: the buffer cannot see the clock, the network, git, or
//   files read by programs that are not Node (beyond the scripts handed to them).
// - A file that fails beside others runs again alone; if it passes alone it is counted as passed and runs alone from
//   then on (load-sensitive). With --bail, nothing new starts after a file fails alone.
// - The latest whole-suite run goes to Z/tests/last.json (and last-check.json for promote's check), which `xyz arrive`
//   and `xyz lanes` show.
// - --full (or XYZ_TEST_FULL=1) ignores the buffer and refills it.
// - memoryMax runs the whole thing in a memory-capped systemd scope, when one is to be had.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { RECORDER_IMPORT, RECORDER_URL } from './footprint.mjs';

const VERSION = 2;

// --- where and how --------------------------------------------------------------------------------------------------------
/** The tree we stand in: the nearest folder with a .xyz file (Y, a lane, or promote's check copy). */
export function treeRoot(cwd = process.cwd()) {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.xyz'))) return d;
    if (d === path.dirname(d)) return null;
  }
}

function globRe(rest) {
  let re = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '*' && rest[i + 1] === '*') { i++; if (rest[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Test files the patterns match, relative to the tree root, sorted. */
export function findFiles(root, patterns) {
  const found = new Set();
  for (const pattern of [patterns].flat()) {
    const parts = pattern.split('/'), i = parts.findIndex(s => /[*?]/.test(s));
    if (i < 0) { if (fs.existsSync(path.join(root, pattern))) found.add(pattern); continue; }
    const base = parts.slice(0, i).join('/'), re = globRe(parts.slice(i).join('/'));
    const walk = (dir, rel) => {
      let names; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (re.test(r)) found.add(base ? `${base}/${r}` : r);
      }
    };
    walk(path.join(root, base), '');
  }
  return [...found].sort();
}

function settings(p, root, flags, files) {
  const c = p.config.tests ?? {};
  const num = (v, d) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d;
  const writable = d => { try { fs.accessSync(d, fs.constants.W_OK); return fs.statSync(d).isDirectory(); } catch { return false; } };
  const scratch = [process.env.XYZ_TEST_SCRATCH, c.scratch].find(d => d && writable(d)) || os.tmpdir();
  const all = findFiles(root, c.files ?? 'tests/*.test.mjs');
  return {
    c, root, p, scratch, all,
    files: files.length ? files.map(f => path.relative(root, path.resolve(f))) : all,
    full: !!flags.full || process.env.XYZ_TEST_FULL === '1',
    bail: !!flags.bail,
    log: typeof flags.log === 'string' ? path.resolve(flags.log) : null,
    jobs: Math.max(1, num(flags.jobs, num(process.env.XYZ_TEST_JOBS, num(c.jobs, Math.max(1, Math.min(6, os.availableParallelism() - 2)))))),
    maxAgeHours: num(flags['max-age-hours'], num(process.env.XYZ_TEST_MAX_AGE_HOURS, num(c.maxAgeHours, 24))),
    recorder: c.recorder ?? 'node',
    buffer: path.join(p.z, 'test-buffer'),
    status: path.join(p.z, 'tests'),
  };
}

// --- fingerprints -------------------------------------------------------------------------------------------------------
const sha = (data) => crypto.createHash('sha1').update(data).digest('hex').slice(0, 16);
const BIG = 16 * 1024 * 1024;

// Paths inside the tree are kept relative, so a pass recorded in a lane or a check copy counts in Y and back.
const keyer = (root) => ({
  toKey: (kind, abs) => { const rel = path.relative(root, abs); return kind + (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs); },
  fromKey: (key) => { const p = key.slice(1); return [key[0], path.isAbsolute(p) ? p : path.join(root, p)]; },
});

// Content, not mtime: lanes land by copying, so mtimes move while content stays. mtime is only for "changed while it ran".
function fingerprint(kind, abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return { hash: '-', mtime: 0 }; }
  const mtime = st.mtimeMs;
  try {
    if (kind === 'e') return { hash: st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o', mtime: 0 };
    if (kind === 'd' || st.isDirectory()) return { hash: st.isDirectory() ? 'D' + sha(fs.readdirSync(abs).sort().join('\0')) : 'nd', mtime };
    if (kind === 'p') {
      // The script and its neighbours of the same kind: what an interpreter that imports beside it may load.
      const dir = path.dirname(abs); const ext = path.extname(abs);
      const parts = fs.readdirSync(dir).filter((n) => ext && n.endsWith(ext)).sort()
        .map((n) => { const s = fs.statSync(path.join(dir, n)); return n + ':' + (s.size > BIG ? `${s.size}/${s.mtimeMs}` : sha(fs.readFileSync(path.join(dir, n)))); });
      return { hash: 'P' + sha(parts.join('\0') || fs.readFileSync(abs)), mtime: fs.statSync(dir).mtimeMs };
    }
    return { hash: st.size > BIG ? `S${st.size}/${st.mtimeMs}` : sha(fs.readFileSync(abs)), mtime };
  } catch { return { hash: '?', mtime }; }
}

class Prints {
  constructor(fromKey) { this.memo = new Map(); this.fromKey = fromKey; }
  get(key) {
    if (!this.memo.has(key)) { const [kind, abs] = this.fromKey(key); this.memo.set(key, fingerprint(kind, abs)); }
    return this.memo.get(key);
  }
  forget(key) { this.memo.delete(key); }
}

// What every file depends on without the recorder seeing it. Project files a test loads or reads (package.json,
// node_modules) are in its own footprint; keeping them out of here stops whole-buffer wipes.
function saltOf(s) {
  const parts = [`v${VERSION}`, s.recorder, process.version, process.platform, process.arch, JSON.stringify(s.c.run ?? null), JSON.stringify(s.c.env ?? null)];
  for (const f of s.c.salt ?? []) { try { parts.push(f + ':' + sha(fs.readFileSync(path.join(s.root, f)))); } catch { parts.push(f + ':-'); } }
  for (const k of [...(s.c.saltEnv ?? []), 'TZ', 'LANG', 'LC_ALL']) parts.push(k + '=' + (process.env[k] ?? ''));
  return sha(parts.join('\n'));
}

// --- the buffer ---------------------------------------------------------------------------------------------------------
const bufferFile = (dir) => path.join(dir, 'buffer.json');
export function loadBuffer(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(bufferFile(dir), 'utf8'));
    if (data.version === VERSION) return { entries: data.entries || {}, durations: data.durations || {}, alone: data.alone || {} };
  } catch { /* none yet, or unreadable: start over */ }
  return { entries: {}, durations: {}, alone: {} };
}
// Several runs (Y, a lane, a promote check) may share one buffer: merge with what is there now, newest pass winning.
function saveBuffer(dir, mine) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'buffer.lock');
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.rmdirSync(lock); } catch { /* gone already */ }
      if (Date.now() > deadline) throw new Error(`the buffer lock ${lock} stayed taken`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const now = loadBuffer(dir);
    for (const [file, entry] of Object.entries(mine.entries)) {
      if (entry === null) { if ((now.entries[file]?.at ?? 0) <= mine.dropped[file]) delete now.entries[file]; }
      else if (!now.entries[file] || now.entries[file].at <= entry.at) now.entries[file] = entry;
    }
    Object.assign(now.durations, mine.durations);
    Object.assign(now.alone, mine.alone);
    const tmp = path.join(dir, `buffer.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, ...now }));
    fs.renameSync(tmp, bufferFile(dir));
  } finally { fs.rmdirSync(lock); }
}

// Why a file has to run, or null when its buffered pass still holds.
function staleReason(entry, salt, prints, maxAgeMs) {
  if (!entry) return 'new';
  if (entry.salt !== salt) return 'setup changed';
  if (Date.now() - entry.at > maxAgeMs) return 'older than the max age';
  for (const [key, hash] of entry.deps) if (prints.get(key).hash !== hash) return 'changed: ' + key.slice(1);
  return null;
}

// --- running one file ---------------------------------------------------------------------------------------------------
// node --test prints "# tests N" (TAP) or "ℹ tests N" (spec); other runners just give an exit code.
function summaryOf(text) {
  const n = (name) => { const m = text.match(new RegExp(`^(?:#|ℹ) ${name} (\\d+(?:\\.\\d+)?)\\s*$`, 'm')); return m ? Number(m[1]) : 0; };
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped'), todo: n('todo'), cancelled: n('cancelled'), ms: n('duration_ms') };
}

const fill = (text, vars) => String(text).replace(/\{(scratch|work|tree|file)\}/g, (m, k) => vars[k] ?? m);

// work: this run's own folder for footprints and XDG homes, made BESIDE the project's scratch use, never above it
// (socket paths under the project's own temp folders are limited to about 108 bytes).
function runFile(s, file, work, index) {
  const state = path.join(work, `${index}`);
  fs.mkdirSync(state, { recursive: true });
  const footprint = path.join(state, 'footprint');
  const output = path.join(state, 'output.log');
  const vars = { scratch: s.scratch, work, tree: s.root, file };
  const env = { ...process.env };
  for (const k of [...(s.c.unsetEnv ?? []), 'NO_COLOR', 'NODE_TEST_CONTEXT']) delete env[k]; // NODE_TEST_CONTEXT: a nested node --test would talk to an outer runner
  const ignore = [work, ...(s.c.ignore ?? []).map(p => fill(p, vars))];
  const nolist = [os.tmpdir(), process.env.TMPDIR, ...(s.c.nolist ?? []).map(p => fill(p, vars))].filter(Boolean);
  Object.assign(env, Object.fromEntries(Object.entries(s.c.env ?? {}).map(([k, v]) => [k, fill(v, vars)])), {
    TERM: 'dumb', XDG_CONFIG_HOME: path.join(state, 'config'), XDG_STATE_HOME: path.join(state, 'state'), XDG_CACHE_HOME: path.join(state, 'cache'),
    XYZ_TEST_SCRATCH: s.scratch, XYZ_TEST_FOOTPRINT: footprint, XYZ_TEST_RECORDER: RECORDER_URL,
    XYZ_TEST_FOOTPRINT_IGNORE: ignore.join(':'), XYZ_TEST_FOOTPRINT_NOLIST: nolist.join(':'),
  });
  if (s.recorder === 'node') env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${RECORDER_IMPORT}`.trim();
  const run = s.c.run ?? ['node', '--test', '{file}'];
  let [cmd, args] = Array.isArray(run) ? [run[0], run.slice(1).map(a => fill(a, vars))] : ['sh', ['-c', fill(run, { ...vars, file: `'${file.replace(/'/g, `'\\''`)}'` })]];
  if (s.recorder === 'strace') { args = ['-f', '-qq', '-e', `trace=${STRACE_CALLS}`, '-o', `${footprint}.strace`, cmd, ...args]; cmd = 'strace'; }
  const fd = fs.openSync(output, 'w');
  const started = Date.now();
  // detached: its own process group, so an interrupt stops everything it started and its wrapper's traps clean up
  const child = spawn(cmd, args, { cwd: s.root, env, stdio: ['ignore', fd, fd], detached: true });
  fs.closeSync(fd);
  const done = new Promise((resolve) => {
    child.on('error', (e) => { fs.appendFileSync(output, `xyz test: could not start ${cmd}: ${e.message}\n`); resolve({ code: 127 }); });
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal }));
  });
  return { child, state, footprint, output, started, done, ignore, nolist };
}

// The strace recorder, for tests in any language (and for programs the Node recorder cannot see): what every process
// the file started opened, executed, checked or listed. Writes and failed opens for writing are not dependencies.
const STRACE_CALLS = 'open,openat,openat2,execve,execveat,stat,lstat,newfstatat,statx,access,faccessat,faccessat2,readlink,readlinkat';
function fromStrace(file, root, ignore, nolist) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const under = (p, list) => list.some(pre => p === pre.replace(/\/$/, '') || p.startsWith(pre.replace(/\/?$/, '/')));
  const skip = ['/proc', '/sys', '/dev', path.dirname(file), ...ignore];
  const lines = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^(?:\d+\s+)?(\w+)\((?:AT_FDCWD, |\d+<[^>]*>, )?"((?:[^"\\]|\\.)*)"(.*)\)\s+=\s+(-?\d+)/);
    if (!m) continue;
    const [, call, raw, rest, result] = m;
    let p; try { p = path.resolve(root, JSON.parse(`"${raw}"`)); } catch { continue; }
    if (under(p, skip)) continue;
    let kind;
    if (/^open/.test(call)) {
      if (/O_WRONLY|O_RDWR|O_CREAT|O_TRUNC/.test(rest)) continue;
      kind = /O_DIRECTORY/.test(rest) && Number(result) >= 0 ? 'd' : 'f';
      if (Number(result) < 0) kind = 'e'; // it looked and found nothing: that absence is a dependency
    } else if (/^execve/.test(call)) { if (Number(result) < 0) continue; kind = 'f'; }
    else kind = 'e';
    if ((kind === 'd' || kind === 'e') && under(p, nolist)) continue;
    lines.add(`${kind}\t${p}`);
  }
  return [...lines].join('\n');
}

function readFootprint(file, toKey, extra = '') {
  let text = extra;
  try { text += '\n' + fs.readFileSync(file, 'utf8'); } catch { /* none */ }
  const keys = new Set();
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab !== 1) continue;
    keys.add(toKey(line[0], line.slice(2)));
  }
  return [...keys].sort();
}

// The latest whole-suite run, for `xyz arrive` / `xyz lanes` and the next agent. Best effort: a run never fails over it.
function writeStatus(s, who, result) {
  // Only whole-suite runs: a spot check of two files must never read as "the suite passed".
  if (!sameFiles(s.files, s.all)) return;
  let lane = null;
  try { lane = JSON.parse(fs.readFileSync(path.join(s.root, '.xyz-lane'), 'utf8')); } catch { /* not a lane */ }
  let laneWho = null;
  if (lane?.id) { try { laneWho = JSON.parse(fs.readFileSync(path.join(s.p.z, 'lanes', lane.id, 'lane.json'), 'utf8')).who; } catch { /* unknown */ } }
  // Where we stand decides, not only an inherited variable: a project's own tests can run xyz inside a check.
  const tree = lane?.id ? `lane ${lane.id}` : s.root === s.p.y ? 'Y' : process.env.XYZ_CHECK_COPY ? 'check' : s.root;
  const status = { at: new Date().toISOString(), who: who || laneWho || null, version: process.env.XYZ_VERSION || null, tree, full: s.full, ...result };
  try {
    fs.mkdirSync(s.status, { recursive: true });
    for (const name of tree === 'check' ? ['last.json', 'last-check.json'] : ['last.json']) {
      const tmp = path.join(s.status, `${name}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
      fs.renameSync(tmp, path.join(s.status, name));
    }
  } catch (error) { console.error(`# could not write the run status: ${error.message}`); }
}
const sameFiles = (a, b) => a.length === b.length && [...a].sort().every((f, i) => f === [...b].sort()[i]);

// Runs this command again inside a memory-capped systemd scope; its exit code, or null when there is no cap or no scope.
function inMemoryScope(s) {
  const max = process.env.XYZ_TEST_MEMORY_MAX ?? s.c.memoryMax ?? '0';
  if (!max || max === '0' || process.env.XYZ_TEST_SCOPED === '1') return null;
  const scope = ['--user', '--scope', '--quiet', '-p', `MemoryMax=${max}`, '-p', 'MemorySwapMax=0'];
  // probe first: a missing user bus must not look like a test failure
  if (spawnSync('systemd-run', [...scope, 'true'], { stdio: 'ignore' }).status !== 0) return null;
  const inner = spawnSync('systemd-run', [...scope, process.execPath, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, XYZ_TEST_SCOPED: '1' } });
  return inner.status ?? 130;
}

// --- the run ------------------------------------------------------------------------------------------------------------
export async function testCli({ p, rest, flags, who, fail }) {
  const root = treeRoot() ?? p.y;
  const s = settings(p, root, flags, rest);
  if (!s.files.length) fail(`no test files match ${JSON.stringify(s.c.files ?? 'tests/*.test.mjs')} in ${root}. Say where they are in xyz.json: "tests": { "files": "..." }`);
  for (const f of s.files) if (!fs.existsSync(path.join(root, f))) fail(`no test file ${f} in ${root}`);
  if (!['node', 'strace', 'none'].includes(s.recorder)) fail(`xyz.json tests.recorder is "${s.recorder}"; it can be "node", "strace" or "none"`);
  if (s.recorder === 'strace' && spawnSync('strace', ['-V'], { stdio: 'ignore' }).status !== 0) fail('tests.recorder is "strace" but strace is not installed (sudo apt install strace), or use "node" / "none"');
  const scoped = inMemoryScope(s);
  if (scoped !== null) { process.exitCode = scoped; return; }

  const { toKey, fromKey } = keyer(root);
  const salt = saltOf(s);
  const buffer = loadBuffer(s.buffer);
  const prints = new Prints(fromKey);
  const maxAgeMs = s.maxAgeHours * 3600_000;
  const mine = { entries: {}, dropped: {}, durations: {}, alone: {} };

  const work = fs.mkdtempSync(path.join(s.scratch, 'xyzt-'));
  const log = s.log ? (fs.mkdirSync(path.dirname(s.log), { recursive: true }), fs.openSync(s.log, 'a')) : null;
  const say = (line) => { console.log(line); if (log !== null) fs.writeSync(log, line + '\n'); };

  const fromBuffer = [];
  const toRun = [];
  for (const file of s.files) {
    const reason = s.full ? 'full run' : staleReason(buffer.entries[file], salt, prints, maxAgeMs);
    if (reason) toRun.push({ file, reason }); else fromBuffer.push(file);
  }
  const expected = (f) => buffer.durations[f] ?? 30_000; // an unknown file starts early, in case it is a long one
  const together = toRun.filter((t) => !buffer.alone[t.file]).sort((a, b) => expected(b.file) - expected(a.file));
  const alone = toRun.filter((t) => buffer.alone[t.file]);
  say(`# xyz test: ${s.files.length} files — ${fromBuffer.length} from the buffer, ${toRun.length} to run (${together.length} side by side on ${s.jobs} jobs, ${alone.length} alone)`);
  for (const t of toRun.slice(0, 40)) say(`#   run ${t.file}: ${t.reason}`);
  if (toRun.length > 40) say(`#   ...and ${toRun.length - 40} more`);

  const results = new Map(); // file -> { ok, summary, loadSensitive }
  const running = new Set();
  const retry = []; // failed beside others: judged alone
  let index = 0;
  let paused = false; // --bail: start nothing new beside others until the failures are judged alone
  let halted = false; // a failure alone with --bail, or an interrupt
  let interrupted = false;
  let finished = 0;
  const t0 = Date.now();
  // The terminal gets failures and a line every tenth of the way; the log gets every file.
  const note = (line) => { if (log !== null) fs.writeSync(log, line + '\n'); };
  const progress = () => {
    finished++;
    const step = Math.max(1, Math.round(toRun.length / 10));
    if (finished % step === 0 || finished === toRun.length) console.log(`# ${finished}/${toRun.length} run · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  };

  const keep = (file, run, summary) => {
    const keys = readFootprint(run.footprint, toKey, s.recorder === 'strace' ? fromStrace(`${run.footprint}.strace`, s.root, run.ignore, run.nolist) : '');
    mine.durations[file] = summary.ms || Date.now() - run.started;
    const deps = [];
    for (const key of keys) {
      const print = prints.get(key);
      // Changed while the file ran (or after): this pass cannot vouch for what is there now.
      if (print.mtime >= run.started - 1000) { prints.forget(key); return 'changed while it ran: ' + key.slice(1); }
      deps.push([key, print.hash]);
    }
    if (s.recorder === 'none') return null;
    if (!deps.some(([key]) => key === 'f' + file)) return `no footprint was recorded${s.recorder === 'node' ? ' (not run by Node? try "recorder": "strace")' : ''}`;
    mine.entries[file] = { salt, at: run.started, tests: summary.tests, pass: summary.pass, skipped: summary.skipped, todo: summary.todo, ms: mine.durations[file], deps };
    return null;
  };

  const finish = async (task, run, isAlone) => {
    const { code } = await run.done;
    running.delete(run);
    const text = fs.readFileSync(run.output, 'utf8');
    const summary = summaryOf(text);
    const ok = code === 0 && summary.fail === 0 && !interrupted;
    if (log !== null) fs.writeSync(log, `# xyz test: ${task.file}${isAlone ? ' (alone)' : ''}\n${text}`);
    if (ok) {
      const notKept = keep(task.file, run, summary);
      const loadSensitive = isAlone && task.failedTogether;
      if (loadSensitive) mine.alone[task.file] = true;
      results.set(task.file, { ok: true, summary, loadSensitive });
      const line = `ok   ${task.file} (${((summary.ms || Date.now() - run.started) / 1000).toFixed(1)}s, ${summary.tests} tests${loadSensitive ? ', failed beside others, passed alone' : ''}${notKept ? `; not buffered: ${notKept}` : ''})`;
      if (loadSensitive) say(line); else note(line);
      progress();
    } else if (!isAlone && !interrupted && s.jobs > 1) {
      task.failedTogether = true;
      retry.push(task);
      say(`again ${task.file} failed beside others (exit ${code}, ${summary.fail} failing); it runs again alone`);
      if (s.bail) paused = true;
    } else {
      mine.entries[task.file] = null; mine.dropped[task.file] = Date.now();
      results.set(task.file, { ok: false, summary, output: run.output });
      say(`FAIL ${task.file} (exit ${code}, ${summary.fail} failing)`);
      if (s.bail) halted = true;
      progress();
    }
  };

  const stopAll = () => { for (const run of running) { try { process.kill(-run.child.pid, 'SIGTERM'); } catch { /* gone */ } } };
  const onSignal = () => { interrupted = true; halted = true; stopAll(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const runAlone = async (task) => {
    const run = runFile(s, task.file, work, ++index);
    running.add(run);
    await finish(task, run, true);
  };
  // Side by side, longest first. With --bail, a failure beside others pauses new starts until it has been judged alone;
  // only a failure alone stops the rest.
  while (!halted) {
    paused = false;
    await new Promise((resolve) => {
      const next = () => {
        while (!halted && !paused && running.size < s.jobs && together.length) {
          const task = together.shift();
          const run = runFile(s, task.file, work, ++index);
          running.add(run);
          finish(task, run, false).then(next, (error) => { say(`error ${task.file}: ${error.stack || error}`); halted = true; next(); });
        }
        if (!running.size) resolve();
      };
      next();
    });
    while (retry.length && !halted) await runAlone(retry.shift());
    if (!together.length) break;
  }
  for (const task of alone) { if (halted) break; await runAlone(task); }
  while (retry.length && !halted) await runAlone(retry.shift());

  saveBuffer(s.buffer, mine);

  const ran = [...results.values()];
  const failed = [...results.entries()].filter(([, r]) => !r.ok);
  const notRun = s.files.filter((f) => !results.has(f) && !fromBuffer.includes(f));
  const total = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 };
  for (const r of ran) for (const k of Object.keys(total)) total[k] += r.summary[k] || 0;
  const projected = { tests: 0, pass: 0, skipped: 0, todo: 0 };
  for (const f of fromBuffer) { const e = buffer.entries[f]; for (const k of Object.keys(projected)) projected[k] += e[k] || 0; }
  for (const [file, r] of failed) {
    say(`\n# ---- ${file} ----`);
    say(fs.readFileSync(r.output, 'utf8').split('\n').slice(-200).join('\n'));
  }
  const passed = !failed.length && !notRun.length && !interrupted;
  const loadSensitive = ran.filter((r) => r.loadSensitive).length;
  say(`\n# ran ${ran.length} files: ${total.tests} tests, ${total.pass} pass, ${total.fail} fail, ${total.skipped} skipped, ${total.todo} todo${loadSensitive ? `; ${loadSensitive} passed only alone` : ''}`);
  say(`# from the buffer ${fromBuffer.length} files: ${projected.tests} tests, ${projected.pass} pass (unchanged since they passed)`);
  if (notRun.length) say(`# not run (stopped): ${notRun.length} files`);
  say(`# suite: ${total.tests + projected.tests} tests, ${total.pass + projected.pass} pass, ${total.fail} fail · ${((Date.now() - t0) / 1000).toFixed(0)}s · ${passed ? 'passed' : 'NOT PASSED'}`);
  writeStatus(s, who, {
    files: s.files.length, ran: ran.length, fromBuffer: fromBuffer.length, notRun: notRun.length,
    tests: total.tests + projected.tests, pass: total.pass + projected.pass, fail: total.fail,
    failedFiles: failed.map(([file]) => file), passedOnlyAlone: loadSensitive,
    seconds: Math.round((Date.now() - t0) / 1000), passed, interrupted,
  });

  if (process.env.XYZ_TEST_KEEP === '1') say(`# kept ${work}`);
  else { try { fs.rmSync(work, { recursive: true, force: true }); } catch (error) { console.error(`# could not remove ${work}: ${error.message}`); } }
  if (log !== null) fs.closeSync(log);
  process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  process.exitCode = interrupted ? 130 : failed.length || notRun.length ? 1 : 0;
}
