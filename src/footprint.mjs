// The footprint recorder for `xyz test` (src/test.mjs). The runner loads it with --import (through NODE_OPTIONS) into every
// Node process a test file starts, and it notes what that process depends on, one line per new thing, to the file
// XYZ_TEST_FOOTPRINT names:
//   f<TAB>path   a module it loaded or a file it read (the file's content counts)
//   e<TAB>path   a path it only checked (whether it exists, and as what, counts)
//   d<TAB>path   a folder it listed (the names in it count)
//   p<TAB>path   a script it handed to another program (python, bash...): that script and its same-kind neighbours count
// Lines are appended as they happen, so a process that is killed still leaves what it touched. Paths under the
// prefixes in XYZ_TEST_FOOTPRINT_IGNORE (the run's own temporary homes) and under /proc, /sys and /dev are not noted.
// Without XYZ_TEST_FOOTPRINT it does nothing. Programs that are not Node go unrecorded, so their test files never count
// from the buffer (they always run): the buffer only skips what it can vouch for.
//
// It is not named to --import directly: Node stops when an --import file is missing, and a sandboxed child (bwrap with
// tmpfs over most of the disk) cannot see this file. RECORDER_IMPORT is a small inline module that imports the recorder
// from XYZ_TEST_RECORDER and carries on quietly when it cannot; such a child just goes unrecorded.
// (Built in CyclopsCLI by the "full suite test buffering" session, 24 Nov 2026, and moved into XYZ.)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RECORDER_URL = pathToFileURL(fileURLToPath(import.meta.url)).href;
export const RECORDER_IMPORT = '--import=data:text/javascript;base64,'
  + Buffer.from('try{await import(process.env.XYZ_TEST_RECORDER)}catch{}').toString('base64');

const out = process.env.XYZ_TEST_FOOTPRINT;
if (out) install(out);

