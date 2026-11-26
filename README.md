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

## XYZ Manager

`desktop/xyz-manager.py` (in the app menu as **XYZ Manager** after `./install.sh`) shows every project on one
screen, most recently changed first: its description, what's live, unsaved files and open lanes, and its latest
receipt. Each project has buttons to open its **Source (Y)**, **Live (X)** and **Memory (Z)** folders, its notes,
and **Extract .zip**. It only reads and extracts; it never saves, promotes or changes a project. Projects are
ordered by last activity (receipts, signed edits, lanes, unsaved files) and the list refreshes itself. Needs
Python 3 with GTK 3 (standard on Mint, Ubuntu and Fedora desktops).

Its header shows an ASCII-art XYZ banner next to an eye: set `XYZ_EYE_HTML` to an animated eye page (an HTML/SVG
page; with WebKit2GTK it plays live in the header, paced to 24 frames a second, 6 in the background). Without one,
an ASCII eye stands in.

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

### Library or single

There are two ways to lay a project out. Pick one per project when you make it.

- **Library** (the default, `xyz new HelloXYZ`): every project lives in one XYZ folder, `~/XYZ`, and each
  one has `X/`, `Y/` and `Z/` side by side: `~/XYZ/HelloXYZ/{X,Y,Z}`.
- **Single** (`xyz new HelloXYZ --single`): one folder, made where you are, holds everything. The folder
  you make *is* X, the live app (`current` points at the live version, with the versions beside it).
  Y and Z are folders inside it:

```
HelloXYZ/          ← X: the live app
├── current        → versions/s-…   (what is live)
├── versions/
├── Y/             ← where you work
├── Z/             ← memory: receipts, undo, NOTES.md
└── xyz.json
```

Everything works the same in both: saving, promoting, rolling back, lanes, `xyz test`. A single project
still gets a small link in `~/XYZ`, so `xyz list`, the auto-saver and `xyz <name>` find it. Keep the
folder where you made it: its pieces point at each other by full path. `xyz extract` always exports a
project in the library layout.

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
| `xyz test [files]` | Run the project's tests side by side; a file unchanged since it last passed counts from the shared buffer (see below). `--remote` runs them on another machine over SSH (or a Boat sandbox). |
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
| `tests` | How `xyz test` finds and runs the test files (below). |
| `layout` | `"single"` for a project whose folder is X with Y and Z inside (set by `xyz new --single`); absent for the library layout. |

`XYZ_ROOT` moves the list of projects (default `~/XYZ`); `XYZ_RAM` moves the RAM copies.

## Working with AI agents

XYZ was built to be run by agents as much as by people. For bringing existing projects in (plain folders,
git repositories, work in progress, half-finished setups), agents can read [MIGRATING.md](MIGRATING.md).
[AGENTS.md](AGENTS.md) is a ready-made
instruction block: copy it into your agent's instructions (for example `~/.codex/AGENTS.md`, a
project's `AGENTS.md` or `CLAUDE.md`) and agents will look around with `xyz`, sign their own receipts
and keep `NOTES.md` current. In our first test, an agent told nothing about XYZ found it on its own,
read the notes, did its job and signed its receipt.

### Start every session the same way

Ask your agent to begin with these, before it reads any code:

```
xyz list      # every project: its latest change, unsaved files, what's live (single projects show their folder)
xyz           # inside a project: where X, Y and Z are, what's live, what's unsaved, the latest receipts
xyz arrive    # the agent's brief: what it is, how to run and test it, what's moving, the last suite run
```

A line you can paste: *"Start by running `xyz list`, then `xyz` and `xyz arrive` in the project, and tell
me what you see."* With the session-start hook installed (`xyz arrive --hook`), Claude Code gets the brief
by itself.

Which folder to start an agent in:

- **Library project:** its **Y** folder (`~/XYZ/<Name>/Y`, or wherever Y really lives). That's where the
  work happens, and every `xyz` command works from there.
- **Single project:** **the project folder itself**. Everything (X, Y, Z) is inside it, so an agent kept to
  that one folder (a sandbox) can still save, test and promote. Its `AGENTS.md` tells the agent to edit
  in `Y/`.

### Many agents at once: lanes

