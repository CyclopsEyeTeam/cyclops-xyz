#!/usr/bin/env bash
# XYZ installer: puts `xyz` on your PATH, optionally turns on the auto-saver and the right-click menu,
# then lets you pick which of your existing project folders to bring in.
#
#   ./install.sh            ask as it goes
#   ./install.sh --yes      take every default (auto-saver on, right-click on, no folders converted)
#   ./install.sh --pick     skip straight to choosing folders to bring in
#
# Nothing is ever deleted: your folders stay where they are, and git folders keep their .git as an archive.
set -euo pipefail

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
YES=0; PICK_ONLY=0
for a in "$@"; do case "$a" in --yes|-y) YES=1 ;; --pick) PICK_ONLY=1 ;; -h|--help) sed -n '2,10p' "$0"; exit 0 ;; esac; done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say()  { printf '  %s\n' "$*"; }
ask()  { # ask "question" default(y/n) -> returns 0 for yes
  local q=$1 d=${2:-y} r
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then [ "$d" = y ]; return; fi
  read -r -p "  $q [$( [ "$d" = y ] && echo Y/n || echo y/N )] " r || true
  r=${r:-$d}; [[ "$r" =~ ^[Yy] ]]
}

# ---- Node 22+
NODE=$(command -v node || true)
if [ -z "$NODE" ]; then bold "XYZ needs Node.js 22 or newer."; say "Install it (https://nodejs.org or your package manager), then run this again."; exit 1; fi
MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 22 ]; then bold "XYZ needs Node.js 22 or newer (you have $("$NODE" -v))."; exit 1; fi
XYZ_BIN="$HOME/.local/bin/xyz"

