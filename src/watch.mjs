// The auto-saver: visit every project, keep what changed and refresh its map (Z/MAP.md). One broken project never stops the others.
import { basename } from 'node:path';
import { allHomes, openProject, readConfig } from './project.mjs';
import { save } from './save.mjs';
import { refreshMap, mapStale } from './map.mjs';
import { listLanes, checkpoint } from './lane.mjs';

export function watchOnce({ who = 'xyz-watch' } = {}) {
  return allHomes().map(h => {
    let name = basename(h); try { name = readConfig(h).name; } catch {}
    try {
      const p = openProject(h), receipt = save(p, { kind: 'auto', who });
      // keep the map fresh; a map that can't be written never stops the saver
      for (const l of listLanes(p)) { try { checkpoint(p, l); } catch {} } // lanes are kept safe too
      let map = false; try { if (receipt || mapStale(p)) map = refreshMap(p); } catch {}
      return { project: name, receipt, map };
    }
    catch (e) { return { project: name, receipt: null, error: e.message }; }
  });
}
