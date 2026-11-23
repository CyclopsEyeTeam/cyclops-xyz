// Z/store: every file's contents kept once, named by its sha256 fingerprint, gzip-compressed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';

export const fingerprint = buf => createHash('sha256').update(buf).digest('hex');
const blobPath = (z, h) => join(z, 'store', h.slice(0, 2), h.slice(2));

export function putBlob(z, buf) {
  const h = fingerprint(buf), p = blobPath(z, h);
  if (existsSync(p)) { try { getBlob(z, h); return h; } catch {} } // damaged: write it again
  writeAtomic(p, gzipSync(buf), 0o600);
  return h;
}

export function hasBlob(z, h) { return existsSync(blobPath(z, h)); }

export function getBlob(z, h) {
  let buf;
  try { buf = gunzipSync(readFileSync(blobPath(z, h))); } catch (e) { throw new Error(`store damaged: ${h} (${e.code ?? e.message})`); }
  if (fingerprint(buf) !== h) throw new Error(`store damaged: ${h}`);
  return buf;
}
