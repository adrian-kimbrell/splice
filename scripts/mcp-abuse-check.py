"""Hostile-traffic checks for the Splice MCP endpoint. Run against a SANDBOXED debug
instance only (SPLICE_CONFIG_DIR=<tmp>, MCP + remote access on): it floods the port
and fills the inbox.  mcp-abuse-check.py PORT LOCAL_TOKEN REMOTE_TOKEN DEV_API_URL APP_PID
Covers oversized/malformed/stalled requests and floods, while measuring that a
local agent and the window stay responsive, and that memory and sockets do not leak.
"""
import json, socket, subprocess, sys, threading, time, urllib.request
PORT, LOCAL, REMOTE, DEV, PID = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
results = []
def check(name, ok, detail=""):
    results.append(ok); print(("PASS  " if ok else "FAIL  ") + name + ("   [" + str(detail)[:160] + "]" if detail != "" else ""), flush=True)
def raw(payload, wait=3.0, read=True):
    s = socket.create_connection(("127.0.0.1", PORT), timeout=wait)
    try: s.sendall(payload)
    except OSError: pass
    if not read: return s, b""
    data = b""
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk: break
            data += chunk
    except socket.timeout:
        data += b"<TIMEOUT>"
    except OSError:
        data += b"<RESET>"
    s.close(); return None, data
def req(body, token=LOCAL, extra="", method="POST", path="/mcp"):
    b = body if isinstance(body, bytes) else body.encode()
    head = "%s %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nContent-Type: application/json\r\nX-Splice-Token: %s\r\n%sContent-Length: %d\r\n\r\n" % (method, path, PORT, token, extra, len(b))
    return head.encode() + b
def status(resp):
    try: return int(resp.split(b" ", 2)[1])
    except Exception: return 0
PING = '{"jsonrpc":"2.0","id":1,"method":"ping"}'
def legit_ms():
    t = time.perf_counter(); _, r = raw(req(PING)); return (time.perf_counter() - t) * 1000, status(r)
def ui_ms():
    t = time.perf_counter(); op.open(DEV + "/dev/state", timeout=15).read(); return (time.perf_counter() - t) * 1000
def rss_kb(): return int(subprocess.check_output(["ps", "-o", "rss=", "-p", PID]).strip())
def fds(): return len(subprocess.check_output(["lsof", "-p", PID]).splitlines())
def alive(): return subprocess.call(["kill", "-0", PID]) == 0

