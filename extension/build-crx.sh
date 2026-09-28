#!/usr/bin/env bash
# Packs extension/ into a CRX3 file signed with the project key, so the extension id
# stays cjgndomenjkjikknkabepmobpflkbchl (derived from "key" in manifest.json).
#
#   extension/build-crx.sh [output.crx]        default: dist/stream-frame-helper.crx
#
# The private key is extension/key.pem (or $STREAM_FRAME_KEY) and must never be
# committed. With --new-key and no key present, a new key is generated and
# manifest.json's "key" is rewritten, which changes the extension id.
# Needs python3 and openssl; no Chrome required.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
key=${STREAM_FRAME_KEY:-$here/key.pem}
new_key=0
out=$root/dist/stream-frame-helper.crx

for arg in "$@"; do
  case $arg in
    --new-key) new_key=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) out=$arg ;;
  esac
done

command -v openssl >/dev/null || { echo "build-crx: openssl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "build-crx: python3 is required" >&2; exit 1; }

if [[ ! -f $key ]]; then
  if (( ! new_key )); then
    echo "build-crx: private key $key not found." >&2
    echo "  Copy the project key there, or pass --new-key to create one (this changes the extension id)." >&2
    exit 1
  fi
  echo "build-crx: generating a new signing key at $key"
  (umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$key" 2>/dev/null)
  pub=$(openssl pkey -in "$key" -pubout -outform DER | base64 | tr -d '\n')
  python3 - "$here/manifest.json" "$pub" <<'PY'
import json, sys
path, pub = sys.argv[1], sys.argv[2]
m = json.load(open(path))
m["key"] = pub
open(path, "w").write(json.dumps(m, indent=2) + "\n")
PY
fi

mkdir -p "$(dirname "$out")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

openssl pkey -in "$key" -pubout -outform DER > "$tmp/pub.der"

# 1. zip the extension (deterministic order and timestamps)
python3 - "$here" "$tmp/ext.zip" <<'PY'
import sys, zipfile
from pathlib import Path
src, dst = Path(sys.argv[1]), sys.argv[2]
skip = {"build-crx.sh", "key.pem"}
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(src.rglob("*")):
        rel = p.relative_to(src)
        if p.is_dir() or rel.name in skip or rel.name.startswith(".") or rel.suffix in {".pem", ".crx", ".md"}:
            continue
        info = zipfile.ZipInfo(str(rel), date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, p.read_bytes())
PY

# 2. signed header data + the bytes to sign
python3 - "$tmp" "$here/manifest.json" <<'PY'
import base64, hashlib, json, struct, sys
from pathlib import Path
tmp = Path(sys.argv[1])
pub = (tmp / "pub.der").read_bytes()
manifest_key = json.load(open(sys.argv[2])).get("key", "")
if base64.b64decode(manifest_key) != pub:
    sys.exit("build-crx: manifest.json \"key\" does not match the private key; the extension id would change")

def varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | 0x80]) if n else bytes([b])
        if not n:
            return out

def field(num, data):
    return varint((num << 3) | 2) + varint(len(data)) + data

crx_id = hashlib.sha256(pub).digest()[:16]
signed_header = field(1, crx_id)  # SignedData { crx_id }
(tmp / "signed_header.bin").write_bytes(signed_header)
zip_bytes = (tmp / "ext.zip").read_bytes()
(tmp / "tosign.bin").write_bytes(b"CRX3 SignedData\x00" + struct.pack("<I", len(signed_header)) + signed_header + zip_bytes)
PY

openssl dgst -sha256 -sign "$key" -out "$tmp/sig.bin" "$tmp/tosign.bin"

# 3. assemble: "Cr24" | version 3 | header size | CrxFileHeader | zip
python3 - "$tmp" "$out" "$here/manifest.json" <<'PY'
import hashlib, json, struct, sys
from pathlib import Path
tmp, out = Path(sys.argv[1]), Path(sys.argv[2])

def varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | 0x80]) if n else bytes([b])
        if not n:
            return out

def field(num, data):
    return varint((num << 3) | 2) + varint(len(data)) + data

pub = (tmp / "pub.der").read_bytes()
proof = field(1, pub) + field(2, (tmp / "sig.bin").read_bytes())  # AsymmetricKeyProof
header = field(2, proof) + field(10000, (tmp / "signed_header.bin").read_bytes())  # CrxFileHeader
out.write_bytes(b"Cr24" + struct.pack("<II", 3, len(header)) + header + (tmp / "ext.zip").read_bytes())

ext_id = "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(pub).hexdigest()[:32])
version = json.load(open(sys.argv[3]))["version"]
print(f"build-crx: wrote {out} (id {ext_id}, version {version})")
PY
