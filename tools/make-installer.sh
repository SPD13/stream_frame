#!/usr/bin/env bash
# Builds the installer app (installer/, in Go) for Windows, macOS and Linux, for the GitHub release
# beside the Stream Frame archive (tools/make-release.sh). The app downloads the latest release's
# .tar.gz itself, so the same build serves later releases: attach these files to each new release
# (their names stay the same, so
# https://github.com/SPD13/stream_frame/releases/latest/download/<name> always gives the newest).
#
#   tools/make-installer.sh [version]      default: <date>-<short commit>
#
# Output: dist/release/installer/
#
#   Stream-Frame-Installer-Windows.exe          Windows 10/11 x64 (WebView2 window; runs on Windows on Arm too)
#   Stream-Frame-Installer-macOS.zip            "Stream Frame Installer.app", universal (Apple silicon and Intel), macOS 12+
#   Stream-Frame-Installer-Linux-x86_64.tar.gz  a static binary that opens in the browser (any distribution, SteamOS desktop)
#   Stream-Frame-Installer-Linux-arm64.tar.gz
#
# Runs on a Mac: needs Go (brew install go) and Xcode's command line tools; the Windows icon uses
# go-winres (installed in the Go bin folder on first use). Not signed: Windows SmartScreen and macOS
# Gatekeeper warn on first launch (see README.md, "Install with the installer app").
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
src=$root/installer
out=$root/dist/release/installer
icon=$root/assets/icon.png
GO=${GO:-$(command -v go || echo /opt/homebrew/bin/go)}
[[ -x $GO ]] || { echo "make-installer: Go is missing: brew install go" >&2; exit 1; }
[[ $(uname) == Darwin ]] || { echo "make-installer: the macOS app needs a Mac (WebKit, lipo, iconutil)" >&2; exit 1; }
version=${1:-$(date +%Y%m%d)-$(git -C "$root" rev-parse --short HEAD)}
ldflags="-s -w -X main.version=$version"
short_version=${version#v}; short_version=${short_version%%-*}   # Info.plist wants digits: v1.0.0 -> 1.0.0
work=$(mktemp -d)
trap 'rm -rf "$work" "$src"/rsrc_windows_*.syso' EXIT
rm -rf "$out"
mkdir -p "$out"
cd "$src"

echo "==> Windows"
winres="$($GO env GOPATH)/bin/go-winres"
[[ -x $winres ]] || $GO install github.com/tc-hib/go-winres@v0.3.3
# The icon and the manifest (per-monitor DPI, modern controls) as a resource the Go linker picks up: rsrc_windows_amd64.syso
"$winres" simply --arch amd64 --out rsrc --icon "$icon" --manifest gui \
  --product-name "Stream Frame Installer" --file-description "Stream Frame Installer" \
  --product-version "0.0.0.0" --file-version "0.0.0.0" --original-filename Stream-Frame-Installer-Windows.exe
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 $GO build -trimpath -ldflags "$ldflags -H windowsgui" -o "$out/Stream-Frame-Installer-Windows.exe" .
rm -f rsrc_windows_*.syso

echo "==> macOS"
app="$work/Stream Frame Installer.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
for arch in arm64 amd64; do
  clang_arch=$arch; [[ $arch == amd64 ]] && clang_arch=x86_64
  GOOS=darwin GOARCH=$arch CGO_ENABLED=1 CC="clang -arch $clang_arch" MACOSX_DEPLOYMENT_TARGET=12.0 \
    $GO build -trimpath -ldflags "$ldflags" -o "$work/installer-$arch" . 2> "$work/build-$arch.log" \
    || { cat "$work/build-$arch.log"; exit 1; }
done
lipo -create "$work/installer-arm64" "$work/installer-amd64" -output "$app/Contents/MacOS/stream-frame-installer"
iconset="$work/icon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$icon" --out "$iconset/icon_${size}x${size}.png" > /dev/null
  sips -z $((size * 2)) $((size * 2)) "$icon" --out "$iconset/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/icon.icns"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>stream-frame-installer</string>
  <key>CFBundleIdentifier</key><string>io.github.spd13.stream-frame-installer</string>
  <key>CFBundleName</key><string>Stream Frame Installer</string>
  <key>CFBundleDisplayName</key><string>Stream Frame Installer</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$short_version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSLocalNetworkUsageDescription</key><string>The installer finds your Steam Frame on the network and installs Stream Frame on it.</string>
  <key>NSBonjourServices</key><array><string>_steamos-devkit._tcp</string></array>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
EOF
codesign --force --deep --sign - "$app"   # ad-hoc: Apple silicon runs only signed code
ditto -c -k --keepParent "$app" "$out/Stream-Frame-Installer-macOS.zip"

echo "==> Linux"
for arch in amd64 arm64; do
  name=x86_64; [[ $arch == arm64 ]] && name=arm64
  mkdir -p "$work/linux-$arch"
  GOOS=linux GOARCH=$arch CGO_ENABLED=0 $GO build -trimpath -ldflags "$ldflags" -o "$work/linux-$arch/Stream-Frame-Installer" .
  tar -C "$work/linux-$arch" -czf "$out/Stream-Frame-Installer-Linux-$name.tar.gz" Stream-Frame-Installer
done

ls -lh "$out"
