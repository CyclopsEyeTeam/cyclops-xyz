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
- Run `xyz` inside the project folder (or `xyz <project>` from anywhere; names match loosely). It shows
  what the project is, where X/Y/Z are, what is live, what changed since the last receipt, and the
  latest receipts.
- Read `Z/NOTES.md` (its path is in the `xyz` output) before changing anything.

**While you work**
- Work in Y. Edit files normally.
- Quick tests can run on a throwaway copy in RAM: `xyz try "<command>"` (exit code passes through).

**When you finish a piece of work**
- `xyz save "what you did and why, in plain words" --who <your agent name>` (or set `XYZ_WHO`).
  One receipt per finished piece is ideal; the auto-saver also keeps changes every 15 minutes.
- If `xyz save` says Z can't be written from where you are (a sandbox), that's fine: your note waits in Y
  and the auto-saver turns it into a signed receipt.
- Update `Z/NOTES.md` ("How it runs", "In progress", "For the next person") instead of adding new
  handover files to the project root.

**Going live and undoing**
- `xyz promote` runs the project's check and makes Y the live version in X; `xyz rollback` goes back.
  Only do this when you were asked to make something live.
- `xyz undo r-NNNN --yes` reverses just that receipt's changes and keeps later work. If it refuses because
  a later change touched the same file, report that instead of forcing it.

**Do not**
- Do not run `git commit`, `git add` or `git push` in a folder XYZ has adopted (it has a `.xyz` file),
  unless the person explicitly asks you to share it somewhere.
- Do not delete anything under Z or the project home (`~/XYZ/<project>`): it is the project's memory.
- Do not move a project's running services to X, or bring more folders into XYZ (`xyz convert`), unless
  the person asked for it.

`xyz help` lists every command. Every read command accepts `--json`.
