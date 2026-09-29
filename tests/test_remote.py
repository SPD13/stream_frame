"""Unit tests for lib/remote.py (the send-from-phone server).

  python3 -m unittest tests/test_remote.py
"""
import base64
import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "lib"))
import remote  # noqa: E402

SERVICES = json.loads((REPO / "extension/services.json").read_text())
EXT_ID = "cjgndomenjkjikknkabepmobpflkbchl"

NETFLIX = ("https://www.netflix.com/us/title/70301870?s=i&trkid=13747225&shareType=Title"
           "&shareUuid=4266C25A-ACED-4F2C-A3FE-9FA40D666A1F&trg=cp&unifiedEntityIdEncoded=Video%3A70301870&vlang=en")
PRIME = ("https://watch.amazon.com/detail?gti=amzn1.dv.gti.44a9f6f7-b5de-4153-38e2-919dca60a29f&territory=US"
         "&ref_=share_ios_movie&r=web\nHey I’m watching Slaughterhouse-Five. Check it out now on Prime Video!")
HBO = ("https://play.hbomax.com/topical/f7ebcd02-6641-4ec5-a392-07e58196808f?utm_medium=sharebutton"
       "&utm_id=EDD13B0F-D8B5-4DCB-9560-6A69FEED2222\nStream Last Week Tonight With John Oliver on HBO Max")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Links(unittest.TestCase):
    allow = remote.Allowlist(SERVICES)

    def test_share_texts(self):
        for text, service, prefix in [
            (NETFLIX, "netflix", "https://www.netflix.com/us/title/70301870?"),
            (PRIME, "primevideo", "https://watch.amazon.com/detail?gti="),
            (HBO, "max", "https://play.hbomax.com/topical/"),
        ]:
            url, svc = remote.find_link(text, self.allow)
            self.assertEqual(svc["id"], service)
            self.assertTrue(url.startswith(prefix), url)
            self.assertNotIn("\n", url)

    def test_link_inside_a_sentence(self):
        url, svc = remote.find_link("Watch this (https://www.youtube.com/watch?v=abc).", self.allow)
        self.assertEqual((url, svc["id"]), ("https://www.youtube.com/watch?v=abc", "youtube"))

    def test_rejected(self):
        for url in [
            "http://www.netflix.com/title/1",          # not https
            "https://netflix.com.evil.io/title/1",      # look-alike
            "https://evilnetflix.com/",                 # suffix without a dot
            "https://www.netflix.com@evil.io/",         # userinfo
            "https://www.netflix.com:8443/",            # odd port
            "https://example.com/",
            "https://amazon.evil.io/",
        ]:
            self.assertIsNone(self.allow.match(url), url)

    def test_no_link(self):
        self.assertEqual(remote.find_link("just some words", self.allow), (None, None))
        url, svc = remote.find_link("see https://example.com/x", self.allow)
        self.assertEqual((url, svc), ("https://example.com/x", None))

    def test_settings_normalized(self):
        n = remote.normalize_settings
        self.assertEqual(n(None), remote.DEFAULT_SETTINGS)
        self.assertEqual(n({"port": 80})["port"], 8765)
        self.assertEqual(n({"port": remote.CONTROL_PORT})["port"], 8765)
        self.assertEqual(n({"port": True})["port"], 8765)
        self.assertEqual(n({"port": 9000})["port"], 9000)
        self.assertFalse(n({"codeEnabled": True, "code": "12ab56"})["codeEnabled"])
        self.assertTrue(n({"codeEnabled": True, "code": "123456"})["codeEnabled"])


IP_ADDR = """\
1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever preferred_lft forever
3: wlan0    inet 192.168.1.23/24 brd 192.168.1.255 scope global dynamic noprefixroute wlan0\       valid_lft 85000sec
4: tailscale0    inet 100.101.102.103/32 scope global tailscale0\       valid_lft forever preferred_lft forever
5: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\       valid_lft forever preferred_lft forever
6: wg0    inet 10.5.0.2/32 scope global wg0\       valid_lft forever preferred_lft forever
7: veth12ab@if6    inet 172.18.0.1/16 scope global veth12ab\       valid_lft forever preferred_lft forever
"""

