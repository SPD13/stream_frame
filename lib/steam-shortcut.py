#!/usr/bin/env python3
"""Add, update or remove the "Stream Frame" library shortcut through the Steam
client's CEF DevTools port (127.0.0.1:8080, page SharedJSContext), without
restarting Steam. Stdlib only.

Rewrite of frame/steam-shortcut.py from saphid/chromium-webxr-steam-frame
(BSD-style licence; see README "Credits"), using SteamClient.Apps.

  steam-shortcut.py check
  steam-shortcut.py add --name NAME --exe PATH [--start-dir DIR] [--launch-options STR]
                        [--icon PNG] [--state-file FILE]
  steam-shortcut.py remove [--appid N | --state-file FILE] [--name NAME]

Exit codes: 0 ok, 2 DevTools port unreachable, 1 other error.
The state file stores the shortcut's app id so re-runs update instead of duplicating.
"""
import argparse
import base64
import json
import os
import socket
import struct
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HOST = os.environ.get("STEAM_DEVTOOLS_HOST", "127.0.0.1")
PORT = int(os.environ.get("STEAM_DEVTOOLS_PORT", "8080"))
TARGET_TITLE = "SharedJSContext"


class PortUnavailable(Exception):
    pass


# ---------------------------------------------------------------- DevTools / WebSocket


def find_target():
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/json", timeout=3) as r:
            targets = json.load(r)
    except OSError as e:
        raise PortUnavailable(str(e)) from e
    for t in targets:
        if t.get("title") == TARGET_TITLE and t.get("webSocketDebuggerUrl"):
            return t["webSocketDebuggerUrl"]
    raise PortUnavailable(f"no {TARGET_TITLE} target on the DevTools port")


class WebSocket:
    """Minimal RFC 6455 client: text frames, masking, fragmentation, ping/pong."""

    def __init__(self, url):
        u = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=15)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {u.path or '/'} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise PortUnavailable("WebSocket handshake closed")
            resp += chunk
        head, self.buf = resp.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise PortUnavailable("WebSocket handshake refused: " + head.split(b"\r\n", 1)[0].decode(errors="replace"))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("WebSocket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode, payload):
        head = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 1 << 16:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def send(self, text):
        self._send_frame(0x1, text.encode())

    def recv(self):
        parts = []
        while True:
            b0, b1 = self._read(2)
            opcode, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x9:
                self._send_frame(0xA, data)
                continue
            if opcode == 0x8:
                raise ConnectionError("WebSocket closed by peer")
            if opcode in (0x1, 0x2, 0x0):
                parts.append(data)
                if b0 & 0x80:
                    return b"".join(parts).decode()

    def close(self):
        try:
            self._send_frame(0x8, b"")
        finally:
            self.sock.close()


def evaluate(js):
    ws = WebSocket(find_target())
    try:
        ws.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": js, "awaitPromise": True, "returnByValue": True},
        }))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                break
    finally:
        ws.close()
    if "error" in msg:
        raise RuntimeError(msg["error"].get("message", str(msg["error"])))
    res = msg["result"]
    if res.get("exceptionDetails"):
        d = res["exceptionDetails"]
        raise RuntimeError(d.get("exception", {}).get("description") or d.get("text", "JavaScript exception"))
    return res["result"].get("value")


# ---------------------------------------------------------------- shortcut operations

