#!/usr/bin/env bash
# Removes Stream Frame: the Steam shortcut, the desktop entry and the installed files.
#
#   ./uninstall.sh [--purge] [--remove-chrome] [--dry-run]
#
#   --purge          also delete the Chrome profile (logins, tile layout, button mapping),
#                    the settings file and logs
#   --remove-chrome  also uninstall the com.google.Chrome Flatpak and reset its overrides
#   --dry-run        print what would be done
set -euo pipefail

src=$(cd "$(dirname "$0")" && pwd)
SF_DATA=${SF_DATA:-$HOME/.local/share/stream-frame}
SF_CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/stream-frame
SF_STATE=${XDG_STATE_HOME:-$HOME/.local/state}/stream-frame

purge=0 remove_chrome=0 dry_run=0
for arg in "$@"; do
  case $arg in
    --purge) purge=1 ;;
    --remove-chrome) remove_chrome=1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "uninstall.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
run() {
  if (( dry_run )); then printf '    [dry-run]'; printf ' %q' "$@"; echo; else "$@"; fi
}

profile=$SF_DATA/profile
if pgrep -f -- "--user-data-dir=$profile" >/dev/null 2>&1; then
  echo "uninstall.sh: Stream Frame is running; close it first." >&2
  exit 1
fi

lib=$src/lib
[[ -f $lib/steam-shortcut.py ]] || lib=$SF_DATA/lib

step "Steam library shortcut"
if [[ -f $lib/steam-shortcut.py ]]; then
  rc=0
  run python3 "$lib/steam-shortcut.py" remove --state-file "$SF_STATE/shortcut-appid" --name "Stream Frame" || rc=$?
  if (( rc != 0 )); then
    warn "could not remove it through Steam's DevTools port; remove \"Stream Frame\" from the library by hand."
  fi
else
  warn "steam-shortcut.py not found; remove \"Stream Frame\" from the library by hand."
fi

step "Desktop entry"
run rm -f "$HOME/.local/share/applications/stream-frame.desktop"

step "Files in $SF_DATA"
if [[ -d $SF_DATA ]]; then
  if (( purge )); then
    run rm -rf "$SF_DATA"
  else
    shopt -s dotglob nullglob
    for p in "$SF_DATA"/*; do
      [[ $p == "$profile" ]] && continue
      run rm -rf "$p"
    done
    note "kept the Chrome profile (logins): $profile  (use --purge to delete it)"
  fi
fi

if (( purge )); then
  step "Settings and logs"
  run rm -rf "$SF_CONFIG_DIR" "$SF_STATE"
else
  run rm -f "$SF_STATE/shortcut-appid"
fi

if (( remove_chrome )); then
  step "Google Chrome Flatpak"
  if command -v flatpak >/dev/null && flatpak info --user com.google.Chrome >/dev/null 2>&1; then
    run flatpak override --user --reset com.google.Chrome
    run flatpak uninstall --user -y --noninteractive com.google.Chrome
  else
    note "no user-installed com.google.Chrome Flatpak"
  fi
fi

step "Done"
