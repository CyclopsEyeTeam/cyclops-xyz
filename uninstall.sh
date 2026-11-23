#!/usr/bin/env bash
# Removes the xyz command, the auto-saver and the right-click items.
# It never touches your projects or their memory (~/XYZ and each project's Z stay exactly as they are).
set -u
rm -f "$HOME/.local/bin/xyz"
if command -v systemctl >/dev/null; then
  systemctl --user disable --now xyz-watch.timer >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/xyz-watch.service" "$HOME/.config/systemd/user/xyz-watch.timer"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
rm -f "$HOME/.local/share/nemo/actions/xyz-new.nemo_action" "$HOME/.local/share/nemo/actions/xyz-adopt.nemo_action" "$HOME/.local/share/nautilus/scripts/Bring into XYZ"
echo "XYZ removed. Your projects and their receipts are untouched (${XYZ_ROOT:-$HOME/XYZ})."
