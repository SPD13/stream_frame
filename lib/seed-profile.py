#!/usr/bin/env python3
"""Seed the dedicated Chrome profile used by Stream Frame. Stdlib only.

  seed-profile.py id MANIFEST
      Print the extension id derived from manifest.json's "key".

  seed-profile.py seed --profile DIR --seed-dir DIR --services FILE --home-url URL
                       [--helper-crx PATH --helper-version V --helper-id ID]
                       [--no-netflix-1080p]
      Merge our Preferences, create Bookmarks on first run only, and (re)write the
      External Extensions entries. Chrome must not be running on this profile.
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
        entries = [{"name": "Home", "url": args.home_url}] + [{"name": s["name"], "url": s["url"]} for s in services]
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

    # External Extensions live in the user-data-dir root on Linux and macOS.
    ext_dir = profile / "External Extensions"
    ext_dir.mkdir(parents=True, exist_ok=True)
    nf = ext_dir / f"{NETFLIX_1080P_ID}.json"
    if args.netflix_1080p:
        write_json(nf, json.loads((seed_dir / "external-extensions" / f"{NETFLIX_1080P_ID}.json").read_text()))
        notes.append("Netflix 1080p extension registered")
    elif nf.exists():
        nf.unlink()
    if args.helper_crx:
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
    ps = sub.add_parser("seed")
    ps.add_argument("--profile", required=True)
    ps.add_argument("--seed-dir", required=True)
    ps.add_argument("--services", required=True)
    ps.add_argument("--home-url", required=True)
    ps.add_argument("--helper-crx")
    ps.add_argument("--helper-version")
    ps.add_argument("--helper-id")
    ps.add_argument("--no-netflix-1080p", dest="netflix_1080p", action="store_false")
    args = p.parse_args()
    if args.cmd == "id":
        print(extension_id(args.manifest))
    else:
        if args.helper_crx and not (args.helper_version and args.helper_id):
            p.error("--helper-crx needs --helper-version and --helper-id")
        seed(args)


if __name__ == "__main__":
    sys.exit(main())
