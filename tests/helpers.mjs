// Test helpers: every test works in a fresh folder on the scratch SSD, never in real projects.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

export const SCRATCH = process.env.XYZ_TEST_ROOT ?? join(tmpdir(), 'xyz-tests');
mkdirSync(SCRATCH, { recursive: true });

export function tmp(prefix = 't-') { return mkdtempSync(join(SCRATCH, prefix)); }

/** Write a tree of files: { 'a.txt': 'hi', 'src/b.js': 'x' } */
export function tree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body);
  }
  return root;
}

import { spawnSync } from 'node:child_process';
const BIN = new URL('../bin/xyz.mjs', import.meta.url).pathname;
/** Run the real xyz command with its own root and RAM folder. */
export function xyz(root, args, { cwd = root, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, XYZ_CHECK_COPY: '', XYZ_VERSION: '', XYZ_HOME: '', XYZ_Y: '', XYZ_IN_TURN: '', XYZ_ROOT: root, XYZ_RAM: join(root, '.ram'), XYZ_WHO: '', ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}