if [ "$PICK_ONLY" = 0 ]; then
  bold "Installing XYZ from $HERE"

  # ---- the command
  mkdir -p "$HOME/.local/bin" "${XYZ_ROOT:-$HOME/XYZ}"
  chmod +x "$HERE/bin/xyz.mjs" "$HERE/desktop/xyz-desktop.sh"
  ln -sfn "$HERE/bin/xyz.mjs" "$XYZ_BIN"
  say "xyz → $XYZ_BIN"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Note: add ~/.local/bin to your PATH (e.g. in ~/.bashrc: export PATH=\"\$HOME/.local/bin:\$PATH\")" ;; esac
  say "Your projects will be listed in ${XYZ_ROOT:-$HOME/XYZ}"

  # ---- the auto-saver (every 15 minutes)
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    if ask "Turn on the auto-saver (keeps every project's changes every 15 minutes)?" y; then
      U="$HOME/.config/systemd/user"; mkdir -p "$U"
      sed -e "s#@NODE@#$NODE#g" -e "s#@XYZ_HOME@#$HERE#g" "$HERE/systemd/xyz-watch.service" > "$U/xyz-watch.service"
      cp "$HERE/systemd/xyz-watch.timer" "$U/xyz-watch.timer"
      systemctl --user daemon-reload
      systemctl --user enable --now xyz-watch.timer >/dev/null 2>&1 && say "auto-saver on (xyz-watch.timer)"
    fi
  else
    say "No systemd user session here: run 'xyz watch' yourself (or from cron) to save every project."
  fi

  # ---- right-click menu
  if command -v nemo >/dev/null; then
    if ask "Add 'Create XYZ project here' and 'Bring into XYZ' to the right-click menu (Nemo / Cinnamon desktop)?" y; then
      A="$HOME/.local/share/nemo/actions"; mkdir -p "$A"
      for f in "$HERE"/desktop/*.nemo_action; do sed -e "s#@XYZ_HOME@#$HERE#g" -e "s#@NODE@#$NODE#g" "$f" > "$A/$(basename "$f")"; done
      say "right-click items added (Nemo picks them up straight away)"
    fi
  elif command -v nautilus >/dev/null; then
    if ask "Add 'Bring into XYZ' to the right-click Scripts menu (Nautilus / GNOME Files)?" y; then
      S="$HOME/.local/share/nautilus/scripts"; mkdir -p "$S"
      printf '#!/bin/sh\nIFS="\n"; for f in $NAUTILUS_SCRIPT_SELECTED_FILE_PATHS; do "%s" adopt "$f"; done\n' "$HERE/desktop/xyz-desktop.sh" > "$S/Bring into XYZ"
      chmod +x "$S/Bring into XYZ"; say "added: right-click → Scripts → Bring into XYZ"
    fi
  fi
  # ---- XYZ Manager in the app menu (needs Python 3 with GTK 3, as on Mint / Ubuntu / Fedora desktops)
  if python3 -c "import gi; gi.require_version('Gtk','3.0')" 2>/dev/null; then
    if ask "Add 'XYZ Manager' (every project on one screen, with folder buttons and extract) to the app menu?" y; then
      D="$HOME/.local/share/applications"; mkdir -p "$D"
      sed -e "s#@XYZ_HOME@#$HERE#g" "$HERE/desktop/xyz-manager.desktop" > "$D/xyz-manager.desktop"
      chmod +x "$HERE/desktop/xyz-manager.py"
      say "XYZ Manager added to the app menu"
    fi
  fi
fi

# ---- bring in existing projects
echo
if [ "$YES" = 1 ] && [ "$PICK_ONLY" = 0 ]; then bold "Done. Bring folders in any time with: ./install.sh --pick"; exit 0; fi
ask "Look for project folders to bring into XYZ now?" y || { bold "Done. Run 'xyz help' to start, or ./install.sh --pick later."; exit 0; }
DEF="$HOME/Documents"; [ -d "$DEF" ] || DEF="$HOME"
read -r -p "  Which folder holds your projects? [$DEF] " WHERE || true
WHERE=${WHERE:-$DEF}; WHERE=${WHERE/#\~/$HOME}
[ -d "$WHERE" ] || { say "No folder at $WHERE"; exit 1; }
say "Looking through $WHERE (this only reads)…"

PLAN=$("$NODE" "$HERE/bin/xyz.mjs" convert --all "$WHERE" --dry-run --json)
LIST=$("$NODE" -e '
  const p = JSON.parse(process.argv[1]);
  p.convert.forEach((c, i) => console.log([i + 1, c.path, c.name, c.sizeMB, c.unsaved].join("\t")));
' "$PLAN")
"$NODE" -e '
  const p = JSON.parse(process.argv[1]);
  const online = p.skipped.filter(s => s.reason.startsWith("online"));
  if (online.length) { console.log("\n  Left alone (they have an online copy; bring one in by hand with: xyz convert <folder> --include-online):"); online.forEach(s => console.log("    " + s.path)); }
  if (p.inside.length) console.log(`\n  ${p.inside.length} git folder(s) inside those projects are left out (convert one by name if it is a real project).`);
' "$PLAN"

if [ -z "$LIST" ]; then bold "Nothing new to bring in from $WHERE."; exit 0; fi
echo; bold "Projects found:"
while IFS=$'\t' read -r n path name mb unsaved; do
  printf '  %3s) %-32s %8s MB  %s\n' "$n" "$name" "$mb" "$([ "$unsaved" -gt 0 ] 2>/dev/null && echo "$unsaved unsaved" || true)"
done <<< "$LIST"
echo
read -r -p "  Bring in which? Numbers (e.g. 1 3 5), 'all', or Enter for none: " PICKS || true
[ -n "${PICKS:-}" ] || { bold "Nothing brought in. Run ./install.sh --pick any time."; exit 0; }
if [ "$PICKS" = all ]; then PICKS=$(cut -f1 <<< "$LIST" | tr '\n' ' '); fi

for n in $PICKS; do
  line=$(awk -F'\t' -v n="$n" '$1 == n' <<< "$LIST")
  [ -n "$line" ] || { say "skipped '$n' (not on the list)"; continue; }
  path=$(cut -f2 <<< "$line")
  if XYZ_WHO="${XYZ_WHO:-$USER}" "$NODE" "$HERE/bin/xyz.mjs" convert "$path" >/dev/null 2>/tmp/xyz-install-err.$$; then
    say "✓ $(basename "$path")"
  else
    say "✗ $(basename "$path"): $(cat /tmp/xyz-install-err.$$)"
  fi
done
rm -f /tmp/xyz-install-err.$$
echo; bold "Done. See them all with: xyz list   ·   one project: xyz <name>"