IFCONFIG_MAC = """\
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether de:55:7f:e3:25:48
\tinet6 fe80::1c2a:1234:abcd:1%en0 prefixlen 64 secured scopeid 0xb
\tinet 192.168.4.107 netmask 0xffffff00 broadcast 192.168.4.255
utun8: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1420
\tinet 10.5.0.2 --> 10.5.0.2 netmask 0xffff0000
bridge100: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.2.1 netmask 0xffffff00 broadcast 192.168.2.255
"""

IFCONFIG_LINUX_OLD = """\
eth0      Link encap:Ethernet  HWaddr 00:11:22:33:44:55
          inet addr:10.0.0.7  Bcast:10.0.0.255  Mask:255.255.255.0
lo        Link encap:Local Loopback
          inet addr:127.0.0.1  Mask:255.0.0.0
"""


class Addresses(unittest.TestCase):
    def test_parse_ip_addr(self):
        self.assertEqual(remote.parse_ip_addr(IP_ADDR), [
            ("lo", "127.0.0.1"), ("wlan0", "192.168.1.23"), ("tailscale0", "100.101.102.103"),
            ("docker0", "172.17.0.1"), ("wg0", "10.5.0.2"), ("veth12ab", "172.18.0.1"),
        ])

    def test_parse_ifconfig(self):
        self.assertEqual(remote.parse_ifconfig(IFCONFIG_MAC), [
            ("lo0", "127.0.0.1"), ("en0", "192.168.4.107"), ("utun8", "10.5.0.2"), ("bridge100", "192.168.2.1"),
        ])
        self.assertEqual(remote.parse_ifconfig(IFCONFIG_LINUX_OLD), [("eth0", "10.0.0.7"), ("lo", "127.0.0.1")])

    def test_vpn_default_route_is_skipped(self):
        # the Mac on a VPN: the default route goes through utun8, the phone needs en0
        self.assertEqual(remote.rank_addresses(remote.parse_ifconfig(IFCONFIG_MAC), "10.5.0.2"), ["192.168.4.107"])
        self.assertEqual(remote.rank_addresses(remote.parse_ip_addr(IP_ADDR), "10.5.0.2"), ["192.168.1.23"])

    def test_ranking(self):
        pairs = [("eth0", "10.0.0.7"), ("wlan0", "192.168.1.23"), ("usb0", "192.168.42.10"),
                 ("wlan0", "169.254.3.4"), ("enp3s0", "172.20.0.5")]
        self.assertEqual(remote.rank_addresses(pairs), ["192.168.1.23", "192.168.42.10", "10.0.0.7", "172.20.0.5"])
        # the default route breaks ties between equally good addresses
        two = [("wlan0", "192.168.1.23"), ("eth0", "192.168.0.9")]
        self.assertEqual(remote.rank_addresses(two, "192.168.0.9")[0], "192.168.0.9")

    def test_status_lists_other_addresses(self):
        hub = remote.Hub(remote.Allowlist(SERVICES), EXT_ID, None)
        hub.phone = object()  # pretend the phone listener is up
        orig = remote.lan_ips
        remote.lan_ips = lambda: ["192.168.1.23", "10.0.0.7"]
        try:
            st = hub.status()
        finally:
            remote.lan_ips = orig
        self.assertEqual(st["url"], "http://192.168.1.23:8765/")
        self.assertEqual(st["otherUrls"][0], "http://10.0.0.7:8765/")
        self.assertTrue(st["otherUrls"][-1].endswith(".local:8765/"))


