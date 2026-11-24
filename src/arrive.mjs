// `xyz arrive`: the brief an agent gets the moment it starts in a project. With --hook (for session-start
// hooks) it says nothing outside XYZ projects and never fails the session.
import { resolveProject } from './project.mjs';
import { arrive } from './map.mjs';
import { liveInfo } from './view.mjs';
import { changesNow } from './save.mjs';
import { laneHere, laneLines } from './lane.mjs';

export function arriveCli({ query, flags, out, fail }) {
  let p;
  try { p = resolveProject(query ?? null); } catch (e) { if (flags.hook) return; throw e; }
  if (!p) { if (flags.hook) return; return fail(query ? `no project called "${query}"` : `you're not inside an XYZ project. Go into one, or name it: xyz arrive <project>`); }
  try {
    const lv = liveInfo(p);
    const live = lv.current ? `Live: ${lv.label ?? lv.current} (xyz promote / xyz rollback)` : 'Live: nothing promoted yet';
    let unsaved = null;
    try { const c = changesNow(p), n = c.added.length + c.removed.length + c.changed.length; unsaved = n ? `Unsaved in Y: ${n} file${n === 1 ? '' : 's'} since the last receipt (xyz shows which)` : 'Unsaved in Y: nothing'; } catch {}
    let lanes = []; try { lanes = laneLines(p); } catch {}
    let here = null; try { here = laneHere(); } catch {}
    let text = arrive(p, { unsaved, live });
    const extra = [];
    if (here) extra.push(`▸ You are in lane ${here.lane.id} ("${here.lane.why}", ${here.lane.who}). Work here; \`xyz land\` merges it into Y in order.`);
    if (lanes.length) extra.push(`▸ Open lanes (other agents at work)\n${lanes.join('\n')}`);
    extra.push(here ? '' : 'Working alongside other agents? Take your own lane first: xyz lane "what for" — then xyz land when done.');
    text = text.replace(/\n\nWhen you finish a piece:/, `\n\n${extra.filter(Boolean).join('\n\n')}\n\nWhen you finish a piece:`);
    return out({ name: p.name, text }, text);
  } catch (e) { if (flags.hook) return; throw e; }
}
