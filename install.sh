#!/usr/bin/env bash
# Stream Frame installer. Run on the Steam Frame as the normal user (SSH or Konsole):
#
#   ./install.sh [options]
#
#   --backend=flatpak|deb     force a Chrome backend (default: Google's .deb, Flatpak as fallback)
#   --update-chrome           download the latest Chrome even if one is installed
#   --no-shortcut             do not add the Steam library shortcut
#   --no-netflix-1080p        do not register the "New Netflix 1080p" Web Store extension
#   --enable-cef-debugging    if Steam's DevTools port is closed, enable it (needs a Steam restart)
#   --dry-run                 print what would be done; runs on any machine
#   --force                   skip the aarch64 check
#
# Idempotent: re-running updates files, the helper extension and the shortcut in place.
# Never needs sudo. Everything goes under ~/.local/share/stream-frame.
set -euo pipefail

src=$(cd "$(dirname "$0")" && pwd)
SF_DATA=${SF_DATA:-$HOME/.local/share/stream-frame}
SF_CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/stream-frame
SF_STATE=${XDG_STATE_HOME:-$HOME/.local/state}/stream-frame
SHORTCUT_NAME="Stream Frame"
export SF_DATA

dry_run=0 backend=auto shortcut=1 netflix=1 force=0 enable_cef=0 update_chrome=0
for arg in "$@"; do
  case $arg in
    --backend=*) backend=${arg#*=} ;;
    --no-shortcut) shortcut=0 ;;
    --update-chrome) update_chrome=1 ;;
    --no-netflix-1080p) netflix=0 ;;
    --enable-cef-debugging) enable_cef=1 ;;
    --dry-run) dry_run=1 ;;
    --force) force=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done
case $backend in auto|flatpak|deb) ;; *) echo "install.sh: --backend must be flatpak or deb" >&2; exit 2 ;; esac

step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
run() {
  if (( dry_run )); then printf '    [dry-run]'; printf ' %q' "$@"; echo; else "$@"; fi
}

# shellcheck source=lib/chrome-backend.sh
. "$src/lib/chrome-backend.sh"

# ------------------------------------------------------------------ checks
step "Checking the system"
(( EUID != 0 )) || die "run as your normal user (steamos), not root"
arch=$(uname -m)
if [[ $arch != aarch64 && $arch != arm64 ]] && (( ! force && ! dry_run )); then
  die "this is $arch; Stream Frame targets the Steam Frame (aarch64). Use --dry-run to test elsewhere or --force."
fi
note "architecture: $arch"
command -v python3 >/dev/null || die "python3 is required"
command -v flatpak >/dev/null || warn "flatpak not found; only the .deb backend is available"
profile=$SF_DATA/profile
if pgrep -f -- "--user-data-dir=$profile" >/dev/null 2>&1; then
  die "Stream Frame is running. Close it first (its Chrome would overwrite the seeded profile)."
fi

# ------------------------------------------------------------------ Chrome
step "Google Chrome (Widevine-capable browser)"
current=$(CHROME_BACKEND=$backend sf_detect_backend)
if (( update_chrome )) && [[ $current == flatpak ]]; then
  note "updating the Chrome Flatpak"
  run flatpak update --user -y --noninteractive "$SF_FLATPAK_ID" || warn "Flatpak update failed; keeping the installed Chrome"
elif (( update_chrome )) || [[ $current == none ]] || [[ $backend == auto && $current != deb ]]; then
  # auto wants the .deb even when the Flatpak is there: only the .deb can install our extensions.
  note "installing Chrome (backend: $backend)"
  if ! run sf_install_chrome "$backend"; then
    [[ $current == none ]] && die "Chrome installation failed; see docs/spikes/S1.md"
    warn "Chrome download failed; keeping the installed $current Chrome"
  fi
  (( dry_run )) || current=$(CHROME_BACKEND=$backend sf_detect_backend)
else
  note "already installed: $current"
fi
(( dry_run )) && [[ $current == none ]] && current=$([[ $backend == flatpak ]] && echo flatpak || echo deb)
if [[ $current == flatpak ]]; then
  note "granting the Flatpak access to $SF_DATA"
  run sf_flatpak_grant
fi

# ------------------------------------------------------------------ helper extension
step "Stream Frame Helper extension"
crx=$src/dist/stream-frame-helper.crx
if [[ -f $src/extension/key.pem ]]; then
  run "$src/extension/build-crx.sh" "$crx"
fi
if [[ -f $crx ]] || (( dry_run )); then
  note "package: $crx"
else
  warn "no dist/stream-frame-helper.crx and no signing key to build one."
  warn "Build it on your dev machine (extension/build-crx.sh) and copy dist/ along, or load"
  warn "$SF_DATA/extension unpacked from chrome://extensions (Developer mode)."
  crx=
fi
ext_id=$(python3 "$src/lib/seed-profile.py" id "$src/extension/manifest.json")
ext_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$src/extension/manifest.json")
note "extension id $ext_id, version $ext_version"

