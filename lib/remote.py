#!/usr/bin/env python3
"""Stream Frame remote: lets a phone on the local network send a streaming link to the headset.

  remote.py --services FILE --ext-id ID [--state-dir DIR] [--watch-pid PID]

bin/stream-frame starts it next to Chrome. Two listeners:
  control  127.0.0.1:47800, fixed. A WebSocket for the helper extension only: the
           extension pushes its Configuration > Server settings and receives links to open.
  phone    0.0.0.0:<port from the settings>. The page a phone opens to paste a link, and
           the JSON API behind it. Opened, closed or moved whenever the settings change.

Settings are cached in <state-dir>/remote.json so the phone listener is up before Chrome
has started. Standard library only.
"""
import argparse
import base64
import errno
import hashlib
import hmac
import html
import ipaddress
import json
import os
import re
import secrets
import socket
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
PAGE = HERE.parent / "web" / "remote.html"

CONTROL_PORT = 47800  # also SF.CONTROL_PORT in extension/settings.js
DEFAULT_SETTINGS = {"enabled": True, "port": 8765, "codeEnabled": False, "code": ""}
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_WS_PAYLOAD = 64 * 1024
MAX_BODY = 16 * 1024
FIRST_ANSWER_S = 6  # how long /open waits for the headset's first answer
RESULT_TTL_S = 180
IP_FAILS, IP_LOCK_S, GLOBAL_FAILS = 5, 60, 30  # confirmation code brute-force limits
OPEN_RATE = (10, 10)  # at most 10 /open requests per 10 s per client
SESSION_COOKIE = "sf_session"

URL_RE = re.compile(r"https?://[^\s<>\"'`]+", re.I)
TRAILING = ".,;:!?)]}'\""


