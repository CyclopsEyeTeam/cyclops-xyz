// Receipts: one readable markdown file each, plus one JSON line each in Z/receipts.jsonl. Never edited.
import { readFileSync, existsSync, appendFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';

const pad = n => String(n).padStart(2, '0');
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';
export const when = at => { const d = new Date(at); return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function nextId(z) {
  const f = join(z, 'counter');
  let c = 0; try { c = Number(readFileSync(f, 'utf8').trim()) || 0; } catch {}
  const top = listReceipts(z).reduce((m, r) => Math.max(m, Number(String(r.id).slice(2)) || 0), 0);
  const n = Math.max(c, top) + 1;
  writeAtomic(f, String(n));
  return `r-${String(n).padStart(4, '0')}`;
}

const list = (label, xs) => xs?.length ? `${label}: ${xs.slice(0, 40).join(' · ')}${xs.length > 40 ? ` · and ${xs.length - 40} more` : ''}\n` : '';

export function markdown(r) {
  return `# ${r.title}\n` +
    `when: ${when(r.at)} · who: ${r.who} · kind: ${r.kind} · id: ${r.id}\n` +
    (r.why ? `why: ${r.why}\n` : '') +
    list('changed', r.changed) + list('added', r.added) + list('removed', r.removed) +
    list('could not read', r.unreadable) +
    (r.tests ? `tests: ${r.tests}\n` : '') +
    (r.note ? `\n${r.note}\n` : '') +
    (['save', 'auto', 'undo', 'adopt', 'convert'].includes(r.kind) && r.before ? `undo: xyz undo ${r.id}\n` : '');
}

/** r: { id, kind, who, at, title, why?, snapshot, before, added, removed, changed, ... } */
export function writeReceipt(z, r) {
  const d = new Date(r.at);
  const rel = join('receipts', String(d.getFullYear()), pad(d.getMonth() + 1), `${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${slug(r.who)}-${r.id}-${slug(r.title)}.md`);
  const out = { ...r, file: join(z, rel) };
  writeAtomic(out.file, markdown(out));
  const idx = join(z, 'receipts.jsonl');
  let lead = ''; try { const st = statSync(idx); if (st.size) { const fd = openSync(idx, 'r'), b = Buffer.alloc(1); readSync(fd, b, 0, 1, st.size - 1); closeSync(fd); if (b[0] !== 10) lead = '\n'; } } catch {}
  appendFileSync(idx, lead + JSON.stringify(out) + '\n');
  return out;
}

export function listReceipts(z, n = Infinity) {
  const f = join(z, 'receipts.jsonl');
  if (!existsSync(f)) return [];
  const all = readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return all.reverse().slice(0, n);
}

export function getReceipt(z, id) {
  const want = /^\d+$/.test(id) ? `r-${String(id).padStart(4, '0')}` : id;
  const r = listReceipts(z).find(x => x.id === want);
  if (!r) throw new Error(`no receipt ${id} here; see them with: xyz receipts`);
  return r;
}