class Server(unittest.TestCase):
    """Runs a real hub with both listeners on 127.0.0.1 and a fake extension on the WebSocket."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.control_port = free_port()
        self.phone_port = free_port()
        self.hub = remote.Hub(remote.Allowlist(SERVICES), EXT_ID, Path(self.tmp.name) / "remote.json",
                              self.control_port, "127.0.0.1")
        self.hub.settings["port"] = self.phone_port
        self.control = remote.ControlServer(("127.0.0.1", self.control_port), remote.ControlHandler)
        self.control.hub = self.hub
        threading.Thread(target=self.control.serve_forever, daemon=True).start()
        self.hub.start_phone()
        self.ws = None

    def tearDown(self):
        if self.ws:
            self.ws.close()
        self.hub._stop_phone()
        self.control.shutdown()
        self.control.server_close()
        self.tmp.cleanup()

    # ---- helpers

    def request(self, method, path, body=None, port=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", port or self.hub.settings["port"], timeout=10)
        h = {"Content-Type": "application/json"} if body is not None else {}
        h.update(headers or {})
        c.request(method, path, json.dumps(body) if body is not None else None, h)
        r = c.getresponse()
        data = r.read()
        c.close()
        try:
            data = json.loads(data)
        except ValueError:
            data = data.decode()
        return r.status, data, r

    def ws_connect(self, origin=f"chrome-extension://{EXT_ID}"):
        s = socket.create_connection(("127.0.0.1", self.control_port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        s.sendall((f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = s.recv(1)
            if not chunk:
                break
            head += chunk
        return s, head.split(b"\r\n")[0].decode()

    @staticmethod
    def ws_send(s, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        head = bytes([0x81, 0x80 | len(data)]) if len(data) < 126 else bytes([0x81, 0x80 | 126]) + len(data).to_bytes(2, "big")
        s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    @staticmethod
    def ws_recv(s):
        def read(n):
            buf = b""
            while len(buf) < n:
                chunk = s.recv(n - len(buf))
                if not chunk:
                    raise EOFError
                buf += chunk
            return buf
        b0, b1 = read(2)
        n = b1 & 0x7F
        if n == 126:
            n = int.from_bytes(read(2), "big")
        return json.loads(read(n))

    def attach_extension(self):
        s, line = self.ws_connect()
        self.assertIn("101", line)
        self.ws = s
        self.assertEqual(self.ws_recv(s)["type"], "status")
        return s

    def extension_answers(self, status):
        """Background thread: answer the next 'open' with `status`; returns the received message holder."""
        got = {}

        def run():
            while True:
                m = self.ws_recv(self.ws)
                if m["type"] == "open":
                    got.update(m)
                    self.ws_send(self.ws, {"type": "result", "id": m["id"], "status": status})
                    return
        threading.Thread(target=run, daemon=True).start()
        return got

    def apply(self, **changes):
        self.hub.apply_settings({**self.hub.settings, **changes})

    # ---- tests

    def test_websocket_origin_checked(self):
        s, line = self.ws_connect(origin="https://evil.example")
        self.assertIn("403", line)
        s.close()

    def test_phone_page_and_open(self):
        status, page, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn('data-needs-code="0"', page)
        self.assertEqual(self.request("POST", "/open", {"text": NETFLIX})[1]["status"], "not_connected")
        self.attach_extension()
        got = self.extension_answers("opened")
        status, body, _ = self.request("POST", "/open", {"text": PRIME})
        self.assertEqual((status, body["status"], body["service"]), (200, "opened", "Prime Video"))
        self.assertTrue(got["url"].startswith("https://watch.amazon.com/detail?"))
        self.assertEqual(self.request("POST", "/open", {"text": "https://example.com/"})[1]["status"], "unsupported")

    def test_prompting_then_result(self):
        self.attach_extension()
        self.extension_answers("prompting")
        status, body, _ = self.request("POST", "/open", {"text": HBO})
        self.assertEqual(body["status"], "prompting")
        self.ws_send(self.ws, {"type": "result", "id": body["id"], "status": "declined"})
        time.sleep(0.2)
        self.assertEqual(self.request("GET", f"/result?id={body['id']}")[1]["status"], "declined")

    def test_json_only_and_host_check(self):
        c = http.client.HTTPConnection("127.0.0.1", self.phone_port, timeout=5)
        c.request("POST", "/open", "text=" + NETFLIX, {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(c.getresponse().status, 415)
        c.close()
        status, _, _ = self.request("GET", "/", headers={"Host": "attacker.example:8765"})
        self.assertEqual(status, 403)
        self.assertEqual(self.request("GET", "/", headers={"Host": "steamframe.local:8765"})[0], 200)

    def test_code_flow(self):
        self.apply(codeEnabled=True, code="482913")
        self.assertIn('data-needs-code="1"', self.request("GET", "/")[1])
        self.assertEqual(self.request("POST", "/open", {"text": NETFLIX})[:2], (401, {"status": "code_required"}))
        self.assertEqual(self.request("POST", "/auth", {"code": "000000"})[1]["status"], "wrong")
        status, body, resp = self.request("POST", "/auth", {"code": "482913"})
        self.assertEqual(body["status"], "ok")
        cookie = resp.getheader("Set-Cookie").split(";")[0]
        self.assertIn("HttpOnly", resp.getheader("Set-Cookie"))
        self.assertIn('data-needs-code="0"', self.request("GET", "/", headers={"Cookie": cookie})[1])
        self.assertEqual(self.request("POST", "/open", {"text": NETFLIX}, headers={"Cookie": cookie})[1]["status"],
                         "not_connected")
        # the code in the body works too (share-sheet shortcuts)
        self.assertEqual(self.request("POST", "/open", {"text": NETFLIX, "code": "482913"})[1]["status"], "not_connected")
        # a new code signs every phone out
        self.apply(code="111111")
        self.assertIn('data-needs-code="1"', self.request("GET", "/", headers={"Cookie": cookie})[1])
        # sessions survive a restart of the server process (cached in remote.json)
        _, _, resp = self.request("POST", "/auth", {"code": "111111"})
        cookie = resp.getheader("Set-Cookie").split(";")[0]
        again = remote.Hub(remote.Allowlist(SERVICES), EXT_ID, Path(self.tmp.name) / "remote.json")
        self.assertTrue(again.has_session(cookie.split("=", 1)[1]))
        self.assertEqual(os.stat(Path(self.tmp.name) / "remote.json").st_mode & 0o777, 0o600)

    def test_code_lockouts(self):
        self.apply(codeEnabled=True, code="482913")
        for _ in range(remote.IP_FAILS):
            self.assertEqual(self.request("POST", "/auth", {"code": "000000"})[1]["status"], "wrong")
        # locked for this client, even with the right code
        self.assertEqual(self.request("POST", "/auth", {"code": "482913"})[:2], (429, {"status": "locked"}))
        self.hub.fails.clear()
        self.hub.global_fails = remote.GLOBAL_FAILS
        self.assertEqual(self.request("POST", "/auth", {"code": "482913"})[1]["status"], "blocked")
        self.apply(code="222222")  # a new code unblocks
        self.assertEqual(self.request("POST", "/auth", {"code": "222222"})[1]["status"], "ok")

    def test_settings_restart_listener(self):
        old = self.phone_port
        new = free_port()
        self.apply(port=new)
        self.assertEqual(self.request("GET", "/", port=new)[0], 200)
        with self.assertRaises(OSError):
            self.request("GET", "/", port=old)
        self.apply(enabled=False)
        with self.assertRaises(OSError):
            self.request("GET", "/", port=new)
        self.assertFalse(self.hub.status()["listening"])
        self.apply(enabled=True)
        self.assertEqual(self.request("GET", "/", port=new)[0], 200)

    def test_port_in_use_reported(self):
        blocker = socket.socket()
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        try:
            self.apply(port=blocker.getsockname()[1])
            st = self.hub.status()
            self.assertFalse(st["listening"])
            self.assertIn("already in use", st["error"])
        finally:
            blocker.close()

    def test_settings_from_extension(self):
        s = self.attach_extension()
        new = free_port()
        self.ws_send(s, {"type": "settings", "settings": {"enabled": True, "port": new, "codeEnabled": False, "code": ""}})
        st = self.ws_recv(s)
        self.assertEqual((st["type"], st["status"]["port"], st["status"]["listening"]), ("status", new, True))


if __name__ == "__main__":
    unittest.main()
