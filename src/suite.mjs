// The project's last test-suite run, as the test runner leaves it in Z/tests/ (last.json: the latest run anywhere;
// last-check.json: the latest promote check). XYZ only reads these files; the project's own runner writes them.
// Any field may be missing, and a missing or broken file just means "nothing to show".
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const num = n => typeof n === 'number' ? n.toLocaleString('en-GB') : null;

function ago(at) {
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

function read(p, name) {
  const f = join(p.z, 'tests', name);
  if (!existsSync(f)) return null;
  try { const r = JSON.parse(readFileSync(f, 'utf8')); return r && typeof r === 'object' ? r : null; } catch { return null; }
}

export function suiteLine(r, label = 'Suite') {
  const passed = r.passed ?? (typeof r.fail === 'number' ? r.fail === 0 : null);
  const head = passed === true ? `passed${r.pass != null ? ` ${num(r.pass)}` : ''}`
    : passed === false ? `FAILED${r.fail != null ? ` ${num(r.fail)}` : ''}${Array.isArray(r.failedFiles) && r.failedFiles.length ? ` (${r.failedFiles.slice(0, 3).join(', ')}${r.failedFiles.length > 3 ? ', …' : ''})` : ''}`
    : 'ran';
  const loads = Object.values(r.failedLoad ?? {}).filter(n => typeof n === 'number');
  const bits = [r.cores && loads.some(n => n >= r.cores) ? `${head} under load ${Math.max(...loads)} on ${r.cores} cores` : head];
  if (r.full) bits.push('full run');
  else if (r.ran != null || r.fromBuffer != null) bits.push([r.ran != null && `${num(r.ran)} ran`, r.fromBuffer != null && `${num(r.fromBuffer)} buffered`].filter(Boolean).join(', '));
  const when = ago(r.at); if (when) bits.push(when);
  const where = [r.who, r.tree, /^v?\d+$/.test(String(r.version ?? '')) && `on v${String(r.version).replace(/^v/, '')}`].filter(Boolean).join(', ');
  if (where) bits.push(where);
  return `${label}: ${bits.join(' · ')}`;
}

/** Lines for the arrival brief and `xyz lanes`: the latest run, plus the latest promote check when it is a different run. */
export function suiteLines(p) {
  const last = read(p, 'last.json'), check = read(p, 'last-check.json');
  const out = [];
  if (last) out.push(suiteLine(last, 'Tests'));
  if (check && !(last && last.at === check.at && last.tree === check.tree)) out.push(suiteLine(check, 'Promote check'));
  return out;
}
