# XYZ — instructions for AI agents

Copy this block into your agent's instructions (a global file such as `~/.codex/AGENTS.md`, a project's
`AGENTS.md`, or `CLAUDE.md`). It tells agents how projects on this machine are kept.

---

## XYZ: how local work is kept here

Projects are kept with **XYZ** instead of git commits. Every project has three places:
**X** (live: the version that runs), **Y** (source: where you work) and **Z** (memory: receipts, undo
history and one `NOTES.md`). One command, `xyz`, does everything. The person you work for does not want
version-control ceremony: never ask them about commits, staging, branches or saving.

**When you arrive**
- Run `xyz arrive` inside the project folder (or `xyz arrive <project>` from anywhere; names match loosely).
  It is a short brief: what the project is, how to run and test it, where things live, what to be careful
  with, what is in progress and what changed lately. A session-start hook can inject it for you:
  `xyz arrive --hook` prints nothing outside XYZ projects and never fails.
- The full map is `Z/MAP.md` (refreshed by the auto-saver); read it before searching the code.
  `Z/NOTES.md` has the story.

**Working alongside other agents: take a lane**
- If other agents may be working in the same project, don't edit Y directly. Run
  `xyz lane "what you're doing" --who <your name>`: you get your own numbered copy (L1, L2, …) and its path.
  Work there. `xyz save "why"` inside the lane keeps it safe in Z (no receipt in Y).
- When done, `xyz land` (from inside the lane) merges your changes into Y in the order lanes land, with one
  receipt signed by you holding only your files. Others' work is never swept into your receipt.
- If it says your files clash with work that landed first, nothing was landed: your lane now sits on top of Y.
  Same lines changed on both sides are marked `<<<<<<<` / `>>>>>>>` in the file; for files that can't be merged
  line by line, Y's version sits next to yours as `<file>.Y-L2`: keep what you want, then delete that file.
  `xyz land` refuses until every clash is settled.
- To make only your lane's work live: `xyz promote` inside the lane (live + your changes, checked on that copy). Land it afterwards so Y has it too.
- `xyz lanes` shows who is working where. `xyz drop --yes` abandons a lane (its last state stays in Z).

**While you work**
- Work in Y. Edit files normally.
- Quick tests can run on a throwaway copy in RAM: `xyz try "<command>"` (exit code passes through).
- The whole suite: `xyz test` (side by side; files unchanged since they last passed count from the shared buffer in Z; `--full` runs everything). The last run shows in `xyz arrive`.

**When you finish a piece of work**
- `xyz save "what you did and why, in plain words" --who <your agent name>` (or set `XYZ_WHO`).
  Add `--learned "<one thing about this terrain>"` to leave a line in the map for the next agent.
  One receipt per finished piece is ideal; the auto-saver also keeps changes every 15 minutes.
- If `xyz save` says Z can't be written from where you are (a sandbox), that's fine: your note waits in Y
  and the auto-saver turns it into a signed receipt.
- Update `Z/NOTES.md` ("How it runs", "In progress", "For the next person") instead of adding new
  handover files to the project root.

**Going live and undoing**
- `xyz promote` runs the project's check and makes Y the live version in X; `xyz rollback` goes back.
  When other agents are working, use `xyz promote --saved`: it ships only what is kept (landed or saved),
  never someone's half-done files in Y, and runs the check on that exact copy.
  Only do this when you were asked to make something live.
- `xyz undo r-NNNN --yes` reverses just that receipt's changes and keeps later work. If it refuses because
  a later change touched the same file, report that instead of forcing it.

**Do not**
- Do not run `git commit`, `git add` or `git push` in a folder XYZ has adopted (it has a `.xyz` file),
  unless the person explicitly asks you to share it somewhere.
- Do not delete anything under Z or the project home (`~/XYZ/<project>`): it is the project's memory.
- Do not move a project's running services to X, or bring more folders into XYZ (`xyz convert`), unless
  the person asked for it.

**Who changed what**
- With the edit hook installed (`xyz touch --hook` on Claude Code's PostToolUse for Edit/Write), every edit in
  Y is signed, and the auto-saver keeps one receipt per agent, so each agent's work can be undone alone.
- `xyz changed` lists every unsaved file and who last edited it.
- If a project is busy, xyz names who holds it; add `--wait` to wait while the holder is still running (or `--wait=45m` for at most that long) instead of retrying.

`xyz extract` puts a project's X, Y and Z in one .zip (a backup or a hand-over); only do it when asked.

Arriving in a project that isn't in XYZ yet, or only part-way? Read [MIGRATING.md](MIGRATING.md) (and ask before bringing it in).

`xyz help` lists every command. Every read command accepts `--json`.
