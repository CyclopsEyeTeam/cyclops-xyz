#!/usr/bin/env node
// xyz — keep local work as X (live), Y (source) and Z (memory). Run `xyz help`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProject, adopt, newProject, allHomes, readConfig } from '../src/project.mjs';
import { save } from '../src/save.mjs';
import { listReceipts, getReceipt, markdown } from '../src/receipts.mjs';
import { projectView, projectInfo, listView, listInfo } from '../src/view.mjs';

const COMMANDS = ['extract', 'changed', 'touch', 'arrive', 'map', 'lane', 'lanes', 'land', 'drop', 'new', 'adopt', 'convert', 'save', 'status', 'receipts', 'show', 'undo', 'try', 'test', 'promote', 'rollback', 'list', 'watch', 'help'];
const HELP = `xyz — keep your work as X (live), Y (source) and Z (memory)

  xyz                      everything about the project you're in (or the list, if you're not in one)
  xyz <project>            everything about one project: xyz my-app · xyz --my-app · xyz app
  xyz arrive               the short arrival brief for an agent (map, notes, what is moving)   (--hook: silent outside projects)
  xyz map [project]        refresh and show the project's map, Z/MAP.md (the auto-saver keeps it fresh)
  xyz lane "why"           your own numbered copy of Y (L1, L2…) so agents never mix their work
  xyz land ["why"]         inside a lane: merge it into Y in order, one receipt with only your files  (--keep)
  xyz lanes                the open lanes: who, what for, how much changed   (--all for closed ones too)
  xyz drop [L2] --yes      close a lane without landing (its last state stays in Z)
  xyz extract [project]    X, Y and Z in one .zip (to ~/XYZ/exports/; --to <file|folder>, --with-live)
  xyz list                 every project, with its latest receipt
  xyz new <Name>           start a new project with X, Y and Z        (--at <folder> to make it there)
  xyz adopt <folder>       bring a folder in where it is; it becomes Y
  xyz convert <folder>     bring a git folder in, keeping its story    (--dry-run to only look · --all [folder] · --include-online)
  xyz save "why"           keep how Y is now, with a receipt saying why   (--learned "<tip>" adds a line to the map)
  xyz receipts [n]         the latest receipts
  xyz show <receipt>       one receipt in full                         e.g. xyz show r-0042
  xyz undo <receipt>       reverse just that change, keep everything after it   (--yes, --skip-changed)
  xyz try "<command>"      run a command on a copy of Y in RAM, then clean up  e.g. xyz try "node --test"
  xyz test [files]         run the project's tests side by side; files unchanged since they passed count from the buffer
                           (--full, --bail, --jobs N, --log FILE; set up in xyz.json "tests", see xyz help test)
  xyz promote              check Y, then make it the live version in X
                           (--saved: only what's kept, checked on that copy · xyz promote r-0042: that receipt's state
                            · xyz promote L7, or xyz promote inside a lane: what's live + only that lane's work)
                           One check runs at a time per project; the others wait their turn and say who they wait for.
  xyz rollback             go back to the previous live version
  xyz changed              every unsaved file in Y and who last edited it
  xyz watch                save every project that changed (the auto-saver runs this every 15 min)
  xyz help                 this

Everywhere: --json for tools, --yes to never be asked, --who <name> to sign receipts, --wait to wait for a busy project (--wait=45m for at most that long).`;

// ---- arguments ----
const argv = process.argv.slice(2), flags = {}, pos = [];
const VALUE_FLAGS = new Set(['who', 'at', 'learned', 'to', 'jobs', 'log', 'max-age-hours']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--') && a.length > 2) { const [k, v] = a.slice(2).split(/=(.*)/s); if (v !== undefined) flags[k] = v; else if (VALUE_FLAGS.has(k)) flags[k] = argv[++i]; else flags[k] = true; }
  else pos.push(a);
}
const KNOWN = new Set(['to', 'with-live', 'saved', 'wait', 'keep', 'learned', 'hook', 'json', 'yes', 'who', 'at', 'all', 'dry-run', 'include-online', 'skip-changed', 'help', 'full', 'bail', 'jobs', 'log', 'max-age-hours', 'no-wait']);
const who = () => flags.who || process.env.XYZ_WHO || (process.stdin.isTTY ? 'owner' : 'agent');
const out = (obj, text) => console.log(flags.json ? JSON.stringify(obj, null, 2) : text);
const fail = msg => { console.error(`xyz: ${msg}`); process.exit(1); };

