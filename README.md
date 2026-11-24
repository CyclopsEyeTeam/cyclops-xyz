# XYZ — keep your work, skip the ceremony

> "When I started a few months ago I just thought git was a website you upload to."

XYZ is a small, friendly way to keep the things you make on your own computer: saved, explained and easy
to undo, with no commits, branches, staging or accounts. It was made for one person who just wanted to
create, and for anyone else whose bright idea got dimmed by version-control jargon.

Every project has three places:

| Place | What it is |
| --- | --- |
| **X — live** | The version you actually run. It only changes when you say `xyz promote`, and `xyz rollback` goes back. |
| **Y — source** | Your working folder. Make things here. |
| **Z — memory** | Receipts for every change, undo history, and one `NOTES.md` that says what the project is. |

Changes are kept **by themselves** every 15 minutes, and each one gets a **receipt** written in plain words:

```
# Fixed the drawing crash
when: Mon, 23 Nov 2026, 11:42 · who: claude · kind: save · id: r-0042
why: The home build leaves a canvas page with only bg + strokes; sleep drawing crashed on it.
changed: src/finger.mjs · added: tests/finger_page.test.mjs
undo: xyz undo r-0042
```

Undo reverses **just that change** and keeps everything you did after it. If a later change touched the
same file, XYZ stops and tells you who and what, instead of guessing. An undo can itself be undone.

## Install

You need **Linux**, **Node.js 22 or newer** and a terminal. No npm packages, no build step. Git is only
needed if you want to bring existing git projects in.

```sh
git clone https://github.com/CyclopsEyeTeam/cyclops-xyz.git ~/xyz
cd ~/xyz
./install.sh
```

The installer:

