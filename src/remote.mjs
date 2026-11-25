// `xyz test --remote`: the full suite on another machine — any server you can `ssh` into, or a Boat sandbox
// (boat.dev, reached through `boat ssh`). The tree you stand in (Y, a lane or a promote's check copy) goes over with
// rsync, XYZ goes with it, and so does this very Node binary (used there when the server can run it: same CPU and a
// glibc at least as new; otherwise the server's own `node`). The remote `xyz test` runs with its own buffer and its own
// queue: one full suite per project there at a time, beside the one here.
//
// The result comes back into Z/tests/last-remote.json ("Remote run" in `xyz arrive` and `xyz lanes`), never last.json:
// a machine without this one's paths or tools must not repaint the suite here. A remote promote check also writes
// last-check.json.
//
// Split runs: "localOnly" names the test files that need this machine (its drives, apps or tools). With it, a remote
// run sends every other file to the server and runs those here at the same time; together they are the whole suite,
// so the result is the suite's own (last.json), marked with where each part ran.
//
// On the server everything lives under ~/xyz-remote/: bin/node, xyz/ (the program), projects/<Name>/ (a small XYZ
// home: xyz.json, Z/ with the buffer and the queue, Y/ = the last tree sent, the base the next rsync copies from).
//
// Set up per project in xyz.json:
//   "tests": { "remote": { "host": "me@server" } }                    any SSH server (key login, rsync and sh there)
//   "tests": { "remote": { "boat": "bx_…" } }                          a Boat sandbox (needs the `boat` CLI, signed in)
//   ... "whenBusy": true                 a whole suite (or a promote's check) goes there when the queue here is busy
//   ... "localOnly": ["tests/gui-*.test.mjs"]   files that always run here, beside the remote part
//   xyz test --remote          run there now (--remote=me@server or --remote=bx_… for another)   --local: never there
// XYZ_REMOTE_SHELL stands in for ssh (the tests use a local one); then no Boat is woken or extended.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const XYZ_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LINKED = ['node_modules', '.venv', 'venv'];
const MARK = '@@xyz-remote@@';
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A target from a name: bx_… is a Boat sandbox, anything else an SSH host (user@server or a ~/.ssh/config name). */
export function targetOf(name) {
  name = String(name);
  if (/^bx_[\w-]+$/.test(name)) return { kind: 'boat', id: name, label: `Boat ${name}` };
  if (!/^[\w.@:%+-]+$/.test(name)) return null;
  return { kind: 'ssh', id: name, label: name };
}
const configured = (p) => { const r = p.config.tests?.remote ?? {}; return r.boat || r.host || null; };

/** Where this run should go, or null for here. --local wins; --remote[=name] / XYZ_TEST_REMOTE ask for it. */
export function remoteAsked(p, flags, fail) {
  if (flags.local) return null;
  const asked = flags.remote ?? process.env.XYZ_TEST_REMOTE;
  if (asked === undefined || asked === '' || asked === '0' || asked === false) return null;
  const name = asked === true || asked === '1' ? configured(p) : String(asked);
  if (!name) fail('--remote needs a server: --remote=me@server (or =bx_… for a Boat), or set xyz.json "tests": { "remote": { "host": "me@server" } }');
  const t = targetOf(name);
  if (!t) fail(`"${name}" is not a server name xyz can use (user@host, a name from ~/.ssh/config, or bx_… for a Boat)`);
  return t;
}

/** Where to go when the queue here is busy, or null. */
export const remoteWhenBusy = (p) => (p.config.tests?.remote?.whenBusy && configured(p) && targetOf(configured(p))) || null;

/** The patterns of files that always run here. */
export const localOnlyOf = (p) => [p.config.tests?.remote?.localOnly ?? []].flat().filter(Boolean);

const sshCmd = (t) => process.env.XYZ_REMOTE_SHELL ? [process.env.XYZ_REMOTE_SHELL]
  : t.kind === 'boat' ? ['boat', 'ssh'] : ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'];

// A Boat: wake it when stopped and keep it on long enough for a suite (resume and extend only; never create or resize).
function ready(t, say) {
  if (process.env.XYZ_REMOTE_SHELL || t.kind !== 'boat') return true;
  const info = spawnSync('boat', ['info', t.id, '--json'], { encoding: 'utf8', timeout: 60_000 });
  if (info.error) { say(`xyz: the boat command isn't available (${info.error.code}); install it from boat.dev or use an SSH host`); return false; }
  let sb = null; try { sb = JSON.parse(info.stdout).sandbox; } catch { /* unreadable */ }
  if (!sb) { say(`xyz: could not read ${t.label}: ${(info.stderr || info.stdout || '').trim().slice(0, 200)}`); return false; }
  if (sb.state === 'stopped' || sb.state === 'archived') {
    say(`xyz: ${t.label} is stopped; resuming it for this run`);
    const r = spawnSync('boat', ['resume', t.id], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 600_000 });
    if (r.status !== 0) { say(`xyz: could not resume ${t.label}`); return false; }
  }
  const left = Date.parse(sb.archiveAfter ?? '') - Date.now();
  if (Number.isFinite(left) && left < 90 * 60_000) spawnSync('boat', ['extend', t.id, '--hours', '2'], { stdio: 'ignore', timeout: 60_000 });
  return true;
}

