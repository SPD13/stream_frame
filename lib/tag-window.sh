#!/usr/bin/env bash
# Sets the STEAM_GAME property on Stream Frame's Chrome window when gamescope has not
# already mapped it to the shortcut, so it becomes the shortcut's own SteamVR panel
# (valve.steam.desktopgame.<appid>). Runs in the background for up to 45 s.
#
#   tag-window.sh <SteamGameId>
set -uo pipefail

game_id=${1:?usage: tag-window.sh <SteamGameId>}
command -v xwininfo >/dev/null && command -v xprop >/dev/null || exit 0

# Non-Steam shortcuts get a 64-bit game id: (appid << 32) | 0x02000000.
appid=$(python3 -c 'import sys; g = int(sys.argv[1]); print(g >> 32 if g >= 1 << 32 else g)' "$game_id" 2>/dev/null) || exit 0

deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  sleep 1
  while read -r wid; do
    [[ -n $wid ]] || continue
    if xprop -id "$wid" STEAM_GAME 2>/dev/null | grep -q 'not found'; then
      xprop -id "$wid" -f STEAM_GAME 32c -set STEAM_GAME "$appid" && echo "tag-window: set STEAM_GAME=$appid on $wid"
    fi
  done < <(xwininfo -root -tree 2>/dev/null | awk 'tolower($0) ~ /\("stream-frame"/ {print $1}')
done
