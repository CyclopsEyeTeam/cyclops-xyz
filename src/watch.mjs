// The auto-saver: visit every project and keep what changed. One broken project never stops the others.
import { basename } from 'node:path';
import { allHomes, openProject, readConfig } from './project.mjs';
import { save } from './save.mjs';

export function watchOnce({ who = 'xyz-watch' } = {}) {
  return allHomes().map(h => {
    let name = basename(h); try { name = readConfig(h).name; } catch {}
    try { return { project: name, receipt: save(openProject(h), { kind: 'auto', who }) }; }
    catch (e) { return { project: name, receipt: null, error: e.message }; }
  });
}