When several agents work on one project, each takes a lane: `xyz lane "team sharing"` copies Y (as it is
right now) to `~/XYZ/<project>/lanes/L1-team-sharing/`, with dependency folders linked, not copied. The agent
works there; the auto-saver keeps every open lane safe in Z. `xyz land` merges the lane into Y: files only the
lane changed are taken as they are, files changed on both sides are merged line by line, and if the same lines
changed on both sides nothing lands — the lane is moved on top of Y with the clash marked (or, for files that
can't be merged line by line, Y's version placed beside the lane's as `<file>.Y-L2`), and `xyz land` refuses
until every clash is settled. Lanes land one at a time, in the order they ask, so the second lane always merges on top of the first.
Each landing is one receipt signed by that agent, with only its files, and can be undone like any other.

A lane can also go live on its own: `xyz promote` inside the lane (or `xyz promote L7` from anywhere) makes a
version of what is live now plus only that lane's changes, checks that exact copy, and switches X to it. Other
agents' work in Y doesn't ride along. Until the lane lands, Y doesn't have that work, so a plain promote of Y
refuses (it would take it back out of X) and says which lane to land first.

Promote checks and whole-suite `xyz test` runs take turns: one full check per project at a time, in the order
they asked. A waiting one says whose check it is waiting for, and the test buffer makes the next check quick.

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

### Tests that remember: `xyz test`

`xyz test` runs each test file in fresh state, several side by side. While a file runs, a recorder notes
everything it depends on (modules loaded, files read, folders listed, scripts handed to other programs) in
every process it starts. When the file passes, a fingerprint of each is kept in `Z/test-buffer`, shared
by Y, every lane and promote's check copy. Next time, a file whose fingerprints all still match counts
from the buffer and only the rest run. One real suite went from 44 minutes to under 19 the first time, and
an unchanged rerun takes seconds. Only passes are kept, a pass older than a day runs again anyway, and a
file that fails beside others runs again alone before it counts as failed. The latest whole run lands in
`Z/tests/last.json`, which `xyz arrive` and `xyz lanes` show to every agent. Using it as the promote check
(`"check": "xyz test --bail"`) means promote reruns only what changed.

```json
"tests": {
  "files": "tests/*.test.mjs",
  "run": ["node", "--test", "{file}"],
  "recorder": "node",
  "salt": ["scripts/test.sh"],
  "jobs": 6, "maxAgeHours": 24
}
```

Every key is optional. `recorder` is `node` (Node test processes, fast), `strace` (any language and every
program, needs `strace`) or `none` (no buffer: just side by side and fresh state). `salt` lists files every
test depends on that the recorder cannot see, such as a wrapper script. `xyz help test` lists the rest
(`saltEnv`, `unsetEnv`, `env`, `ignore`, `scratch`, `memoryMax`). What it asks of your tests: one command runs
one file, files don't depend on each other, and nothing leans on the clock or the network beyond the max age.

### Full suites on another machine: `xyz test --remote`

A full suite can run on another computer: a spare PC, a cloud server, or a [Boat](https://boat.dev)
sandbox. Your own machine stays free, and two full checks can run at once, one here and one there.
There is nothing to register and no XYZ server to install. XYZ reaches the other machine over SSH and
copies over what it needs.

**What the other machine needs:** you can `ssh` into it without a password (an SSH key), and it has
`sh` and `rsync`. That's all. XYZ sends itself and your Node binary along. If the server's system can't
run that Node (different CPU, or an older Linux), it uses the server's own `node`. On your machine you
need `rsync` and `ssh`, or the `boat` CLI, signed in, for a Boat.

**Set it up once per project**, in the project's `xyz.json`:

```json
"tests": {
  "remote": { "host": "me@my-server" }
}
```

`host` is anything `ssh` accepts: `user@address`, or a name from your `~/.ssh/config`. For a Boat
sandbox, use `"boat": "bx_abc123"` instead; XYZ goes through `boat ssh`, wakes the sandbox if it's
stopped, and keeps it on for the run.

**Then:**

```bash
xyz test --remote               # the whole suite on that machine
xyz test --remote=me@other-box  # or on another one, just this time
xyz test --local                # never remote, whatever the settings say
```

The first run sends everything (and Node, about 100 MB); after that only changes travel, and a run
where nothing changed takes seconds. The server keeps its own test buffer and its own queue (one full
suite per project at a time) under `~/xyz-remote/`. Delete that folder to clean up.

**Two more settings:**

```json
"remote": {
  "host": "me@my-server",
  "whenBusy": true,
  "localOnly": ["tests/desktop-*.test.mjs", "tests/gpu.test.mjs"]
}
```

- `whenBusy`: when another agent's full suite is already running here, a whole-suite `xyz test` or
  a promote's check goes to the server instead of waiting. If the server can't be reached, it waits
  here as before.
- `localOnly`: test files that need *this* machine: its drives, installed apps, a display or a GPU.
  These run here while everything else runs there, both at once. Together they are the whole suite, and
  `xyz arrive` shows one result, e.g. `Tests: passed 7,720 · split: 26 here, 710 on me@my-server`.

**Where results go:** a run that was entirely remote is kept separately (`Z/tests/last-remote.json`,
the "Remote run" line in `xyz arrive`). A server without your drives or tools can't make your suite
look broken, and a pass there can't make it look fine. A split run is the whole suite, so it is your
suite's result. A promote check run remotely counts as the promote check.

**Finding out what needs your machine:** run `xyz test --remote` once. Files that fail there and pass
here are your `localOnly` list, or paths worth fixing.

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
