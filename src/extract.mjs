// `xyz extract`: a project's X, Y and Z in one .zip, laid out as a project home (<Name>/X, Y, Z, xyz.json), so
// unzipping it into the XYZ root (~/XYZ) gives back a working project with its whole memory.
// Y is taken as it is now (same skip rules as a save); Z whole (receipts, snapshots, store, notes, map, lanes);
// X as its history (every live version can be rebuilt from Z) — or, with --with-live, the live version too.
import { mkdtempSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync, existsSync, readdirSync, lstatSync, readlinkSync, statSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { scan } from './scan.mjs';
import { latestSnapshot } from './save.mjs';
import { listReceipts } from './receipts.mjs';
import { ROOT } from './project.mjs';

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const human = n => n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`;

/** Every file under dir, as paths relative to it (links listed, not followed). */
function walk(dir, rel = '', out = []) {
  for (const n of readdirSync(join(dir, rel))) {
    const r = rel ? `${rel}/${n}` : n, st = lstatSync(join(dir, r));
    if (st.isDirectory()) walk(dir, r, out); else out.push(r);
  }
  return out;
}

function readme(p, { live, unsaved }) {
  const rs = listReceipts(p.z, 1)[0];
  return `${p.name} — an XYZ project, extracted ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC

  ${p.name}/Y   the source, as it was when extracted${unsaved ? ` (it had ${unsaved} unsaved file${unsaved === 1 ? '' : 's'}; they are in Y here but not in a receipt)` : ''}
  ${p.name}/Z   the memory: ${listReceipts(p.z).length} receipts (latest ${rs ? `${rs.id}, "${rs.title}"` : 'none'}), every saved state, NOTES.md, MAP.md
  ${p.name}/X   ${live ? 'the live version and its history' : 'the live history; every live version can be rebuilt from Z (xyz promote r-NNNN)'}

To bring it back: unzip into your XYZ folder (normally ~/XYZ), then run: xyz ${p.name}
If a project called ${p.name} is already there, unzip somewhere else and move it in under a new name.
${p.config.services?.length ? `\nCareful: its settings (xyz.json) name services (${p.config.services.join(', ')}). A promote or rollback in a
restored copy on the same machine would restart them. In a second copy, empty "services" in xyz.json first.\n` : ''}`;
}

export function extract(p, { to = null, withLive = false } = {}) {
  if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status !== 0) throw new Error('extract needs the zip command (sudo apt install zip)');
  const name = p.name;
  let out = to ? resolve(to) : join(ROOT(), 'exports', `${name}-${stamp()}.zip`);
  if (to && existsSync(out) && statSync(out).isDirectory()) out = join(out, `${name}-${stamp()}.zip`);
  if (!out.endsWith('.zip')) out += '.zip';
  if (existsSync(out)) throw new Error(`${out} already exists`);
  const yReal = resolve(p.y);
  if (out.startsWith(yReal + '/')) throw new Error(`the zip can't go inside Y (${p.y}): it would end up in its own next save`);
  mkdirSync(dirname(out), { recursive: true });

  // a small stage: <name>/{Y,Z} link to the real folders; the small files are real copies
  const ram = process.env.XYZ_RAM || tmpdir(); mkdirSync(ram, { recursive: true });
  const stage = mkdtempSync(join(ram, 'xyz-extract-')), top = join(stage, name);
  try {
    mkdirSync(join(top, 'X'), { recursive: true });
    symlinkSync(yReal, join(top, 'Y')); symlinkSync(p.z, join(top, 'Z'));
    copyFileSync(join(p.home, 'xyz.json'), join(top, 'xyz.json'));
    if (existsSync(join(p.x, 'history.jsonl'))) copyFileSync(join(p.x, 'history.jsonl'), join(top, 'X', 'history.jsonl'));
    const list = ['xyz.json', 'README-XYZ.txt', ...(existsSync(join(top, 'X', 'history.jsonl')) ? ['X/history.jsonl'] : [])];
    // Y as it is now, with the same skip rules as a save (no node_modules, databases, logs…)
    const head = latestSnapshot(p.z), { files } = scan(p.y, p.z, { skip: p.config.skip ?? [], prev: head?.files ?? {} });
    const unsaved = head ? Object.keys(files).filter(k => !head.files[k] || head.files[k].hash !== files[k].hash || head.files[k].link !== files[k].link).length + Object.keys(head.files).filter(k => !files[k]).length : 0;
    for (const rel of Object.keys(files)) list.push(`Y/${rel}`);
    // Z whole, apart from a lock or half-written temp files
    for (const rel of walk(p.z)) if (rel !== 'lock' && !/\.tmp$|(^|\/)lock\.(takeover|release)/.test(rel)) list.push(`Z/${rel}`);
    let live = false;
    if (withLive) {
      let cur = null; try { cur = readlinkSync(join(p.x, 'current')); } catch {}
      if (cur) {
        symlinkSync(join(p.x, cur), join(top, 'X', 'live')); // X/live/... read through the link, stored as files
        symlinkSync('live', join(top, 'X', 'current'));
        const deps = new Set(p.config.deps ?? []); // dependency folders are reinstalled, not archived
        for (const rel of walk(join(p.x, cur))) if (!deps.has(rel.split('/')[0])) list.push(`X/live/${rel}`);
        list.push('X/current'); live = true;
      }
    }
    writeFileSync(join(top, 'README-XYZ.txt'), readme(p, { live, unsaved }));
    const z = spawnSync('zip', ['-q', '-y', '-@', out], { cwd: stage, input: list.map(r => `${name}/${r}`).join('\n') + '\n', encoding: 'utf8', maxBuffer: 64 << 20 });
    // -y keeps links inside Y as links; the stage's own Y/Z/live links are folders on the way, which zip reads through
    if (z.status !== 0) { rmSync(out, { force: true }); throw new Error(`zip failed (exit ${z.status}): ${String(z.stderr).trim().split('\n').slice(-3).join(' ')}`); }
    const t = spawnSync('unzip', ['-tq', out], { encoding: 'utf8' });
    if (t.status !== 0 && t.status !== null) { rmSync(out, { force: true }); throw new Error(`the zip didn't test clean, so it was removed: ${String(t.stdout + t.stderr).trim().slice(0, 300)}`); }
    return { file: out, size: statSync(out).size, files: list.length, y: Object.keys(files).length, receipts: listReceipts(p.z).length, unsaved, live };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function extractCli({ p, flags, out }) {
  const r = extract(p, { to: typeof flags.to === 'string' ? flags.to : null, withLive: !!flags['with-live'] });
  return out(r, `${p.name} extracted: ${r.file}\n  ${human(r.size)} · ${r.y} files from Y · ${r.receipts} receipts and every saved state from Z${r.live ? ' · the live version from X' : ''}${r.unsaved ? `\n  Y had ${r.unsaved} unsaved file${r.unsaved === 1 ? '' : 's'}: they're in the zip, but not in a receipt (xyz save first to keep them in Z too)` : ''}\n  To bring it back: unzip it into ${ROOT()} and run: xyz ${p.name}${p.config.services?.length ? `\n  Note: it names services (${p.config.services.join(', ')}); in a second copy on this machine, empty "services" in its xyz.json before promoting` : ''}`);
}