function rsync(t, args, say) {
  const r = spawnSync('rsync', ['-e', sshCmd(t).map(q).join(' '), ...args], { encoding: 'utf8', timeout: 1800_000 });
  if (r.error) { say(`xyz: rsync isn't available here (${r.error.code}); install rsync`); return false; }
  if (r.status !== 0) say(`xyz: sending to ${t.label} failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
  return r.status === 0;
}

/**
 * Runs the suite (less any localOnly files) on the server. Returns { code, status } (status: the remote last.json, for a
 * whole run there), or null when the server could not be reached before anything ran — the caller may then run here.
 */
export async function runRemote(s, { p, target: t, who, whole, localOnly = [], prefix = '', say = (m) => console.error(m) }) {
  if (!ready(t, say)) return null;
  const id = `${Date.now()}-${process.pid}`;
  const name = p.name.replace(/[^\w.-]/g, '_');
  const home = `projects/${name}`;

  // 1. the program, this Node and the project's small home (symlinks followed: -L)
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-remote-'));
  try {
    fs.mkdirSync(path.join(stage, 'bin'));
    fs.symlinkSync(process.execPath, path.join(stage, 'bin', 'node'));
    fs.mkdirSync(path.join(stage, 'xyz'));
    for (const d of ['bin', 'src']) fs.symlinkSync(path.join(XYZ_DIR, d), path.join(stage, 'xyz', d));
    const ph = path.join(stage, home);
    fs.mkdirSync(path.join(ph, 'Y'), { recursive: true });
    fs.mkdirSync(path.join(ph, 'Z'));
    const tests = { ...(p.config.tests ?? {}) };
    delete tests.scratch; delete tests.remote;
    if (localOnly.length) tests.skipFiles = localOnly; // the remote's whole suite is everything but these
    fs.writeFileSync(path.join(ph, 'xyz.json'), JSON.stringify({ name: p.name, skip: [], deps: [], check: '', tests }, null, 2) + '\n');
    say(`xyz: sending XYZ and Node to ${t.label}…`);
    if (!rsync(t, ['-rtL', '--mkpath', `${stage}/`, `${t.id}:xyz-remote/`], say)) return null;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }

  // 2. the tree, copied there from the last tree sent where unchanged
  const keep = new Set([...LINKED, ...(p.config.deps ?? [])]);
  const excludes = ['.git', '.xyz', '.xyz-lane', ...(p.config.skip ?? []).filter((x) => !keep.has(x))];
  say(`xyz: sending ${path.basename(s.root)} to ${t.label}…`);
  if (!rsync(t, ['-rlptD', '--copy-unsafe-links', '--delete', '--mkpath', '--copy-dest=../../Y',
    ...excludes.map((x) => `--exclude=${x}`), `${s.root}/`, `${t.id}:xyz-remote/${home}/incoming/${id}/`], say)) return null;

  // 3. the run; the tree it ran becomes the base for the next one.
  // --local and a clean XYZ environment: the run there must never go anywhere else, nor think it is in a promote here.
  const args = ['test', '--local', ...(s.full ? ['--full'] : []), ...(s.bail ? ['--bail'] : []), ...(s.jobsAsked ? ['--jobs', String(s.jobs)] : []),
    '--max-age-hours', String(s.maxAgeHours), ...(whole ? [] : s.files)];
  const script = [
    `R="$HOME/xyz-remote"; H="$R/${home}"; IN="$H/incoming/${id}"`,
    `mkdir -p "$R/scratch"; printf '%s\\n' "$H" > "$IN/.xyz"; cd "$IN" || exit 0`,
    // our Node when this server can run it, else its own
    `N="$R/bin/node"; "$N" --version >/dev/null 2>&1 || N=node`,
    `echo ${MARK}start`,
    `env -u XYZ_TEST_REMOTE -u XYZ_TEST_REMOTE_FALLBACK -u XYZ_VERSION -u XYZ_IN_TURN -u XYZ_CHECK_COPY -u XYZ_HOME -u XYZ_Y -u XYZ_TEST_SCOPED PATH="$R/bin:$PATH" XYZ_ROOT="$R/projects" XYZ_TEST_SCRATCH="$R/scratch" XYZ_WHO=${q(who || 'agent')} "$N" "$R/xyz/bin/xyz.mjs" ${args.map(q).join(' ')}`,
    `rc=$?`,
    whole ? `[ -f "$H/Z/tests/last.json" ] && printf '${MARK}status %s\\n' "$(tr -d '\\n' < "$H/Z/tests/last.json")"` : ':',
    `rm -rf "$H/Y.old"; mv "$H/Y" "$H/Y.old" 2>/dev/null; mv "$IN" "$H/Y" && rm -rf "$H/Y.old"`,
    `echo ${MARK}exit $rc`,
  ].join('\n');
  say(`xyz: running on ${t.label}${whole ? ' (its own queue: one full suite per project there at a time)' : ''}`);

  const [cmd, ...pre] = sshCmd(t);
  const child = spawn(cmd, [...pre, t.id, script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const log = s.log ? fs.openSync(s.log, 'a') : null;
  let started = false, code = null, status = null, buf = '';
  const line = (l) => {
    if (l.startsWith(MARK)) {
      const rest = l.slice(MARK.length);
      if (rest === 'start') started = true;
      else if (rest.startsWith('exit ')) code = Number(rest.slice(5));
      else if (rest.startsWith('status ')) { try { status = JSON.parse(rest.slice(7)); } catch { /* none */ } }
      return;
    }
    console.log(prefix + l);
    if (log !== null) fs.writeSync(log, prefix + l + '\n');
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { buf += d; const parts = buf.split('\n'); buf = parts.pop(); parts.forEach(line); });
  const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const exit = await new Promise((r) => { child.on('error', (e) => r(e)); child.on('close', () => r(null)); });
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  if (buf) line(buf);
  if (log !== null) fs.closeSync(log);
  if (exit) { say(`xyz: could not start ${cmd} (${exit.code})`); return null; }
  if (!started) { say(`xyz: ${t.label} could not start the run`); return null; }
  if (code === null) { say(`xyz: lost ${t.label} during the run; counted as not passed`); return { code: 1, status: null }; }
  return { code, status };
}