function install(out) {
  // Once per process, even when this file is reached by two URLs (a recorded `xyz test` that itself runs tests).
  const installed = Symbol.for('xyz.test.footprint');
  if (globalThis[installed]) return;
  globalThis[installed] = true;
  const self = fileURLToPath(import.meta.url);
  const ignore = ['/proc/', '/sys/', '/dev/', path.dirname(out) + '/',
    ...(process.env.XYZ_TEST_FOOTPRINT_IGNORE || '').split(':').filter(Boolean).map((p) => p.replace(/\/?$/, '/'))];
  // Under these only reads count: a listing or an existence probe of a shared temp folder changes all the time and would
  // make every file that touches it unbufferable for nothing (XYZ_TEST_FOOTPRINT_NOLIST, ':'-separated).
  const nolist = (process.env.XYZ_TEST_FOOTPRINT_NOLIST || '').split(':').filter(Boolean).map((p) => p.replace(/\/?$/, '/'));
  const append = fs.appendFileSync;
  const statSync = fs.statSync;
  const seen = new Set();

  const note = (kind, target, base) => {
    try {
      let p;
      if (typeof target === 'string') p = target;
      else if (target instanceof URL) { if (target.protocol !== 'file:') return; p = fileURLToPath(target); }
      else if (Buffer.isBuffer(target)) p = target.toString();
      else return; // a file descriptor or something else without a path
      if (p.startsWith('file:')) p = fileURLToPath(p);
      p = path.resolve(base || process.cwd(), p);
      if (p === self || ignore.some((prefix) => p.startsWith(prefix) || p + '/' === prefix)) return;
      if ((kind === 'd' || kind === 'e') && nolist.some((prefix) => p.startsWith(prefix) || p + '/' === prefix)) return;
      const key = kind + '\t' + p;
      if (seen.has(key)) return;
      seen.add(key);
      append(out, key + '\n');
    } catch { /* recording must never change what the test sees */ }
  };

  module.registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith('file:')) note('f', url);
      return nextLoad(url, context);
    },
  });

  const wrap = (owner, name, kind, isRead) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function (target, ...rest) {
      if (!isRead || isRead(rest)) note(kind, target);
      return original.call(this, target, ...rest);
    };
    Object.defineProperties(owner[name], Object.getOwnPropertyDescriptors(original));
  };
  const readOnly = (rest) => {
    const flags = rest[0];
    return flags === undefined || flags === null || typeof flags === 'function' || flags === 'r' || flags === 0;
  };
  for (const name of ['readFileSync', 'readFile', 'createReadStream']) wrap(fs, name, 'f');
  for (const name of ['openSync', 'open']) wrap(fs, name, 'f', readOnly);
  for (const name of ['existsSync', 'statSync', 'lstatSync', 'stat', 'lstat', 'accessSync', 'access', 'exists']) wrap(fs, name, 'e');
  for (const name of ['readdirSync', 'readdir', 'opendirSync', 'opendir']) wrap(fs, name, 'd');
  wrap(fsp, 'readFile', 'f');
  wrap(fsp, 'open', 'f', readOnly);
  for (const name of ['stat', 'lstat', 'access']) wrap(fsp, name, 'e');
  for (const name of ['readdir', 'opendir']) wrap(fsp, name, 'd');
  const copyFrom = (owner, name) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function (src, ...rest) { note('f', src); return original.call(this, src, ...rest); };
  };
  copyFrom(fs, 'copyFileSync'); copyFrom(fs, 'copyFile'); copyFrom(fsp, 'copyFile');

  // Children keep recording: an env given without our variables gets them back, and NODE_OPTIONS set by the code
  // under test keeps our --import. Script paths handed to other programs are noted too.
  const preload = RECORDER_IMPORT;
  const carry = (options) => {
    if (!options || typeof options !== 'object' || !options.env) return options;
    const env = { ...options.env };
    env.XYZ_TEST_FOOTPRINT ??= out;
    env.XYZ_TEST_RECORDER ??= RECORDER_URL;
    env.XYZ_TEST_FOOTPRINT_IGNORE ??= process.env.XYZ_TEST_FOOTPRINT_IGNORE;
    env.XYZ_TEST_FOOTPRINT_NOLIST ??= process.env.XYZ_TEST_FOOTPRINT_NOLIST;
    if (!String(env.NODE_OPTIONS || '').includes(preload)) env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} ${preload}`.trim();
    return { ...options, env };
  };
  const noteArgs = (args, options) => {
    const base = options && typeof options === 'object' && typeof options.cwd === 'string' ? options.cwd
      : options && typeof options === 'object' && options.cwd instanceof URL ? fileURLToPath(options.cwd) : undefined;
    for (const arg of args) {
      if (typeof arg !== 'string' || !arg.includes('/') && !/\.[a-z]{1,4}$/i.test(arg) || arg.startsWith('-')) continue;
      try {
        const p = path.resolve(base || process.cwd(), arg);
        if (statSync(p, { throwIfNoEntry: false })?.isFile()) note('p', p);
      } catch { /* not a path */ }
    }
  };
  // shape: where the options object sits. 'args' functions: (file, [args], [options], [cb]); 'cmd': (command, [options], [cb])
  const adjust = (shape, args) => {
    try {
      if (shape === 'cmd') {
        const i = args[1] && typeof args[1] === 'object' ? 1 : -1;
        noteArgs(String(args[0]).split(/\s+/), i === 1 ? args[1] : undefined);
        if (i === 1) args[1] = carry(args[1]);
      } else {
        const list = Array.isArray(args[1]) ? args[1] : [];
        const i = Array.isArray(args[1]) ? 2 : 1;
        const options = args[i] && typeof args[i] === 'object' && !Array.isArray(args[i]) ? args[i] : undefined;
        noteArgs([args[0], ...list], options);
        if (options) args[i] = carry(options);
      }
    } catch { /* leave the call as it was */ }
    return args;
  };
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const wrapChild = (name, shape) => {
    const original = cp[name];
    if (typeof original !== 'function') return;
    const wrapper = function (...args) { return original.apply(this, adjust(shape, args)); };
    // Keep what callers rely on, above all util.promisify's own version (execFile and exec resolve to { stdout, stderr }).
    Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original));
    if (typeof original[custom] === 'function') {
      const promised = original[custom];
      try { Object.defineProperty(wrapper, custom, { value: function (...args) { return promised.apply(this, adjust(shape, args)); }, configurable: true }); }
      catch { /* leave the copied one: it still resolves to { stdout, stderr } */ }
    }
    cp[name] = wrapper;
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) wrapChild(name, 'args');
  for (const name of ['exec', 'execSync']) wrapChild(name, 'cmd');
  module.syncBuiltinESMExports();
}