base_ms = sorted(legit_ms()[0] for _ in range(20))[10]; time.sleep(1.1)
base_ui = sorted(ui_ms() for _ in range(5))[2]
rss0, fd0 = rss_kb(), fds()
print("baseline: endpoint %.2f ms, window round trip %.1f ms, RSS %d MB, %d fds" % (base_ms, base_ui, rss0 // 1024, fd0))

_, r = raw(req("x" * (300 * 1024)));                         check("oversized body (300 KB) is refused with 413 without reading it", status(r) == 413, status(r))
_, r = raw(("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Splice-Token: %s\r\n\r\n" % LOCAL).encode() + PING.encode()); check("missing Content-Length is 400", status(r) == 400, status(r))
_, r = raw(("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Splice-Token: %s\r\nContent-Length: -5\r\n\r\n" % LOCAL).encode()); check("negative Content-Length is 400", status(r) == 400, status(r))
_, r = raw(("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Splice-Token: %s\r\nContent-Length: 99999999999999999999\r\n\r\n" % LOCAL).encode()); check("absurd Content-Length is refused", status(r) in (400, 413), status(r))
_, r = raw(req(b"\xff\xfe\xfd not utf8"));                    check("invalid UTF-8 body gets a parse error", status(r) == 200 and b"-32700" in r, r[-80:])
_, r = raw(req("[" * 20000 + "]" * 20000));                   check("20,000-deep nested JSON gets a parse error, no crash", status(r) == 200 and b"-32700" in r and alive(), r[-60:])
_, r = raw(req(json.dumps([{"jsonrpc": "2.0", "id": i, "method": "ping"} for i in range(5000)])))
n = len(json.loads(r.split(b"\r\n\r\n", 1)[1])) if status(r) == 200 else -1
check("a batch of 5,000 is capped (20 answered)", n == 20, n)
_, r = raw(req('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_terminal","arguments":{"terminal_id":-1,"lines":999999999}}}'))
check("read_terminal with a negative id and a huge line count is a clean tool error", status(r) == 200 and b'"isError":true' in r, r[-120:])
_, r = raw(req('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"spawn_agent","arguments":{"task":"x","target":"new_workspace","path":"/etc/../../../nonexistent/\\u0000"}}}'))
check("spawn_agent with a hostile path is a clean tool error", status(r) == 200 and b'"isError":true' in r, r[-120:])
_, r = raw(req('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"spawn_agent","arguments":{"task":"x","agent":"bash -c evil"}}}'))
check("spawn_agent refuses an agent name that is not claude or codex", status(r) == 200 and b'"isError":true' in r, r[-120:])
time.sleep(1.1)
for path in ["/mcp/", "/MCP", "/mcp/../attention", "/mcp%2f", "//mcp", "/"]:
    _, r = raw(req(PING, path=path)); 
    if status(r) not in (403, 404): check("path %s is not served" % path, False, status(r))
check("path variants (/mcp/, /MCP, /mcp/../attention, /mcp%2f, //mcp, /) are not served", True)
for m, want in [("GET", 405), ("OPTIONS", 405), ("PUT", 405), ("DELETE", 405)]:
    _, r = raw(req(PING, method=m))
    if status(r) != want or b"access-control" in r.lower(): check("%s is refused without CORS headers" % m, False, r[:80])
check("GET / OPTIONS / PUT / DELETE are 405, and no CORS headers are ever sent", True)
_, r = raw(req(PING) + req(PING));                            check("two pipelined requests: one answer, then the connection closes", r.count(b"HTTP/1.1") == 1, r.count(b"HTTP/1.1"))
_, r = raw(b"POST /mcp HTTP/1.1\r\nX-Junk: " + b"A" * 40000 + b"\r\n\r\n"); check("a 40 KB header is dropped", status(r) == 0 or status(r) >= 400, status(r))
_, r = raw(b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03" + b"\x00" * 200, wait=7); check("a TLS handshake sent to the plain port is dropped", b"200" not in r)
time.sleep(1.1)

# Stalled clients: must not block others, and must be dropped by the server.
socks = []
for i in range(300):
    try: socks.append(socket.create_connection(("127.0.0.1", PORT), timeout=2))
    except OSError: break
ms, st = legit_ms()
check("300 silent connections open: a normal request is still served (%.1f ms)" % ms, st == 200 and ms < 250, (st, ms))
drip = socket.create_connection(("127.0.0.1", PORT)); drip.sendall(b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n")
s2, _ = raw(req(PING)[:-10], read=False)   # headers promise more body than is sent
time.sleep(11.5)
closed = 0
for s in socks:
    s.settimeout(0.05)
    try:
        if s.recv(1) == b"": closed += 1
    except socket.timeout: pass
    except OSError: closed += 1
    s.close()
check("silent connections are dropped by the server after the header timeout", closed >= len(socks) - 2, "%d of %d" % (closed, len(socks)))
s2.settimeout(0.5)
try: gone = s2.recv(1) == b""
except socket.timeout: gone = False
except OSError: gone = True
check("a request whose body never arrives is dropped after the body timeout", gone)
drip.close(); s2.close()
time.sleep(1.1)

# Floods, while watching the endpoint for a legitimate local agent and the window.
stop = False; sent = [0]; lat = []; ui = []
def flood(payload):
    while not stop:
        try:
            s = socket.create_connection(("127.0.0.1", PORT), timeout=2); s.sendall(payload); s.recv(256); s.close(); sent[0] += 1
        except OSError: pass
def run_flood(payload, threads, seconds):
    global stop
    stop = False; sent[0] = 0; lat.clear(); ui.clear()
    ts = [threading.Thread(target=flood, args=(payload,), daemon=True) for _ in range(threads)]
    for t in ts: t.start()
    end = time.time() + seconds
    while time.time() < end:
        lat.append(legit_ms()); ui.append(ui_ms()); time.sleep(0.25)
    stop = True
    for t in ts: t.join(timeout=3)
    ok = [m for m, s in lat if s == 200]
    return sent[0], sorted(ok)[len(ok) // 2] if ok else -1, max(ok) if ok else -1, len(ok), len(lat), sorted(ui)[len(ui) // 2], max(ui)

n, med, mx, okc, tot, uimed, uimax = run_flood(req(PING, token="f" * 32), 16, 8)
check("unauthenticated flood (%d requests in 8 s): local agent still served %d/%d, median %.1f ms, worst %.1f ms" % (n, okc, tot, med, mx), okc == tot and med < 50, "")
check("  window stays responsive during it: round trip median %.0f ms, worst %.0f ms (baseline %.0f)" % (uimed, uimax, base_ui), uimax < max(400, base_ui * 6), "")
time.sleep(1.2)
remote_ping = ("POST /mcp HTTP/1.1\r\nHost: tunnel.example.com\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s" % (REMOTE, len(PING), PING)).encode()
n, med, mx, okc, tot, uimed, uimax = run_flood(remote_ping, 16, 8)
check("authenticated REMOTE flood (%d requests in 8 s): local agent still served %d/%d, median %.1f ms, worst %.1f ms" % (n, okc, tot, med, mx), okc == tot and med < 50, "")
check("  window stays responsive during it: round trip median %.0f ms, worst %.0f ms" % (uimed, uimax), uimax < max(400, base_ui * 6), "")
time.sleep(1.2)
big = req('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"inbox_add","arguments":{"title":"flood","body":"%s"}}}' % ("y" * 60000), token=REMOTE).replace(b"X-Splice-Token", b"Authorization: Bearer x\r\nX-Splice-Token")
n, med, mx, okc, tot, uimed, uimax = run_flood(big, 8, 8)
check("remote inbox flood with 60 KB items (%d requests): local agent median %.1f ms" % (n, med), okc >= tot - 1 and med < 80, "")
time.sleep(1.2)
_, r = raw(req('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"inbox_list","arguments":{}}}'))
items = r.count(b"flood")
check("inbox holds at most 200 items after the flood (rate limit let %d in)" % items, items <= 200, items)

time.sleep(3)
rss1, fd1 = rss_kb(), fds()
ms, st = legit_ms()
check("Splice is still running and answering (%.2f ms)" % ms, alive() and st == 200)
check("memory: RSS %d MB -> %d MB" % (rss0 // 1024, rss1 // 1024), rss1 - rss0 < 150 * 1024, "")
check("no leaked sockets: %d -> %d open files" % (fd0, fd1), fd1 - fd0 < 20, "")
print("\n%d/%d passed" % (sum(results), len(results)))