# Runs inside Steam's SharedJSContext. Every optional call is guarded, because the
# SteamClient API is undocumented and changes between client builds.
ADD_JS = r"""
(async (p) => {
  const A = SteamClient.Apps;
  const warnings = [];
  const SHORTCUT_TYPE = 1073741824;
  const exists = (id) => {
    try { return !!(window.appStore && appStore.GetAppOverviewByAppID(id)); } catch (e) { return false; }
  };
  let appId = p.appid && exists(p.appid) ? p.appid : null;
  if (!appId) {
    try {
      const found = (appStore.allApps || []).find(a => a.app_type === SHORTCUT_TYPE && a.display_name === p.name);
      if (found) appId = found.appid;
    } catch (e) {}
  }
  const created = !appId;
  if (!appId) appId = await A.AddShortcut(p.name, p.exe, p.startDir, p.launchOptions);
  if (!appId) throw new Error('AddShortcut returned no app id');
  const call = (fn, ...args) => {
    try { if (typeof A[fn] === 'function') return A[fn](appId, ...args); warnings.push(fn + ' unavailable'); }
    catch (e) { warnings.push(fn + ': ' + e); }
  };
  call('SetShortcutName', p.name);
  call('SetShortcutExe', p.exeQuoted);
  call('SetShortcutStartDir', p.startDirQuoted);
  call('SetShortcutLaunchOptions', p.launchOptions);
  if (p.icon) call('SetShortcutIcon', p.icon);
  return { appId, created, warnings };
})(__PARAMS__)
"""

REMOVE_JS = r"""
(async (p) => {
  let ids = [];
  if (p.appid) ids.push(p.appid);
  if (!ids.length && p.name) {
    try { ids = (appStore.allApps || []).filter(a => a.app_type === 1073741824 && a.display_name === p.name).map(a => a.appid); } catch (e) {}
  }
  for (const id of ids) SteamClient.Apps.RemoveShortcut(id);
  return { removed: ids };
})(__PARAMS__)
"""


def run_js(template, params):
    return evaluate(template.replace("__PARAMS__", json.dumps(params)))


def cmd_add(a):
    exe = str(Path(a.exe).expanduser().resolve())
    start_dir = str(Path(a.start_dir).expanduser().resolve()) if a.start_dir else str(Path(exe).parent)
    appid = None
    if a.state_file and Path(a.state_file).exists():
        try:
            appid = int(Path(a.state_file).read_text().strip())
        except ValueError:
            pass
    if a.icon:
        a.icon = str(Path(a.icon).expanduser().resolve())
    res = run_js(ADD_JS, {
        "appid": appid,
        "name": a.name,
        "exe": exe,
        "exeQuoted": f'"{exe}"',
        "startDir": start_dir,
        "startDirQuoted": f'"{start_dir}"',
        "launchOptions": a.launch_options or "",
        "icon": a.icon,
    })
    if a.state_file:
        Path(a.state_file).parent.mkdir(parents=True, exist_ok=True)
        Path(a.state_file).write_text(f"{res['appId']}\n")
    for w in res.get("warnings", []):
        print(f"steam-shortcut: warning: {w}", file=sys.stderr)
    print(f"steam-shortcut: {'added' if res['created'] else 'updated'} '{a.name}' (app id {res['appId']})")


def cmd_remove(a):
    appid = a.appid
    if appid is None and a.state_file and Path(a.state_file).exists():
        try:
            appid = int(Path(a.state_file).read_text().strip())
        except ValueError:
            pass
    res = run_js(REMOVE_JS, {"appid": appid, "name": a.name})
    if a.state_file and Path(a.state_file).exists():
        Path(a.state_file).unlink()
    print(f"steam-shortcut: removed {res['removed'] or 'nothing'}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    pa = sub.add_parser("add")
    pa.add_argument("--name", required=True)
    pa.add_argument("--exe", required=True)
    pa.add_argument("--start-dir")
    pa.add_argument("--launch-options", default="")
    pa.add_argument("--icon")
    pa.add_argument("--state-file")
    pr = sub.add_parser("remove")
    pr.add_argument("--appid", type=int)
    pr.add_argument("--state-file")
    pr.add_argument("--name")
    a = p.parse_args()
    try:
        if a.cmd == "check":
            find_target()
            print(f"steam-shortcut: DevTools port {HOST}:{PORT} reachable")
        elif a.cmd == "add":
            cmd_add(a)
        else:
            cmd_remove(a)
    except PortUnavailable as e:
        print(f"steam-shortcut: Steam DevTools port unavailable: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 - report any SteamClient failure plainly
        print(f"steam-shortcut: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
