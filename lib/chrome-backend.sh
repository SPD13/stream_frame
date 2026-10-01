#!/usr/bin/env bash
# Chrome backend for Stream Frame: Google's arm64 .deb extracted into
# ~/.local/share/stream-frame/chrome (preferred), or Flathub com.google.Chrome (fallback).
# The .deb comes first because Chrome installs extensions registered in its own
# <chrome dir>/extensions folder, which is ours to write for the .deb but read-only in the
# Flatpak; Chrome on Linux ignores the profile's "External Extensions" folder.
#
# Source it for the functions, or run it:
#   chrome-backend.sh detect            print flatpak | deb | none
#   chrome-backend.sh install [flatpak|deb]
#   chrome-backend.sh cmd               print the command Stream Frame execs, one word per line
#
# CHROME_BACKEND=auto|flatpak|deb selects the backend (auto: deb if installed, else flatpak).

SF_DATA=${SF_DATA:-$HOME/.local/share/stream-frame}
SF_FLATPAK_ID=com.google.Chrome
SF_DEB_URL=${SF_DEB_URL:-https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb}
SF_DEB_BIN=$SF_DATA/chrome/opt/google/chrome/chrome
# shellcheck disable=SC2034  # used by install.sh
SF_DEB_EXT_DIR=$SF_DATA/chrome/opt/google/chrome/extensions  # extension registrations (*.json)

sf_have_flatpak_chrome() {
  command -v flatpak >/dev/null 2>&1 || return 1
  flatpak info --user "$SF_FLATPAK_ID" >/dev/null 2>&1 || flatpak info --system "$SF_FLATPAK_ID" >/dev/null 2>&1
}

sf_have_deb_chrome() {
  [[ -x $SF_DEB_BIN ]]
}

sf_detect_backend() {
  case ${CHROME_BACKEND:-auto} in
    flatpak) sf_have_flatpak_chrome && echo flatpak || echo none ;;
    deb) sf_have_deb_chrome && echo deb || echo none ;;
    *)
      if sf_have_deb_chrome; then echo deb
      elif sf_have_flatpak_chrome; then echo flatpak
      else echo none
      fi ;;
  esac
}

# Give the Flatpak access to our data dir (profile, helper .crx, boot page).
sf_flatpak_grant() {
  flatpak override --user --filesystem="$SF_DATA" "$SF_FLATPAK_ID"
}

sf_install_flatpak() {
  command -v flatpak >/dev/null 2>&1 || { echo "chrome-backend: flatpak not found" >&2; return 1; }
  flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo || return 1
  flatpak install --user -y --noninteractive flathub "$SF_FLATPAK_ID" || return 1
  sf_flatpak_grant
}

sf_install_deb() {
  command -v python3 >/dev/null 2>&1 || { echo "chrome-backend: python3 not found" >&2; return 1; }
  local tmp rc
  tmp=$(mktemp -d) || return 1
  echo "chrome-backend: downloading $SF_DEB_URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$tmp/chrome.deb" "$SF_DEB_URL" || { rm -rf "$tmp"; return 1; }
  else
    python3 -c 'import sys,urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$SF_DEB_URL" "$tmp/chrome.deb" || { rm -rf "$tmp"; return 1; }
  fi
  # A .deb is an ar archive holding data.tar.{xz,zst,gz}; unpack opt/google/chrome only.
  python3 - "$tmp/chrome.deb" "$tmp/root" <<'PY'
import io, sys, tarfile
deb, dest = sys.argv[1], sys.argv[2]
data = open(deb, "rb").read()
assert data[:8] == b"!<arch>\n", "not a .deb"
pos, member = 8, None
while pos < len(data):
    hdr = data[pos:pos + 60]
    name = hdr[:16].decode().strip().rstrip("/")
    size = int(hdr[48:58].decode().strip())
    if name.startswith("data.tar"):
        member = (name, data[pos + 60:pos + 60 + size])
        break
    pos += 60 + size + (size & 1)
if not member:
    sys.exit("chrome-backend: no data.tar in the .deb")
name, blob = member
if name.endswith(".zst"):
    try:
        from compression import zstd  # Python 3.14+
    except ImportError:
        sys.exit("chrome-backend: .deb uses zstd and this Python cannot decompress it")
    blob = zstd.decompress(blob)
    mode = "r:"
else:
    mode = "r:*"
with tarfile.open(fileobj=io.BytesIO(blob), mode=mode) as tar:
    members = [m for m in tar.getmembers() if m.name.lstrip("./").startswith("opt/google/chrome")]
    try:
        tar.extractall(dest, members=members, filter="tar")
    except TypeError:  # Python < 3.12
        tar.extractall(dest, members=members)
PY
  rc=$?
  if (( rc == 0 )); then
    rm -rf "$SF_DATA/chrome.new"
    mkdir -p "$SF_DATA"
    mv "$tmp/root" "$SF_DATA/chrome.new" && rm -rf "$SF_DATA/chrome" && mv "$SF_DATA/chrome.new" "$SF_DATA/chrome"
    rc=$?
  fi
  rm -rf "$tmp"
  (( rc == 0 )) && [[ -x $SF_DEB_BIN ]]
}

sf_install_chrome() {
  local want=${1:-${CHROME_BACKEND:-auto}}
  case $want in
    flatpak) sf_install_flatpak ;;
    deb) sf_install_deb ;;
    *) sf_install_deb || { echo "chrome-backend: .deb install failed, falling back to the Flatpak" >&2; sf_install_flatpak; } ;;
  esac
}

# Sets the array SF_CHROME_CMD to the program + fixed args for the detected backend.
sf_chrome_cmd() {
  case $(sf_detect_backend) in
    flatpak) SF_CHROME_CMD=(flatpak run --branch=stable "$SF_FLATPAK_ID") ;;
    deb) SF_CHROME_CMD=("$SF_DEB_BIN") ;;
    *) SF_CHROME_CMD=(); return 1 ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -uo pipefail
  case ${1:-} in
    detect) sf_detect_backend ;;
    install) sf_install_chrome "${2:-}" ;;
    cmd) sf_chrome_cmd && printf '%s\n' "${SF_CHROME_CMD[@]}" ;;
    *) sed -n '2,11p' "$0"; exit 2 ;;
  esac
fi
