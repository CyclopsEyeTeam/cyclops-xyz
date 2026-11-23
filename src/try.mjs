// Try in RAM: copy Y (and its installed packages) into memory, run a command there, then clean up.
import { mkdirSync, rmSync, cpSync, lstatSync, readdirSync, existsSync, appendFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { scan } from './scan.mjs';
import { latestSnapshot } from './save.mjs';

export const RAM = () => process.env.XYZ_RAM || '/dev/shm/xyz';

function dirBytes(d) {
  let n = 0;
  const walk = p => { let st; try { st = lstatSync(p); } catch { return; } if (st.isDirectory()) for (const k of readdirSync(p)) walk(join(p, k)); else n += st.size; };
  walk(d); return n;
}

export function trySize(p) {
  const { files } = scan(p.y, p.z, { skip: p.config.skip, prev: latestSnapshot(p.z)?.files ?? {} });
  let bytes = Object.values(files).reduce((a, f) => a + (f.size || 0), 0);
  for (const d of p.config.deps ?? []) if (existsSync(join(p.y, d))) bytes += dirBytes(join(p.y, d));
  return { files, bytes };
}

export function tryInRam(p, command, { who = 'agent', stdio = 'inherit' } = {}) {
  const { files, bytes } = trySize(p), mb = bytes / 1048576;
  if (mb > p.config.tryMaxMB) throw new Error(`Y is ${mb.toFixed(1)} MB, more than this project's RAM limit (${p.config.tryMaxMB} MB, "tryMaxMB" in xyz.json)`);
  const dir = join(RAM(), `${p.name}-${Date.now()}`);
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  const onSig = () => { cleanup(); process.exit(130); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  const t0 = Date.now();
  try {
    mkdirSync(dir, { recursive: true });
    for (const [rel, f] of Object.entries(files)) {
      const to = join(dir, rel); mkdirSync(dirname(to), { recursive: true });
      if (f.link !== undefined) symlinkSync(f.link, to); else cpSync(join(p.y, rel), to);
    }
    for (const d of p.config.deps ?? []) if (existsSync(join(p.y, d))) cpSync(join(p.y, d), join(dir, d), { recursive: true, verbatimSymlinks: true });
  } catch (e) { cleanup(); process.off('SIGINT', onSig); process.off('SIGTERM', onSig); throw e; }
  return new Promise(res => {
    const c = spawn('sh', ['-c', command], { cwd: dir, stdio, env: { ...process.env, XYZ_TRY: '1' } });
    c.on('close', code => {
      cleanup(); process.off('SIGINT', onSig); process.off('SIGTERM', onSig);
      const r = { at: Date.now(), who, command, ok: code === 0, code: code ?? 1, ms: Date.now() - t0, mb: Number(mb.toFixed(1)) };
      appendFileSync(join(p.z, 'tries.jsonl'), JSON.stringify(r) + '\n');
      res(r);
    });
  });
}

export async function tryCli({ p, rest, flags, who, out, fail }) {
  const command = rest.join(' ').trim();
  if (!command) fail('what should run? xyz try "node --test"');
  const r = await tryInRam(p, command, { who, stdio: flags.json ? ['ignore', 'ignore', 'ignore'] : 'inherit' });
  out(r, `\n${r.ok ? 'Passed' : `Failed (exit ${r.code})`} in RAM in ${(r.ms / 1000).toFixed(1)}s; the copy is gone.`);
  process.exitCode = r.code;
}
