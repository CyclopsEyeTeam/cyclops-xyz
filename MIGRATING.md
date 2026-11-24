# Migrating to XYZ — a note for AI agents

Read this when you arrive in a project that isn't in XYZ yet, or that is part-way there: a plain folder, a git
repository with work in progress, a git worktree, or a folder whose XYZ setup looks broken. It tells you how to
look, what to ask, and how to bring a project in without losing anything. For day-to-day work inside a project
that is already in XYZ, read [AGENTS.md](AGENTS.md).

## First: the one rule

**Bringing a folder into XYZ is the person's decision, not yours.** Look, describe what you found, and ask.
Once they say yes for a folder, do the steps below for that folder only. A yes for one project is not a yes
for another.

## 1. Look before you change anything

Run these and read the answers:

```bash
xyz list                       # is it already a project? (names match loosely: xyz <name>)
ls -a <folder>                 # is there a .xyz file (in XYZ) or a .git folder/file (git)?
xyz convert <folder> --dry-run # what XYZ would do, with every safety check, changing nothing
```

Also check that nobody else is working in the folder right now (recent edits, other sessions). Converting
under another agent's feet mixes their work into the first receipt.

## 2. Work out which case you're in

| What you see | What it means | What to do (after a yes) |
|---|---|---|
| No `.xyz`, no `.git` | a plain folder | `xyz adopt <folder> --who <you>` |
| `.git` folder, no `.xyz` | a git project | `xyz convert <folder> --who <you>` (keeps the last git messages in the first receipt) |
| `.git` is a *file* (a worktree link) | its history lives in another folder | convert the main folder instead, or `xyz adopt <folder>` to keep just this checkout |
| `.git` but git says it's broken or empty | not a usable repository | `xyz adopt <folder>` (the `.git` is left alone as an archive) |
| A git project with an online remote | converting stops pushes from here | tell the person; convert only with `--include-online` once they agree |
| `.xyz` present, and `xyz` shows the project | already in XYZ | nothing to migrate: read the brief (`xyz arrive`) and work |
| `.xyz` present, but `xyz` says the home is missing | a half-finished or moved setup | **stop and ask**; don't delete the `.xyz` and don't re-adopt over it |

## 3. Mid-way projects: work in progress

Projects are often migrated in the middle of something. None of this needs cleaning up first:

- **Uncommitted git changes** are kept: convert takes the folder exactly as it is, and the first receipt
  records how many files were unsaved in git at the time.
- **Untracked files** come in too, except what the skip rules leave out on purpose: dependencies
  (`node_modules`, `.venv`), `.git`, databases, logs, lock files and anything in the project's `.gitignore`.
- **Git repositories nested inside** (an agent's worktree, a vendored repo) are left out of the parent and
  listed in its first receipt. If one is a real project of its own, convert it separately.
- **The old git history stays** readable in `.git`. Nothing is rewritten or deleted.
- **Unfinished work by another agent?** Tell the person and wait, or let that agent finish first. The first
  receipt is signed by whoever converts.

## 4. Bring it in

```bash
xyz adopt <folder> --who <your name>      # plain folder
xyz convert <folder> --who <your name>    # git folder
```

The folder stays exactly where it is and becomes the project's **Y** (source). XYZ adds a small `.xyz` marker
and makes the project's home (`~/XYZ/<Name>/` with **X** for live and **Z** for memory). No project files are
moved or changed.

## 5. Afterwards: leave light for the next agent

1. `xyz <Name>`: check the first receipt counted the files you expect, and nothing heavy came in by mistake.
   Extra things to skip go in `"skip"` in `~/XYZ/<Name>/xyz.json`.
2. Write `~/XYZ/<Name>/Z/NOTES.md` properly. Replace "What this is" with a real description, fill in how to
   run and test it, and say what was in progress when it was migrated.
3. Run the tests on a RAM copy (`xyz try "<test command>"`) and write the baseline into NOTES (what passes,
   what already failed before you came).
4. If a test command should gate going live, set `"check"` in `xyz.json`. Leave it empty if the tests
   already fail, and say why in NOTES.
5. `xyz map` builds `Z/MAP.md`. `xyz save "why" --learned "<tip>"` adds anything the map can't see.
6. Don't move running services to run from X (`"servicesFromX"`) unless the person asks. That is a separate decision.

## Don'ts

- Don't convert or adopt without the person's yes.
- Don't run `git commit`, `git add` or `git push` in a folder once it is in XYZ (it has a `.xyz` file),
  unless the person asks you to share it somewhere.
- Don't delete `.git`, `.xyz`, or anything under `~/XYZ/<Name>/`.
- Don't "fix" a half-finished setup by re-adopting over it. Stop and ask.

## Undoing a migration

The folder itself was never moved. To leave XYZ, the person removes the `.xyz` file and the project's
link or folder in `~/XYZ/`. `xyz extract <Name>` first keeps everything (X, Y and Z) in one .zip.
Agents never do this on their own.
