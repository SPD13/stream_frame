#!/bin/sh
# Spike S8 probe (docs/spikes/S8.md): the start command of a throwaway Devkit Game uploaded
# with the SteamOS Devkit Client, standing in for a Steam build. Logs where it runs (container or not, environment, devkit settings), tries
# to leave the Steam Linux Runtime container, shows a test window on the host, then starts
# the installed Stream Frame (~/.local/share/stream-frame) on the host and waits for it.
# Everything goes to ~/.local/state/stream-frame/s8.log. S8_PROBE_ONLY=1 stops before the window.
# shellcheck disable=SC2016  # the sh -c scripts expand on the host, not here

LOG="$HOME/.local/state/stream-frame/s8.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

echo
echo "=== S8 probe $(date '+%Y-%m-%dT%H:%M:%S%z')"
echo "argv: $0 $*"
echo "cwd: $(pwd)"
echo "script dir: $(cd "$(dirname "$0")" && pwd)"
echo "executable bit on run.sh: $([ -x "$0" ] && echo yes || echo no)"

echo "--- container"
if [ -e /run/pressure-vessel ]; then echo "pressure-vessel container: yes"; else echo "pressure-vessel container: no"; fi
grep -h '^PRETTY_NAME' /etc/os-release

echo "--- environment"
env | grep -E '^(Steam|STEAM_COMPAT|PRESSURE_VESSEL|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|XDG_SESSION|LD_PRELOAD|PULSE_SERVER|SDL_)' | sort

echo "--- devkit settings"
for f in "$HOME"/devkit-game/*-settings.json "$HOME"/devkit-game/*-argv.json; do
  [ -f "$f" ] && echo "$f: $(cat "$f")"
done

LC=$(command -v steam-runtime-launch-client)
echo "--- launch client: ${LC:-none}"
if [ -z "$LC" ]; then
  echo "cannot leave the container: no steam-runtime-launch-client"
  exit 1
fi

echo "--- host probe"
"$LC" --alongside-steam --host -- sh -c '
  echo "host: $(grep -h "^PRETTY_NAME" /etc/os-release)"
  if [ -e /run/pressure-vessel ]; then echo "host is still a container: yes"; else echo "host is still a container: no"; fi
  echo "host DISPLAY=$DISPLAY  WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
  for t in zenity kdialog; do printf "%s: " "$t"; command -v "$t" || echo missing; done
'
echo "host probe exit code: $?"

[ "${S8_PROBE_ONLY:-0}" = 1 ] && { echo "S8_PROBE_ONLY: stopping before the test window"; exit 0; }

echo "--- test window on the host (look for it in the headset)"
"$LC" --alongside-steam --host -- sh -c '
  export DISPLAY=${DISPLAY:-:0}
  if command -v zenity >/dev/null; then
    zenity --info --title="Stream Frame S8" --text="S8 test window: can you see this in the headset?" --timeout=10; echo "zenity exit $?"
  elif command -v kdialog >/dev/null; then
    kdialog --title "Stream Frame S8" --passivepopup "S8 test window: can you see this in the headset?" 10; echo "kdialog exit $?"; sleep 10
  else
    echo "no zenity or kdialog on the host"
  fi
'

echo "--- Stream Frame on the host, started $(date '+%H:%M:%S')"
"$LC" --alongside-steam --host -- env SteamGameId="${SteamGameId:-}" SteamAppId="${SteamAppId:-}" \
  "$HOME/.local/share/stream-frame/bin/stream-frame"
echo "Stream Frame returned with exit code $? at $(date '+%H:%M:%S')"
