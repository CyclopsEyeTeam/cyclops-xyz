#!/usr/bin/env node
// xyz — keep local work as X (live), Y (source) and Z (memory). Run `xyz help`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProject, adopt, newProject, allHomes, readConfig } from '../src/project.mjs';
import { save } from '../src/save.mjs';
import { listReceipts, getReceipt, markdown } from '../src/receipts.mjs';
import { projectView, projectInfo, listView, listInfo } from '../src/view.mjs';

const COMMANDS = ['new', 'adopt', 'convert', 'save', 'status', 'receipts', 'show', 'undo', 'try', 'promote', 'rollback', 'list', 'watch', 'help'];
const HELP = `xyz — keep your work as X (live), Y (source) and Z (memory)

  xyz                      everything about the project you're in (or the list, if you're not in one)
  xyz <project>            everything about one project: xyz my-app · xyz --my-app · xyz app
  xyz list                 every project, with its latest receipt
  xyz new <Name>           start a new project with X, Y and Z        (--at <folder> to make it there)
  xyz adopt <folder>       bring a folder in where it is; it becomes Y
  xyz convert <folder>     bring a git folder in, keeping its story    (--all [folder] --dry-run --include-online)
  xyz save "why"           keep how Y is now, with a receipt saying why
  xyz receipts [n]         the latest receipts
  xyz show <receipt>       one receipt in full                         e.g. xyz show r-0042
  xyz undo <receipt>       reverse just that change, keep everything after it   (--yes, --skip-changed)
  xyz try "<command>"      run a command on a copy of Y in RAM, then clean up  e.g. xyz try "node --test"
  xyz promote              check Y, then make it the live version in X
  xyz rollback             go back to the previous live version
  xyz watch                save every project that changed (the auto-saver runs this every 15 min)
  xyz help                 this

Everywhere: --json for tools, --yes to never be asked, --who <name> to sign receipts.`;

// ---- arguments ----
const argv = process.argv.slice(2), flags = {}, pos = [];
const VALUE_FLAGS = new Set(['who', 'at']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--') && a.length > 2) { const k = a.slice(2); if (VALUE_FLAGS.has(k)) flags[k] = argv[++i]; else flags[k] = true; }
  else pos.push(a);
}
const KNOWN = new Set(['json', 'yes', 'who', 'at', 'all', 'dry-run', 'include-online', 'skip-changed', 'help']);
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
  // `xyz --my-app`: an unknown --flag with no command is a project name
  const loose = Object.keys(flags).filter(k => !KNOWN.has(k));
  let [cmd, ...rest] = pos;
  if (!cmd && loose.length === 1) { cmd = loose[0]; delete flags[loose[0]]; }
  if (flags.help) cmd = 'help';

  switch (cmd) {
    case undefined: case 'status': {
      const p = resolveProject(rest[0]);
      if (!p) return out(listInfo(), listView());
      return out(projectInfo(p), projectView(p));
    }
    case 'help': return console.log(HELP);
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
      try { r = save(p, { why, who: who() }); }
      catch (e) {
        if (!['EACCES', 'EROFS', 'EPERM'].includes(e.code)) throw e;
        const { leavePending } = await import('../src/save.mjs');
        leavePending(p, { why, who: who() });
        return out({ pending: true, why }, `Z can't be written from here (a sandbox?), so your note is waiting in Y.\n  The auto-saver turns it into a receipt within 15 minutes: "${why}"`);
      }
      return out(r, r ? `Kept: ${r.id} — ${r.title}\n  ${r.changed.length} changed · ${r.added.length} added · ${r.removed.length} removed\n  Undo with: xyz undo ${r.id}` : 'Nothing changed since the last receipt; nothing to keep.');
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
    case 'try': { const { tryCli } = await import('../src/try.mjs'); return tryCli({ p: here(null), rest, flags, who: who(), out, fail }); }
    case 'promote': case 'rollback': { const L = await import('../src/live.mjs'); return L[`${cmd}Cli`]({ p: here(null), rest, flags, who: who(), out, fail }); }
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
