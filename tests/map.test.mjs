import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, tree, xyz } from './helpers.mjs';

function project() {
  const root = tmp('root-'), work = tmp('work-');
  const folder = tree(join(work, 'MapApp'), {
    'README.md': '# Map App\n\nDraws maps for lost agents.\n',
    'package.json': JSON.stringify({ name: 'map-app', scripts: { start: 'node src/server.mjs', test: 'node --test tests/' }, bin: { mapapp: 'bin/mapapp.mjs' } }),
    'src/server.mjs': '// Serves the map over HTTP.\nexport {};\n',
    'src/draw.mjs': '// Turns a tree of files into a picture.\n',
    'bin/mapapp.mjs': '#!/usr/bin/env node\n// The mapapp command.\n',
    'tests/a.test.mjs': 'x',
    'AGENTS.md': '# Rules\n\n- Never touch data/ without asking: it is the only copy.\n',
  });
  xyz(root, ['adopt', folder, '--who', 'claude']);
  return { root, folder, map: join(root, 'MapApp', 'Z', 'MAP.md') };
}

test('xyz map writes Z/MAP.md with run, test, folders and warnings', () => {
  const { root, folder, map } = project();
  const r = xyz(root, ['map'], { cwd: folder });
  assert.equal(r.code, 0, r.out);
  const m = readFileSync(map, 'utf8');
  assert.match(m, /Draws maps for lost agents/);
  assert.match(m, /run: npm run start/);
  assert.match(m, /test: npm run test/);
  assert.match(m, /bin mapapp/);
  assert.match(m, /`src\/` \(2\) — Serves the map over HTTP/);
  assert.match(m, /Never touch data\//);
  assert.match(m, /## Kept by hand/);
});

test('refreshing keeps what was written by hand, and an unchanged project is not rewritten', () => {
  const { root, folder, map } = project();
  xyz(root, ['map'], { cwd: folder });
  writeFileSync(map, readFileSync(map, 'utf8') + '- the build needs FOO=1\n');
  writeFileSync(join(folder, 'src', 'new.mjs'), '// A new piece.\n');
  xyz(root, ['save', 'added a piece'], { cwd: folder });
  xyz(root, ['map'], { cwd: folder });
  const m = readFileSync(map, 'utf8');
  assert.match(m, /the build needs FOO=1/);
  assert.match(m, /`src\/` \(3\)/);
  assert.match(m, /added a piece/);
  const before = readFileSync(map, 'utf8');
  xyz(root, ['map'], { cwd: folder });
  assert.equal(readFileSync(map, 'utf8'), before);
});

test('save --learned leaves a dated line in the map', () => {
  const { root, folder, map } = project();
  writeFileSync(join(folder, 'src', 'draw.mjs'), '// changed\n');
  const r = xyz(root, ['save', 'fixed drawing', '--who', 'claude', '--learned', 'tests need MAP_HOME set'], { cwd: folder });
  assert.equal(r.code, 0, r.out);
  const m = readFileSync(map, 'utf8');
  assert.match(m, /\d{4}-\d\d-\d\d claude: tests need MAP_HOME set/);
  assert.doesNotMatch(m, /Anything the next agent/);
  xyz(root, ['map'], { cwd: folder });
  assert.match(readFileSync(map, 'utf8'), /tests need MAP_HOME set/);
});

test('arrive gives a short brief inside a project, and --hook is silent outside one', () => {
  const { root, folder, map } = project();
  const r = xyz(root, ['arrive'], { cwd: join(folder, 'src') });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /You are in MapApp/);
  assert.match(r.out, /Run and test/);
  assert.match(r.out, /Where things live/);
  assert.match(r.out, /Unsaved in Y: nothing/);
  assert.ok(r.out.length < 6000, `brief is ${r.out.length} chars`);
  assert.ok(existsSync(map), 'arrive makes the map when it is missing');
  const out = xyz(root, ['arrive', '--hook'], { cwd: tmp('nowhere-') });
  assert.equal(out.code, 0); assert.equal(out.out, '');
  assert.equal(xyz(root, ['arrive'], { cwd: tmp('nowhere-') }).code, 1);
});

test('the auto-saver refreshes maps', () => {
  const { root, folder, map } = project();
  assert.ok(!existsSync(map));
  writeFileSync(join(folder, 'src', 'draw.mjs'), '// changed again\n');
  const r = xyz(root, ['watch', '--json']);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(map));
  assert.match(readFileSync(map, 'utf8'), /draw\.mjs \(1×\)/);
});
