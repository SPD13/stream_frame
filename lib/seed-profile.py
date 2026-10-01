#!/usr/bin/env python3
"""Seed the dedicated Chrome profile used by Stream Frame. Stdlib only.

  seed-profile.py id MANIFEST
      Print the extension id derived from manifest.json's "key".

  seed-profile.py crx-id FILE
      Print the extension id a signed CRX3 package installs as.

  seed-profile.py seed --profile DIR --seed-dir DIR --services FILE --home-url URL
                       [--ext-dir DIR] [--helper-crx PATH --helper-version V --helper-id ID]
                       [--no-netflix-1080p]
      Merge our Preferences, create Bookmarks on first run only, and (re)write the
      extension registrations in --ext-dir. Chrome must not be running on this profile.
"""
import argparse
import base64
import hashlib
import json
import sys
import time
import uuid
from pathlib import Path

NETFLIX_1080P_ID = "mdlbikciddolbenfkgggdegphnhmnfcg"


def extension_id(manifest_path):
    key = json.loads(Path(manifest_path).read_text())["key"]
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def _fields(buf):
    """(field number, bytes) for the length-delimited fields of a protobuf message."""
    i = 0
    while i < len(buf):
        tag, i = _varint(buf, i)
        if tag & 7 != 2:
            raise ValueError("unexpected protobuf wire type")
        n, i = _varint(buf, i)
        yield tag >> 3, buf[i:i + n]
        i += n


def _varint(buf, i):
    shift = value = 0
    while True:
        b = buf[i]
        i += 1
        value |= (b & 0x7F) << shift
        shift += 7
        if not b & 0x80:
            return value, i


def crx_id(path):
    """The id in a CRX3 file's signed header (CrxFileHeader.signed_header_data.crx_id)."""
    data = Path(path).read_bytes()
    if data[:4] != b"Cr24" or int.from_bytes(data[4:8], "little") != 3:
        raise ValueError(f"{path} is not a CRX3 package")
    header = data[12:12 + int.from_bytes(data[8:12], "little")]
    signed = next(v for f, v in _fields(header) if f == 10000)
    raw = next(v for f, v in _fields(signed) if f == 1)
    return "".join(chr(ord("a") + int(c, 16)) for c in raw.hex())


def chrome_time():
    """Microseconds since 1601-01-01, as Chrome stores bookmark dates."""
    return str(int((time.time() + 11644473600) * 1_000_000))


def deep_merge(base, over):
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(path)


def seed(args):
    profile = Path(args.profile).expanduser()
    seed_dir = Path(args.seed_dir)
    default = profile / "Default"
    default.mkdir(parents=True, exist_ok=True)
    notes = []

    # Preferences: merge our keys into whatever Chrome already wrote.
    template = (seed_dir / "Preferences.json").read_text().replace("@HOME_URL@", args.home_url)
    ours = json.loads(template)
    prefs_path = default / "Preferences"
    try:
        prefs = json.loads(prefs_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        prefs = {}
    write_json(prefs_path, deep_merge(prefs, ours))
    notes.append("preferences merged")

    # Bookmarks: first run only, so the user's own bookmarks are never clobbered.
    bm_path = default / "Bookmarks"
    if bm_path.exists():
        notes.append("bookmarks kept (already present)")
    else:
        now = chrome_time()
        bm = json.loads((seed_dir / "Bookmarks.json").read_text().replace("@NOW@", now))
        services = json.loads(Path(args.services).read_text())
        entries = [{"name": "Home", "url": args.home_url}] + [
            {"name": s["name"], "url": s["url"]} for s in services if not s.get("hiddenByDefault")
        ]
        next_id = 4
        for e in entries:
            bm["roots"]["bookmark_bar"]["children"].append(
                {
                    "date_added": now,
                    "date_last_used": "0",
                    "guid": str(uuid.uuid4()),
                    "id": str(next_id),
                    "name": e["name"],
                    "type": "url",
                    "url": e["url"],
                }
            )
            next_id += 1
        write_json(bm_path, bm)
        notes.append(f"bookmarks seeded ({len(entries)})")

    # Extension registrations (<id>.json). Chrome on Linux reads them from <chrome dir>/extensions
    # (--ext-dir), not from the profile; macOS reads <profile>/External Extensions, the default.
    legacy = profile / "External Extensions"
    ext_dir = Path(args.ext_dir).expanduser() if args.ext_dir else legacy
    ext_dir.mkdir(parents=True, exist_ok=True)
    if ext_dir != legacy:  # drop registrations an older install left in the profile
        for i in (NETFLIX_1080P_ID, args.helper_id):
            if i and (legacy / f"{i}.json").exists():
                (legacy / f"{i}.json").unlink()
    nf = ext_dir / f"{NETFLIX_1080P_ID}.json"
    if args.netflix_1080p:
        write_json(nf, json.loads((seed_dir / "external-extensions" / f"{NETFLIX_1080P_ID}.json").read_text()))
        notes.append("Netflix 1080p extension registered")
    elif nf.exists():
        nf.unlink()
    if args.helper_crx:
        # A helper signed with another key (project key vs this device's key) has another id:
        # drop its registration so Chrome does not run two copies.
        crx_path = str(Path(args.helper_crx).resolve())
        for old in ext_dir.glob("*.json"):
            if old.stem in (args.helper_id, NETFLIX_1080P_ID):
                continue
            try:
                stale = json.loads(old.read_text()).get("external_crx") == crx_path
            except (OSError, ValueError):
                stale = False
            if stale:
                old.unlink()
                notes.append(f"removed the old helper registration {old.stem}")
        write_json(
            ext_dir / f"{args.helper_id}.json",
            {"external_crx": str(Path(args.helper_crx).resolve()), "external_version": args.helper_version},
        )
        notes.append(f"helper extension {args.helper_id} v{args.helper_version} registered")

    # Mark first run as done (belt and braces with --no-first-run).
    (profile / "First Run").touch()
    print("seed-profile: " + "; ".join(notes))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    pid = sub.add_parser("id")
    pid.add_argument("manifest")
    pcrx = sub.add_parser("crx-id")
    pcrx.add_argument("crx")
    ps = sub.add_parser("seed")
    ps.add_argument("--profile", required=True)
    ps.add_argument("--seed-dir", required=True)
    ps.add_argument("--services", required=True)
    ps.add_argument("--home-url", required=True)
    ps.add_argument("--ext-dir", help="where Chrome reads extension registrations")
    ps.add_argument("--helper-crx")
    ps.add_argument("--helper-version")
    ps.add_argument("--helper-id")
    ps.add_argument("--no-netflix-1080p", dest="netflix_1080p", action="store_false")
    args = p.parse_args()
    if args.cmd == "id":
        print(extension_id(args.manifest))
    elif args.cmd == "crx-id":
        print(crx_id(args.crx))
    else:
        if args.helper_crx and not (args.helper_version and args.helper_id):
            p.error("--helper-crx needs --helper-version and --helper-id")
        seed(args)


if __name__ == "__main__":
    sys.exit(main())