def log(*parts):
    print(time.strftime("%H:%M:%S"), "remote:", *parts, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ settings + links


def normalize_settings(saved, control_port=CONTROL_PORT):
    out = dict(DEFAULT_SETTINGS)
    if not isinstance(saved, dict):
        return out
    if isinstance(saved.get("enabled"), bool):
        out["enabled"] = saved["enabled"]
    port = saved.get("port")
    if isinstance(port, int) and not isinstance(port, bool) and 1024 <= port <= 65535 and port != control_port:
        out["port"] = port
    if isinstance(saved.get("codeEnabled"), bool):
        out["codeEnabled"] = saved["codeEnabled"]
    code = saved.get("code")
    if isinstance(code, str) and re.fullmatch(r"\d{6}", code):
        out["code"] = code
    if not out["code"]:
        out["codeEnabled"] = False  # the extension always sets a code first; never lock phones out
    return out


class Allowlist:
    """Built-in services' domains from services.json ("hosts"), https only."""

    def __init__(self, services, test_origins=()):
        self.entries = [(s["id"], s["name"], [h.lower() for h in s.get("hosts", [])]) for s in services]
        self.test_origins = {o.rstrip("/").lower() for o in test_origins}

    def names(self):
        return [name for _, name, hosts in self.entries if hosts]

    def match(self, url):
        try:
            u = urlsplit(url)
            port = u.port
        except ValueError:
            return None
        if f"{u.scheme}://{u.netloc}".lower() in self.test_origins:
            return {"id": "test", "name": "test page"}
        if u.scheme.lower() != "https" or u.username or u.password or not u.hostname or port not in (None, 443):
            return None
        host = u.hostname.rstrip(".")
        for sid, name, hosts in self.entries:
            if any(host == h or host.endswith("." + h) for h in hosts):
                return {"id": sid, "name": name}
        return None


def find_link(text, allow):
    """The first supported link in pasted share text: (url, service), (url, None) when there
    are links but none is supported, (None, None) when there is no link at all."""
    urls = [m.group(0).rstrip(TRAILING) for m in URL_RE.finditer(text or "")]
    for url in urls:
        service = allow.match(url)
        if service:
            return url, service
    return (urls[0] if urls else None), None


def lan_ip():
    """This machine's address on the local network (connecting a UDP socket sends nothing)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))
        ip = s.getsockname()[0]
        return None if ip.startswith("127.") or ip == "0.0.0.0" else ip
    except OSError:
        return None
    finally:
        s.close()


def sha(token):
    return hashlib.sha256(token.encode()).hexdigest()


# ------------------------------------------------------------------ WebSocket (server side)


class WsConn:
    """Just enough RFC 6455 for the extension: text frames, ping/pong, close."""

    def __init__(self, rfile, wfile):
        self.r, self.w = rfile, wfile
        self.lock = threading.Lock()
        self.closed = False

    def _read(self, n):
        data = self.r.read(n)
        if len(data) < n:
            raise EOFError
        return data

    def send(self, payload, opcode=1):
        n = len(payload)
        head = bytearray([0x80 | opcode])
        if n < 126:
            head.append(n)
        elif n < 65536:
            head.append(126)
            head += struct.pack("!H", n)
        else:
            head.append(127)
            head += struct.pack("!Q", n)
        with self.lock:
            if self.closed:
                return False
            try:
                self.w.write(bytes(head) + payload)
                self.w.flush()
                return True
            except OSError:
                self.closed = True
                return False

    def send_json(self, obj):
        return self.send(json.dumps(obj).encode())

    def recv(self):
        """The next text message, or None once the connection is closed."""
        buf = b""
        try:
            while True:
                b0, b1 = self._read(2)
                fin, opcode = b0 & 0x80, b0 & 0x0F
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack("!H", self._read(2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", self._read(8))[0]
                if not b1 & 0x80 or n + len(buf) > MAX_WS_PAYLOAD:  # clients must mask
                    return None
                mask = self._read(4)
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(self._read(n)))
                if opcode == 8:
                    self.send(b"", 8)
                    return None
                if opcode == 9:
                    self.send(data, 10)
                    continue
                if opcode == 10:
                    continue
                buf += data
                if fin:
                    return buf.decode("utf-8", "replace")
        except (EOFError, OSError, ValueError):
            return None

    def close(self):
        with self.lock:
            self.closed = True


# ------------------------------------------------------------------ shared state


class Hub:
    def __init__(self, allow, ext_id, state_file, control_port=CONTROL_PORT, bind="0.0.0.0"):
        self.allow = allow
        self.ext_id = ext_id
        self.state_file = Path(state_file) if state_file else None
        self.control_port = control_port
        self.bind = bind
        self.page = PAGE.read_text(encoding="utf-8") if PAGE.exists() else "<h1>Stream Frame</h1>"
        self.lock = threading.RLock()
        self.settings, self.sessions = self._load()
        self.fails = {}  # client ip -> (wrong codes, locked until)
        self.global_fails = 0
        self.rate = {}  # client ip -> recent /open timestamps
        self.ext = None
        self.results = {}  # request id -> {"status", "service", "t", "event"}
        self.phone = None
        self.error = None

    # ---- persistence

    def _load(self):
        try:
            data = json.loads(self.state_file.read_text())
            return normalize_settings(data.get("settings"), self.control_port), set(data.get("sessions", []))
        except (AttributeError, OSError, ValueError):
            return dict(DEFAULT_SETTINGS), set()

    def _save(self):
        if not self.state_file:
            return
        tmp = self.state_file.with_suffix(".tmp")
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump({"settings": self.settings, "sessions": sorted(self.sessions)}, f)
            os.replace(tmp, self.state_file)
        except OSError as e:
            log("could not save", self.state_file, e)

    # ---- phone listener

    def start_phone(self):
        with self.lock:
            self._stop_phone()
            self.error = None
            s = self.settings
            if s["enabled"]:
                try:
                    srv = PhoneServer((self.bind, s["port"]), PhoneHandler)
                except OSError as e:
                    self.error = (
                        f"Port {s['port']} is already in use. Choose another port."
                        if e.errno == errno.EADDRINUSE
                        else f"Cannot open port {s['port']}: {e.strerror or e}"
                    )
                    log(self.error)
                else:
                    srv.hub = self
                    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.25}, daemon=True).start()
                    self.phone = srv
                    log(f"phone page on {self.bind}:{s['port']}, code {'on' if s['codeEnabled'] else 'off'}")
            else:
                log("phone page off")
        self.push_status()

    def _stop_phone(self):
        if self.phone:
            self.phone.shutdown()
            self.phone.server_close()
            self.phone = None

    def apply_settings(self, raw):
        new = normalize_settings(raw, self.control_port)
        with self.lock:
            old = self.settings
            if new == old and (self.phone or not new["enabled"]):
                self.push_status()
                return
            if (new["codeEnabled"], new["code"]) != (old["codeEnabled"], old["code"]):
                self.sessions.clear()
                self.fails.clear()
                self.global_fails = 0
            self.settings = new
            self._save()
        self.start_phone()  # every change restarts the phone listener

    def status(self):
        with self.lock:
            s = self.settings
            listening = self.phone is not None
            ip = lan_ip() if listening else None
            error = self.error
            if listening and not ip:
                error = "No network connection. Connect the headset to Wi-Fi."
            host = socket.gethostname().split(".")[0]
            return {
                "enabled": s["enabled"],
                "port": s["port"],
                "codeEnabled": s["codeEnabled"],
                "listening": listening,
                "url": f"http://{ip}:{s['port']}/" if listening and ip else None,
                "hostnameUrl": f"http://{host}.local:{s['port']}/" if listening and host else None,
                "error": error,
                "codeLocked": s["codeEnabled"] and self.global_fails >= GLOBAL_FAILS,
            }

    # ---- extension channel

    def attach(self, conn):
        with self.lock:
            if self.ext:
                self.ext.close()
            self.ext = conn
        log("helper extension connected")
        conn.send_json({"type": "status", "status": self.status()})

    def detach(self, conn):
        with self.lock:
            if self.ext is conn:
                self.ext = None
                log("helper extension disconnected")

    def push_status(self):
        ext = self.ext
        if ext:
            ext.send_json({"type": "status", "status": self.status()})

    def on_message(self, conn, raw):
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        kind = msg.get("type") if isinstance(msg, dict) else None
        if kind == "settings":
            self.apply_settings(msg.get("settings"))
        elif kind == "result":
            with self.lock:
                r = self.results.get(msg.get("id"))
                if r and isinstance(msg.get("status"), str):
                    r["status"] = msg["status"]
                    r["event"].set()
        elif kind == "ping":
            conn.send_json({"type": "status", "status": self.status()})

    def dispatch(self, url, service):
        rid = secrets.token_hex(8)
        with self.lock:
            now = time.monotonic()
            for k in [k for k, r in self.results.items() if now - r["t"] > RESULT_TTL_S]:
                del self.results[k]
            ext = self.ext
            if not ext:
                return {"status": "not_connected"}
            r = self.results[rid] = {"status": "sent", "service": service["name"], "t": now, "event": threading.Event()}
        if not ext.send_json({"type": "open", "id": rid, "url": url, "service": service["id"], "serviceName": service["name"]}):
            return {"status": "not_connected"}
        log("sent", service["name"], "link to the headset")
        r["event"].wait(FIRST_ANSWER_S)
        return self.result(rid)

    def result(self, rid):
        with self.lock:
            r = self.results.get(rid)
            if not r:
                return {"status": "unknown"}
            status = r["status"]
            if status == "sent" and time.monotonic() - r["t"] > FIRST_ANSWER_S:
                status = "no_answer"
            return {"id": rid, "status": status, "service": r["service"]}

    # ---- phone access

    def code_required(self):
        return self.settings["codeEnabled"]

    def has_session(self, token):
        with self.lock:
            return bool(token) and sha(token) in self.sessions

    def check_code(self, ip, code):
        """"ok" (returns a new session token too), "wrong", "locked" or "blocked"."""
        with self.lock:
            now = time.monotonic()
            if self.global_fails >= GLOBAL_FAILS:
                return "blocked", None
            count, until = self.fails.get(ip, (0, 0))
            if until > now:
                return "locked", None
            if isinstance(code, str) and hmac.compare_digest(code.strip(), self.settings["code"]):
                self.fails.pop(ip, None)
                token = secrets.token_urlsafe(16)
                self.sessions.add(sha(token))
                self._save()
                return "ok", token
            count += 1
            self.global_fails += 1
            self.fails[ip] = (0, now + IP_LOCK_S) if count >= IP_FAILS else (count, 0)
            blocked = self.global_fails >= GLOBAL_FAILS
        log("wrong confirmation code from", ip)
        if blocked:
            log("too many wrong codes: code entry blocked until the code changes")
            self.push_status()
        return "wrong", None

    def rate_ok(self, ip):
        limit, window = OPEN_RATE
        with self.lock:
            now = time.monotonic()
            recent = [t for t in self.rate.get(ip, []) if now - t < window]
            if len(recent) >= limit:
                self.rate[ip] = recent
                return False
            self.rate[ip] = recent + [now]
            return True


# ------------------------------------------------------------------ HTTP handlers


class QuietHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "StreamFrame"
    sys_version = ""

    def log_message(self, *args):
        pass

    def send_body(self, code, body, ctype, headers=()):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, code, obj, headers=()):
        self.send_body(code, json.dumps(obj), "application/json", headers)


class ControlHandler(QuietHandler):
    def do_GET(self):
        hub = self.server.hub
        if urlsplit(self.path).path != "/ws" or self.client_address[0] != "127.0.0.1":
            return self.send_json(404, {"error": "not found"})
        if self.headers.get("Origin") != f"chrome-extension://{hub.ext_id}":
            return self.send_json(403, {"error": "forbidden"})
        key = self.headers.get("Sec-WebSocket-Key")
        if "websocket" not in (self.headers.get("Upgrade") or "").lower() or not key:
            return self.send_json(400, {"error": "websocket only"})
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.close_connection = True
        conn = WsConn(self.rfile, self.wfile)
        hub.attach(conn)
        try:
            while True:
                msg = conn.recv()
                if msg is None:
                    break
                hub.on_message(conn, msg)
        finally:
            conn.close()
            hub.detach(conn)


class PhoneHandler(QuietHandler):
    # One request per connection, so closing the listener (server off, new port) cuts phones off at once.
    def end_headers(self):
        self.send_header("Connection", "close")
        self.close_connection = True
        super().end_headers()

    @property
    def hub(self):
        return self.server.hub

    def host_ok(self):
        """Refuse other domain names pointed at us (DNS rebinding): IPs and .local names only."""
        host = (self.headers.get("Host") or "").strip().lower()
        host = host[1:].split("]")[0] if host.startswith("[") else host.rsplit(":", 1)[0]
        if not host:
            return False
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            pass
        name = socket.gethostname().split(".")[0].lower()
        return host in ("localhost", name) or host.endswith(".local")

    def session(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == SESSION_COOKIE:
                return v
        return None

    def authorized(self):
        return not self.hub.code_required() or self.hub.has_session(self.session())

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.host_ok():
            return self.send_json(403, {"error": "forbidden"})
        u = urlsplit(self.path)
        if u.path == "/":
            needs_code = "0" if self.authorized() else "1"
            names = ", ".join(html.escape(n) for n in self.hub.allow.names())
            page = self.hub.page.replace("{{NEEDS_CODE}}", needs_code).replace("{{SERVICES}}", names)
            return self.send_body(
                200, page, "text/html; charset=utf-8",
                [("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                  "connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'"),
                 ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer")],
            )
        if u.path == "/result":
            if not self.authorized():
                return self.send_json(401, {"status": "code_required"})
            rid = (parse_qs(u.query).get("id") or [""])[0]
            return self.send_json(200, self.hub.result(rid))
        if u.path == "/favicon.ico":
            return self.send_body(204, b"", "image/x-icon")
        return self.send_json(404, {"error": "not found"})

    def read_json(self):
        # JSON only: a cross-site page cannot send it without a CORS preflight, which we never grant.
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            self.send_json(415, {"error": "send JSON"})
            return None
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if not 0 < n <= MAX_BODY:
            self.send_json(413, {"error": "bad length"})
            return None
        try:
            body = json.loads(self.rfile.read(n))
        except ValueError:
            body = None
        if not isinstance(body, dict):
            self.send_json(400, {"error": "bad JSON"})
            return None
        return body

    def do_POST(self):
        if not self.host_ok():
            return self.send_json(403, {"error": "forbidden"})
        path = urlsplit(self.path).path
        if path not in ("/auth", "/open"):
            return self.send_json(404, {"error": "not found"})
        body = self.read_json()
        if body is None:
            return
        ip = self.client_address[0]
        hub = self.hub

        if path == "/auth":
            if not hub.code_required():
                return self.send_json(200, {"status": "ok"})
            status, token = hub.check_code(ip, body.get("code"))
            if status != "ok":
                return self.send_json(403 if status == "wrong" else 429, {"status": status})
            cookie = f"{SESSION_COOKIE}={token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict"
            return self.send_json(200, {"status": "ok"}, [("Set-Cookie", cookie)])

        # /open
        if hub.code_required() and not hub.has_session(self.session()):
            if "code" not in body:
                return self.send_json(401, {"status": "code_required"})
            status, _ = hub.check_code(ip, body.get("code"))
            if status != "ok":
                return self.send_json(403 if status == "wrong" else 429, {"status": status})
        if not hub.rate_ok(ip):
            return self.send_json(429, {"status": "rate_limited"})
        text = body.get("url") if isinstance(body.get("url"), str) else body.get("text")
        url, service = find_link(text if isinstance(text, str) else "", hub.allow)
        if not url:
            return self.send_json(400, {"status": "no_link"})
        if not service:
            return self.send_json(400, {"status": "unsupported", "services": hub.allow.names()})
        return self.send_json(200, hub.dispatch(url, service))


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):  # phones come and go
            super().handle_error(request, client_address)


class PhoneServer(QuietServer):
    pass


class ControlServer(QuietServer):
    pass


# ------------------------------------------------------------------ main


def watch(pid):
    """Exit when Chrome (the launcher's exec'd process) exits."""
    while True:
        time.sleep(2)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            log(f"process {pid} exited, stopping")
            os._exit(0)
        except PermissionError:
            pass


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--services", required=True, help="extension/services.json")
    ap.add_argument("--ext-id", required=True, help="helper extension id (the only allowed WebSocket origin)")
    ap.add_argument("--state-dir", help="where remote.json (settings cache, phone sessions) is kept")
    ap.add_argument("--control-port", type=int, default=CONTROL_PORT)
    ap.add_argument("--bind", default="0.0.0.0", help="address for the phone listener")
    ap.add_argument("--watch-pid", type=int, help="exit when this process exits")
    ap.add_argument("--allow-test-origin", action="append", default=[], help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    services = json.loads(Path(args.services).read_text())
    state = Path(args.state_dir) / "remote.json" if args.state_dir else None
    hub = Hub(Allowlist(services, args.allow_test_origin), args.ext_id, state, args.control_port, args.bind)

    control = None
    for attempt in range(20):  # a previous run may still be shutting down
        try:
            control = ControlServer(("127.0.0.1", args.control_port), ControlHandler)
            break
        except OSError as e:
            if e.errno != errno.EADDRINUSE or attempt == 19:
                log(f"cannot open control port {args.control_port}: {e}")
                return 1
            time.sleep(0.5)
    control.hub = hub
    log(f"control channel on 127.0.0.1:{args.control_port}")
    if args.watch_pid:
        threading.Thread(target=watch, args=(args.watch_pid,), daemon=True).start()
    hub.start_phone()
    try:
        control.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
