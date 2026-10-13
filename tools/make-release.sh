#!/usr/bin/env bash
# Packs a Stream Frame release: the archive the installer app (installer/, tools/make-installer.sh)
# downloads from the latest GitHub release and installs on the Frame with the install.sh inside it.
#
#   tools/make-release.sh [version]      default: <date>-<short commit>
#
# Output: dist/release/stream-frame-<version>.tar.gz, unpacking to stream-frame-<version>/:
#
#   install.sh  uninstall.sh  README.md  VERSION
#   bin/  lib/  extension/  web/  assets/   what install.sh copies to ~/.local/share/stream-frame
#   dist/stream-frame-helper.crx          the helper extension, signed with the project key
#
# The files are the ones git tracks, as they are in the working tree (a warning names uncommitted
# changes); the source icons, docs, tests and developer tools stay out. Needs extension/key.pem:
# a release is always signed with the project key, so the extension id is the same for everyone.
#
# Publish: attach the archive and the installer apps to a GitHub release, for example
#   gh release create <version> dist/release/stream-frame-<version>.tar.gz dist/release/installer/*
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
version=${1:-$(date +%Y%m%d)-$(git -C "$root" rev-parse --short HEAD)}
[[ $version =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "make-release: invalid version '$version'" >&2; exit 2; }
name=stream-frame-$version
out=$root/dist/release

[[ -f $root/extension/key.pem ]] || { echo "make-release: extension/key.pem (the project key) is missing" >&2; exit 1; }
if [[ -n $(git -C "$root" status --porcelain --untracked-files=no) ]]; then
  echo "make-release: WARNING: uncommitted changes go into the release: the archive will not match commit $(git -C "$root" rev-parse --short HEAD)" >&2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stage=$work/$name
mkdir -p "$stage/dist" "$out"

git -C "$root" ls-files -z -- install.sh uninstall.sh README.md bin lib extension web assets \
  | grep -zv '^assets/raw_icons/' \
  | (cd "$root" && tar --null -T - -cf -) | tar -xf - -C "$stage"
"$root/extension/build-crx.sh" "$stage/dist/stream-frame-helper.crx"
echo "$version" > "$stage/VERSION"

rm -f "$out/$name.tar.gz"
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$work" -czf "$out/$name.tar.gz" "$name"   # COPYFILE_DISABLE: no macOS ._ files
ls -lh "$out/$name.tar.gz"