1. puts the `xyz` command in `~/.local/bin`;
2. offers the **auto-saver** (a systemd user timer that keeps every project's changes every 15 minutes);
3. offers **right-click menu items**: *Create XYZ project here* and *Bring into XYZ* (Nemo/Cinnamon), or
   *Bring into XYZ* under Scripts (Nautilus/GNOME Files);
4. looks through a folder you choose (default `~/Documents`), lists the projects it finds, and brings in
   the ones you pick. Git folders keep their `.git` folder untouched as an archive, and their last
   git messages go into the first receipt, so nothing is lost.

Run `./install.sh --pick` any time to bring more folders in, and `./uninstall.sh` to remove the command,
the auto-saver and the menu items. Uninstalling never touches your projects or their receipts.

## Your first project

```sh
xyz new HelloXYZ
cd ~/XYZ/HelloXYZ/Y
printf 'Hello, XYZ!\n' > hello.txt
xyz save "Added a first greeting"
xyz
```

`xyz` on its own shows everything about the project you're in: what it is, where X, Y and Z are, what
is live, what changed since the last receipt, and the latest receipts. From anywhere, `xyz <name>` does
the same for any project (`xyz hello`, `xyz --hello-xyz` and `xyz HelloXYZ` all work).

Already have a folder of work? Bring it in where it is: it becomes Y and nothing moves.

```sh
xyz adopt ~/Documents/MyGame        # any folder
xyz convert ~/Documents/MyWebsite   # a git folder: keeps its story
```

## Commands

| Command | What it does |
| --- | --- |
| `xyz` | Everything about the project you're in (or the list of projects, outside one). |
| `xyz <project>` | Everything about one project, by a loose name. |
| `xyz arrive` | A short brief for an agent arriving in the project: what it is, how to run and test it, where things live, what to be careful with, what is moving. `--hook` is silent outside projects. |
| `xyz map [project]` | Refresh and show the project's map, `Z/MAP.md`. |
| `xyz lane "why"` | Your own numbered copy of Y (L1, L2…), so several agents never mix their work. |
| `xyz land ["why"]` | Inside a lane: merge it into Y in landing order, with one receipt holding only its files. Clashing lines come back to the lane marked. |
| `xyz lanes` / `xyz drop --yes` | Who is working where / close a lane without landing (kept in Z). |
| `xyz changed` | Every unsaved file in Y and who last edited it. |
| `xyz promote --saved` / `xyz promote r-0042` | Ship only what is kept (checked on that exact copy) / ship that receipt's state. |
| `xyz extract [project]` | X, Y and Z in one `.zip`, laid out as a project home: unzip it into `~/XYZ` to bring the project back with its whole memory. Goes to `~/XYZ/exports/` (or `--to <file or folder>`); `--with-live` adds the live version. |
| `xyz list` | Every project, with its latest receipt. |
| `xyz new <Name>` | Start a project with X, Y and Z (`--at <folder>` to make it somewhere else). |
| `xyz adopt <folder>` | Bring a folder in where it is. |
| `xyz convert <folder>` | Bring a git folder in, keeping its last git messages. `--all <folder> --dry-run` previews many. |
| `xyz save "why"` | Keep how Y is now, with a receipt saying why. `--learned "<tip>"` leaves a line in the map. |
| `xyz receipts [n]` / `xyz show r-0042` | The latest receipts / one receipt in full. |
| `xyz undo r-0042` | Reverse just that change (shows what it will do and asks; `--yes` for scripts). |
| `xyz try "<command>"` | Run a command on a copy of Y in RAM (`/dev/shm`), then throw the copy away. |
| `xyz promote` / `xyz rollback` | Make Y the live version in X / go back to the previous one. |
| `xyz watch` | Save every project that changed and refresh its map (the auto-saver runs this). |
| `xyz help` | All of this, in the terminal. |

Sign receipts with `--who <name>` or `XYZ_WHO=<name>`. Every read command has `--json`.

## Settings

Each project home (`~/XYZ/<project>/`) has a small `xyz.json`:

| Setting | Purpose |
| --- | --- |
| `skip` | Extra files or folders to leave out. XYZ also reads your `.gitignore` files and always leaves out dependencies, databases, logs and lock files, so an undo never rewinds a running app's data. |
| `deps` | Folders such as `node_modules` copied into RAM tries and live versions. |
| `check` | A command that must pass before `xyz promote` (for example `npm test`). |
| `services` / `servicesFromX` | systemd user services to restart after a promote or rollback, once they run from `X/current`. |
| `tryMaxMB` | The largest project `xyz try` will copy into RAM (2048 by default). |

`XYZ_ROOT` moves the list of projects (default `~/XYZ`); `XYZ_RAM` moves the RAM copies.

## Working with AI agents

XYZ was built to be run by agents as much as by people. [AGENTS.md](AGENTS.md) is a ready-made
instruction block: copy it into your agent's instructions (for example `~/.codex/AGENTS.md`, a
project's `AGENTS.md` or `CLAUDE.md`) and agents will look around with `xyz`, sign their own receipts
and keep `NOTES.md` current. In our first test, an agent told nothing about XYZ found it on its own,
read the notes, did its job and signed its receipt.

### Many agents at once: lanes

When several agents work on one project, each takes a lane: `xyz lane "team sharing"` copies Y (as it is
right now) to `~/XYZ/<project>/lanes/L1-team-sharing/`, with dependency folders linked, not copied. The agent
works there; the auto-saver keeps every open lane safe in Z. `xyz land` merges the lane into Y: files only the
lane changed are taken as they are, files changed on both sides are merged line by line, and if the same lines
changed on both sides nothing lands — the lane is moved on top of Y with the clash marked (or, for files that
can't be merged line by line, Y's version placed beside the lane's as `<file>.Y-L2`), and `xyz land` refuses
until every clash is settled. Lanes land one at a time, in the order they ask, so the second lane always merges on top of the first.
Each landing is one receipt signed by that agent, with only its files, and can be undone like any other.

Agents that edit Y directly can still be told apart: a Claude Code PostToolUse hook (`xyz touch --hook`,
matcher `Edit|Write|MultiEdit|NotebookEdit`) signs each edited file, and the auto-saver then keeps one
receipt per agent. `xyz promote --saved` makes live only what is kept, so nobody's half-done files ship.

### Light from the first moment

Every project keeps a map, `Z/MAP.md`: how to run and test it, what each folder is for, warnings found
in its notes (HOLDs, "never", "do not"), the files changing most and the latest reasons. The auto-saver
refreshes the facts; everything under its `## Kept by hand` heading stays as written. `xyz arrive` turns
the map and the notes' "In progress" into a brief of about a thousand words, so an agent knows its way
around before it opens a single file. To give it to Claude Code at the start of every session, add a
hook to `~/.claude/settings.json`:

```json
"hooks": { "SessionStart": [ { "matcher": "startup|resume|clear|compact",
  "hooks": [ { "type": "command", "command": "xyz arrive --hook", "timeout": 10 } ] } ] }
```

Agents that run in a sandbox which can write the project folder but not Z still work: `xyz save` leaves
their note in Y, and the auto-saver turns it into a signed receipt.

## FAQ

**What if I delete a file by mistake?** If XYZ kept it before, it's in Z. Find the receipt that removed it
(`xyz receipts`, `xyz show <receipt>`) and `xyz undo <receipt>`. Files XYZ never saw need your Trash or a backup.

**Does it replace backups?** No. XYZ keeps history on this computer; copy your projects and `~/XYZ`
somewhere else too.

**Does it work with GitHub?** Converted folders keep their `.git` folder, so you can still push one by hand
when you want to share it. XYZ itself never talks to the internet.

## Working on XYZ

`bin/xyz.mjs` is the command, `src/` is the engine (Node built-ins only), `tests/` use Node's test runner:

```sh
node --test tests/*.test.mjs                       # works in $TMPDIR/xyz-tests
XYZ_TEST_ROOT=/some/scratch/dir node --test tests/*.test.mjs
```

## License

MIT — see [LICENSE](LICENSE).