# ------------------------------------------------------------------ files
step "Installing files to $SF_DATA"
run mkdir -p "$SF_DATA/dist" "$SF_CONFIG_DIR" "$SF_STATE"
if [[ $src != "$(cd "$SF_DATA" 2>/dev/null && pwd || echo "$SF_DATA")" ]]; then
  for d in bin lib extension web assets tools docs; do
    [[ -d $src/$d ]] || continue
    if command -v rsync >/dev/null; then
      run rsync -a --delete --exclude 'key.pem' "$src/$d/" "$SF_DATA/$d/"
    else
      run rm -rf "$SF_DATA/$d"
      run cp -R "$src/$d" "$SF_DATA/$d"
      run rm -f "$SF_DATA/extension/key.pem"
    fi
  done
  for f in install.sh uninstall.sh README.md; do
    [[ -f $src/$f ]] && run cp "$src/$f" "$SF_DATA/$f"
  done
  [[ -n $crx ]] && run cp "$crx" "$SF_DATA/dist/stream-frame-helper.crx"
else
  note "running from the install directory; files are already in place"
fi
run chmod +x "$SF_DATA/bin/stream-frame" "$SF_DATA/lib/tag-window.sh" "$SF_DATA/lib/chrome-backend.sh" \
  "$SF_DATA/install.sh" "$SF_DATA/uninstall.sh"
if (( dry_run )); then note "[dry-run] write $SF_DATA/extension-id ($ext_id)"; else echo "$ext_id" > "$SF_DATA/extension-id"; fi

# ------------------------------------------------------------------ profile
step "Seeding the Chrome profile"
seed_args=(seed --profile "$profile" --seed-dir "$SF_DATA/lib/profile-seed"
  --services "$SF_DATA/extension/services.json" --home-url "chrome-extension://$ext_id/home.html")
[[ -n $crx ]] && seed_args+=(--helper-crx "$SF_DATA/dist/stream-frame-helper.crx" --helper-version "$ext_version" --helper-id "$ext_id")
(( netflix )) || seed_args+=(--no-netflix-1080p)
if [[ $current == deb ]]; then
  seed_args+=(--ext-dir "$SF_DEB_EXT_DIR")
else
  warn "the Flatpak Chrome cannot install extensions for Stream Frame by itself. After the first"
  warn "launch, open chrome://extensions, turn on Developer mode, choose Load unpacked and pick"
  warn "$SF_DATA/extension. Or re-run without --backend=flatpak to use Google's .deb Chrome."
fi
run python3 "$SF_DATA/lib/seed-profile.py" "${seed_args[@]}"

# ------------------------------------------------------------------ config
step "Configuration"
config=$SF_CONFIG_DIR/config.env
if [[ -f $config ]]; then
  note "keeping $config"
else
  run cp "$src/lib/config.env.example" "$config"
fi
if [[ $backend != auto ]]; then
  if (( dry_run )); then note "[dry-run] set CHROME_BACKEND=$backend in $config"
  else sed -i.bak "s/^CHROME_BACKEND=.*/CHROME_BACKEND=$backend/" "$config" && rm -f "$config.bak"
  fi
fi

# ------------------------------------------------------------------ desktop entry
step "Desktop entry"
desktop=$HOME/.local/share/applications/stream-frame.desktop
if (( dry_run )); then
  note "[dry-run] write $desktop"
else
  mkdir -p "$(dirname "$desktop")"
  cat > "$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$SHORTCUT_NAME
Comment=Netflix, HBO Max, Hulu, Disney+ and more on a cinema-sized screen
Exec=$SF_DATA/bin/stream-frame
Icon=$SF_DATA/assets/icon.png
Categories=AudioVideo;Video;Player;
Terminal=false
EOF
  note "$desktop"
fi

# ------------------------------------------------------------------ Steam shortcut
manual_shortcut() {
  note "Add it by hand: Steam desktop mode → Games → Add a Non-Steam Game to My Library →"
  note "Browse → $SF_DATA/bin/stream-frame, then rename it \"$SHORTCUT_NAME\"."
}
if (( shortcut )); then
  step "Steam library shortcut"
  rc=0
  run python3 "$SF_DATA/lib/steam-shortcut.py" add --name "$SHORTCUT_NAME" --exe "$SF_DATA/bin/stream-frame" \
    --start-dir "$SF_DATA" --icon "$SF_DATA/assets/icon.png" --state-file "$SF_STATE/shortcut-appid" || rc=$?
  if (( rc == 2 )); then
    cef_flag=$HOME/.steam/steam/.cef-enable-remote-debugging
    if (( enable_cef )); then
      run touch "$cef_flag"
      warn "enabled Steam's DevTools port ($cef_flag). Restart Steam, then re-run install.sh."
    else
      warn "Steam's DevTools port (127.0.0.1:8080) is not reachable, so the shortcut was not added."
      warn "Re-run with --enable-cef-debugging (then restart Steam), or:"
    fi
    manual_shortcut
  elif (( rc != 0 )); then
    warn "adding the shortcut failed."
    manual_shortcut
  fi
fi

step "Done"
note "Launch \"$SHORTCUT_NAME\" from the Steam library. In the SteamVR dashboard, pick View in Theater"
note "or Float in World for its panel; choose passthrough or the dark home in SteamVR settings."
note "Log: $SF_STATE/launcher.log   Settings: $config"
