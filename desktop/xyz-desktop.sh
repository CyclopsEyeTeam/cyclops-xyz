#!/bin/sh
# Right-click helpers for the desktop and file manager (Nemo actions).
#   xyz-desktop.sh new <folder>     ask for a name, make <folder>/<Name> as a single project (the folder is X, with Y/ and Z/ inside)
#   xyz-desktop.sh adopt <folder>   bring a folder into XYZ (git folders are converted, keeping their story)
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
NODE=${XYZ_NODE:-$(command -v node)}
XYZ="$HERE/../bin/xyz.mjs"
export XYZ_WHO=owner
say() { notify-send -i folder-new "XYZ" "$1" 2>/dev/null || true; }
oops() { zenity --error --no-markup --title="XYZ" --text="$1" 2>/dev/null || say "$1"; }

case "$1" in
  new)
    here="$2"; [ -d "$here" ] || here="$HOME/Desktop"
    name=$(zenity --entry --title="New XYZ project" --text="What's it called?" --entry-text="" 2>/dev/null) || exit 0
    [ -n "$name" ] || exit 0
    out=$("$NODE" "$XYZ" new "$name" --single --at "$here" --yes 2>&1) || { oops "$out"; exit 1; }
    say "$name is ready: one folder, work in its Y"
    nemo "$here/$name" >/dev/null 2>&1 &
    ;;
  adopt)
    shift
    for f in "$@"; do
      if [ -d "$f/.git" ] && git -C "$f" rev-parse --git-dir >/dev/null 2>&1 && [ "$(git -C "$f" rev-parse --absolute-git-dir 2>/dev/null)" = "$(cd "$f" && pwd)/.git" ]; then cmd=convert; else cmd=adopt; fi
      if out=$("$NODE" "$XYZ" "$cmd" "$f" --yes 2>&1); then say "$(basename "$f") is in XYZ now, right where it was"; else oops "$(basename "$f"): $out"; fi
    done
    ;;
  *) echo "usage: $0 new <folder> | adopt <folder>..." >&2; exit 2 ;;
esac