function here(query) {
  const p = resolveProject(query);
  if (!p) fail(query ? `no project called "${query}". See them all with: xyz list` : `you're not inside an XYZ project. Go into one, or name it: xyz <project>`);
  return p;
}

function didYouMean(word) {
  const d = (a, b) => { const m = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) m[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return m[a.length][b.length]; };
  const names = [...COMMANDS, ...allHomes().map(h => readConfig(h).name)];
  return names.map(n => [n, d(word.toLowerCase(), n.toLowerCase())]).sort((a, b) => a[1] - b[1]).filter(x => x[1] <= 3).slice(0, 2).map(x => x[0]);
}

async function main() {
  process.env.XYZ_LOCK_WHO ||= flags.who || process.env.XYZ_WHO || '';
  process.env.XYZ_LOCK_CMD = argv.join(' ').slice(0, 120);
  if (flags.wait) {
    // --wait: wait as long as the holder is alive (a dead holder's lock is cleared anyway); --wait=45m: at most that long
    const m = String(flags.wait).match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/);
    if (flags.wait !== true && !m) fail(`--wait takes a time like --wait=45m, --wait=2h or --wait=90s`);
    process.env.XYZ_LOCK_WAIT_MS = String(m ? Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6 }[m[2] ?? 'm'] : 24 * 3.6e6);
  }
  // `xyz --my-app`: an unknown --flag with no command is a project name
  const loose = Object.keys(flags).filter(k => !KNOWN.has(k));
  let [cmd, ...rest] = pos;
  if (!cmd && loose.length === 1) { cmd = loose[0]; delete flags[loose[0]]; }
  if (flags.help) cmd = 'help';

  if (['save', 'promote', 'rollback', 'undo', 'try', 'receipts', 'show'].includes(cmd)) {
    const { laneHere, checkpoint } = await import('../src/lane.mjs');
    const L = laneHere();
    if (L && L.lane.status !== 'open' && ['save', 'promote', 'rollback', 'undo', 'try'].includes(cmd)) fail(`lane ${L.lane.id} is already ${L.lane.status}${L.lane.receipt ? ` (${L.lane.receipt})` : ''}; this folder was only left because a shell was in it. Work in Y: cd ${L.p.y}`);
    if (L && cmd === 'save') {
      const why = rest.join(' ').trim(), n = checkpoint(L.p, L.lane, why || null);
      return out({ lane: L.lane.id, changed: n }, `Kept lane ${L.lane.id} in Z: ${n} file${n === 1 ? '' : 's'} changed from where it started.\n  When it's done: xyz land`);
    }
    if (L && cmd === 'promote') {
      // inside a lane: X = what's live + only this lane's work, checked on that copy
      if (rest[0] || flags.saved) fail(`inside lane ${L.lane.id}, xyz promote makes this lane's work live; run other promotes from Y`);
      const { promoteCli } = await import('../src/live.mjs'); return promoteCli({ p: L.p, rest, flags, who: who(), out, fail, lane: L.lane });
    }
    if (L && ['rollback', 'undo', 'try'].includes(cmd)) fail(`you're in lane ${L.lane.id}: land it first (xyz land), then ${cmd} from Y`);
  }
  switch (cmd) {
    case undefined: case 'status': {
      const p = resolveProject(rest[0]);
      if (!p) return out(listInfo(), listView());
      return out(projectInfo(p), projectView(p));
    }
    case 'help': {
      if (rest[0] === 'test') { const { fileURLToPath } = await import('node:url'); return console.log(readFileSync(fileURLToPath(new URL('../src/test.mjs', import.meta.url)), 'utf8').split('\nimport ')[0].replace(/^\/\/ ?/gm, '')); }
      return console.log(HELP);
    }
    case 'extract': { const { extractCli } = await import('../src/extract.mjs'); return extractCli({ p: here(rest[0] ?? null), flags, out }); }
    case 'changed': {
      const p = here(rest[0] ?? null), { changesNow, lastWriters } = await import('../src/save.mjs');
      const c = changesNow(p), w = lastWriters(p.z, c.last?.at ?? 0);
      const rows = [...c.changed.map(f => ['~', f]), ...c.added.map(f => ['+', f]), ...c.removed.map(f => ['-', f])].map(([k, f]) => ({ kind: k, file: f, by: w.get(f) ?? null }));
      return out(rows, rows.length ? rows.map(r => `${r.kind} ${r.file}${r.by ? `   — ${r.by}` : '   — (not known)'}`).join('\n') + `\n${rows.length} unsaved file${rows.length === 1 ? '' : 's'}` : 'Nothing unsaved in Y.');
    }
    case 'touch': {
      // PostToolUse hook: remember who edited which file, so the auto-saver can sign each agent's work
      if (!flags.hook) fail('touch is for the edit hook: xyz touch --hook (reads the hook JSON on stdin)');
      try {
        const { recordTouch } = await import('../src/save.mjs'), { realpathSync, existsSync } = await import('node:fs'), { dirname, relative } = await import('node:path');
        const ev = JSON.parse(readFileSync(0, 'utf8') || '{}'), file = ev.tool_input?.file_path ?? ev.tool_input?.notebook_path;
        if (!file) return;
        let dir = dirname(resolve(ev.cwd ?? '.', file)); while (!existsSync(dir)) dir = dirname(dir);
        const p = resolveProject(null, dir); if (!p) return;
        const abs = resolve(realpathSync(dir), relative(dir, resolve(ev.cwd ?? '.', file)));
        if (!abs.startsWith(p.y + '/')) return; // lanes and other folders keep their own record
        recordTouch(p.z, abs.slice(p.y.length + 1), process.env.XYZ_WHO || (ev.session_id ? `claude-${String(ev.session_id).slice(0, 4)}` : 'claude'));
      } catch {}
      return;
    }
    case 'lane': case 'lanes': case 'land': case 'drop': {
      const { laneCli } = await import('../src/lane.mjs');
      return laneCli({ cmd, rest, flags, who: who(), out, fail, here });
    }
    case 'arrive': {
      const { arriveCli } = await import('../src/arrive.mjs');
      return arriveCli({ query: rest[0], flags, out, fail });
    }
    case 'map': {
      const { refreshMap, mapFile } = await import('../src/map.mjs');
      const p = here(rest[0] ?? null); refreshMap(p);
      const text = readFileSync(mapFile(p), 'utf8');
      return out({ name: p.name, map: mapFile(p), text }, text.trimEnd());
    }
    case 'list': return out(listInfo(), listView());
    case 'new': {
      if (!rest[0]) fail('give it a name: xyz new <Name>');
      const p = newProject(rest.join(' '), { at: flags.at ?? null, who: who() });
      return out({ name: p.name, home: p.home }, `${p.name} is ready.\n  Y (work here): ${p.y}\n  X (live):      ${p.x}\n  Z (memory):    ${p.z}`);
    }
    case 'adopt': {
      if (!rest[0]) fail('which folder? xyz adopt <folder>');
      const p = adopt(resolve(rest[0]), { who: who() });
      return out({ name: p.name, home: p.home }, `${p.name} is in XYZ now, right where it was.\n  Y: ${p.y}\n  See it all: xyz ${p.name}`);
    }
    case 'convert': { const { convertCli } = await import('../src/convert.mjs'); return convertCli({ rest, flags, who: who(), out, fail }); }
    case 'save': {
      const p = here(null), why = rest.join(' ').trim();
      if (!why) fail('say why in a few words: xyz save "fixed the drawing crash"');
      let r;
      let learned = '';
      if (flags.learned) {
        try { const { learn } = await import('../src/map.mjs'); learn(p, flags.learned, who()); learned = '\n  Learned note added to the map (Z/MAP.md).'; }
        catch (e) { if (!['EACCES', 'EROFS', 'EPERM'].includes(e.code)) throw e; const { leavePending } = await import('../src/save.mjs'); leavePending(p, { why: '', who: who(), learned: flags.learned }); learned = '\n  Z is not writable from here: the learned note waits in Y for the auto-saver.'; }
      }
      try { r = save(p, { why, who: who() }); }
      catch (e) {
        if (!['EACCES', 'EROFS', 'EPERM'].includes(e.code)) throw e;
        const { leavePending } = await import('../src/save.mjs');
        leavePending(p, { why, who: who() });
        return out({ pending: true, why }, `Z can't be written from here (a sandbox?), so your note is waiting in Y.\n  The auto-saver turns it into a receipt within 15 minutes: "${why}"`);
      }
      return out(r, (r ? `Kept: ${r.id} — ${r.title}\n  ${r.changed.length} changed · ${r.added.length} added · ${r.removed.length} removed\n  Undo with: xyz undo ${r.id}` : 'Nothing changed since the last receipt; nothing to keep.') + learned);
    }
    case 'receipts': {
      const p = here(null), rs = listReceipts(p.z, Number(rest[0]) || 15);
      return out(rs, rs.map(r => `${r.id}  ${new Date(r.at).toLocaleString('en-GB').slice(0, 17)}  ${r.who.padEnd(10)} ${r.kind.padEnd(8)} ${r.title}`).join('\n') || 'No receipts yet.');
    }
    case 'show': {
      const p = here(null); if (!rest[0]) fail('which receipt? xyz show r-0001');
      const r = getReceipt(p.z, rest[0]);
      return out(r, markdown(r));
    }
    case 'undo': { const { undoCli } = await import('../src/undo.mjs'); return undoCli({ p: here(null), rest, flags, who: who(), out, fail }); }
    case 'test': {
      const { testCli } = await import('../src/test.mjs');
      return testCli({ p: here(null), rest, flags, who: flags.who || process.env.XYZ_WHO || null, fail });
    }
    case 'try': { const { tryCli } = await import('../src/try.mjs'); return tryCli({ p: here(null), rest, flags, who: who(), out, fail }); }
    case 'promote': case 'rollback': {
      if (cmd === 'promote' && !flags.saved && !rest[0]) {
        const { listLanes } = await import('../src/lane.mjs'); const p = here(null), open = listLanes(p);
        if (open.length) console.error(`xyz: note — ${open.length} lane${open.length === 1 ? ' is' : 's are'} still open (${open.map(l => l.id).join(', ')}); their work isn't in Y yet. Use --saved to promote only what's kept.`);
      } const L = await import('../src/live.mjs'); return L[`${cmd}Cli`]({ p: here(null), rest, flags, who: who(), out, fail }); }
    case 'watch': { const { watchOnce } = await import('../src/watch.mjs'); const rs = watchOnce({ who: flags.who || 'xyz-watch' }); return out(rs, rs.map(r => `${r.project}: ${r.error ? `⚠ ${r.error}` : r.receipt ? `kept ${r.receipt.id} (${r.receipt.title})` : 'no change'}`).join('\n') || 'No projects yet.'); }
    default: {
      const p = resolveProject(cmd);
      if (p) return out(projectInfo(p), projectView(p));
      const m = didYouMean(cmd);
      console.error(`xyz: "${cmd}" isn't a command or a project.${m.length ? ` Did you mean: ${m.join(' or ')}?` : ''}\n`);
      console.error(HELP); process.exit(1);
    }
  }
}

main().catch(e => fail(e.message));
