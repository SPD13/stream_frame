#!/usr/bin/env bash
# Capture what the Steam Frame wearer sees (SteamVR compositor view) and copy it here.
# Uses OpenVR's IVRScreenshots through python ctypes on the headset (pattern from
# saphid/frame-control, MIT). Requires Developer Mode + SSH and SteamVR running.
#
#   tools/frame-shot.sh <user@frame-host> [out.png]
#
# Tip for remote testing: keep the compositor running with the headset off your head:
#   ssh <host> vrcmd --set-settings-bool power.pauseCompositorOnStandby 0
set -euo pipefail

host=${1:?usage: frame-shot.sh <user@frame-host> [out.png]}
out=${2:-frame-$(date +%Y%m%d-%H%M%S).png}

remote=$(ssh "$host" python3 - <<'PY'
import ctypes as C, glob, os, sys, time

roots = ["~/.steam/steam", "~/.local/share/Steam", "~/.steam/root"]
libs = []
for r in roots:
    libs += glob.glob(os.path.expanduser(r + "/steamapps/common/SteamVR/bin/linux*/libopenvr_api.so"))
libs.sort(key=lambda p: ("arm" not in p and "aarch64" not in p, p))  # prefer the arm64 build
if not libs:
    sys.exit("frame-shot: libopenvr_api.so not found under the Steam library")
vr = C.CDLL(libs[0])

err = C.c_int(0)
vr.VR_InitInternal2.restype = C.c_uint32
vr.VR_InitInternal2.argtypes = [C.POINTER(C.c_int), C.c_int, C.c_char_p]
vr.VR_GetGenericInterface.restype = C.c_void_p
vr.VR_GetGenericInterface.argtypes = [C.c_char_p, C.POINTER(C.c_int)]
vr.VR_ShutdownInternal.restype = None

VRApplication_Background = 3
vr.VR_InitInternal2(C.byref(err), VRApplication_Background, None)
if err.value:
    sys.exit(f"frame-shot: VR_Init failed (EVRInitError {err.value}); is SteamVR running?")

H = C.c_uint32
class FnTable(C.Structure):  # VR_IVRScreenshots_FnTable, IVRScreenshots_001
    _fields_ = [
        ("RequestScreenshot", C.CFUNCTYPE(C.c_int, C.POINTER(H), C.c_int, C.c_char_p, C.c_char_p)),
        ("HookScreenshot", C.CFUNCTYPE(C.c_int, C.POINTER(C.c_int), C.c_int)),
        ("GetScreenshotPropertyType", C.CFUNCTYPE(C.c_int, H, C.POINTER(C.c_int))),
        ("GetScreenshotPropertyFilename", C.CFUNCTYPE(C.c_uint32, H, C.c_int, C.c_char_p, C.c_uint32, C.POINTER(C.c_int))),
        ("UpdateScreenshotProgress", C.CFUNCTYPE(C.c_int, H, C.c_float)),
        ("TakeStereoScreenshot", C.CFUNCTYPE(C.c_int, C.POINTER(H), C.c_char_p, C.c_char_p)),
        ("SubmitScreenshot", C.CFUNCTYPE(C.c_int, H, C.c_int, C.c_char_p, C.c_char_p)),
    ]

try:
    ptr = vr.VR_GetGenericInterface(b"FnTable:IVRScreenshots_001", C.byref(err))
    if not ptr or err.value:
        sys.exit(f"frame-shot: IVRScreenshots unavailable (error {err.value})")
    fn = C.cast(ptr, C.POINTER(FnTable)).contents
    base = f"/tmp/frame-shot-{int(time.time())}"
    handle = H(0)
    rc = fn.TakeStereoScreenshot(C.byref(handle), (base + "-preview").encode(), (base + "-vr").encode())
    if rc:
        sys.exit(f"frame-shot: TakeStereoScreenshot failed (EVRScreenshotError {rc})")
    for _ in range(100):
        hits = glob.glob(base + "-preview*.png")
        if hits and os.path.getsize(hits[0]) > 0:
            time.sleep(0.3)
            print(hits[0])
            break
        time.sleep(0.1)
    else:
        sys.exit("frame-shot: screenshot file did not appear")
finally:
    vr.VR_ShutdownInternal()
PY
)

scp -q "$host:$remote" "$out"
ssh "$host" rm -f "${remote%-preview*}"-*
echo "frame-shot: saved $out"
