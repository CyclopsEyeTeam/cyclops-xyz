// Every write goes to a temp file in the same folder, is flushed to disk, then renamed into place.
import { openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

let n = 0;
export function fsyncDir(d) { try { const fd = openSync(d, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch {} }

export function writeAtomic(path, data, mode) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const t = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${n++}.tmp`);
  try {
    const fd = openSync(t, 'w', mode ?? 0o666);
    try { const buf = typeof data === 'string' ? Buffer.from(data) : data; let off = 0; while (off < buf.length) off += writeSync(fd, buf, off); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (mode !== undefined) chmodSync(t, mode);
    renameSync(t, path);
  } catch (e) { try { unlinkSync(t); } catch {} throw e; }
  fsyncDir(dir);
}
