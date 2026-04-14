#!/usr/bin/env python3
"""
Splice dedicated stress test: 100 terminals + htop.
Usage:  python3 scripts/stress-test.py [port]
"""
import sys, json, time, resource, urllib.request

args = sys.argv[1:]
def get_port():
    if args:
        return int(args[0])
    try:
        with open("/tmp/splice-dev-api.port") as f:
            return int(f.read().strip())
    except:
        return 19990

PORT = get_port()
BASE = f"http://127.0.0.1:{PORT}"

def _req(method, path, body=None):
    data = json.dumps(body or {}).encode() if body is not None else None
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method,
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=10) as r:
        result = json.loads(r.read())
    return result, (time.perf_counter() - t0) * 1000

def get(path):     return _req("GET",  path)[0]
def post(path, b): return _req("POST", path, b)[0]

def drain_logs(show_all=False):
    """Drain /dev/logs and print errors/warnings (or everything if show_all)."""
    try:
        entries = get("/dev/logs")
    except Exception:
        return
    for e in entries:
        lvl = e.get("level", "log")
        if show_all or lvl in ("error", "warn"):
            print(f"  [{lvl.upper():5}] {e.get('message','')}")

def state():
    t0 = time.perf_counter()
    s = get("/dev/state")
    ms = (time.perf_counter() - t0) * 1000
    return s, ms

def rss():
    v = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return v / 1_048_576 if sys.platform == "darwin" else v / 1_024

# ── setup ──────────────────────────────────────────────────────────────────
print(f"\n{'═'*60}")
print(f"  Splice Stress Test  →  {BASE}")
print(f"{'═'*60}\n")

try:
    get("/dev/ping")
    print("  ✓  dev server reachable")
except Exception as e:
    print(f"  FATAL: {e}"); sys.exit(1)

post("/dev/reset", {})
time.sleep(1.5)
post("/dev/open-folder", {"path": "/tmp/splice-demo/api"})

# Wait up to 8s for workspace to appear
for _ in range(16):
    time.sleep(0.5)
    s, ms = state()
    if s["workspaces"]:
        break
else:
    print("  FATAL: workspace not created after 8s"); sys.exit(1)
tid_start = len(s["workspaces"][0]["terminalIds"])
print(f"  baseline: {tid_start} terminal,  state={ms:.0f}ms,  rss={rss():.1f}MB\n")

# ── splits ─────────────────────────────────────────────────────────────────
print(f"  Spawning 99 more terminals (0.8s gaps)...\n")
directions = ["vertical", "horizontal"]
profile_rows = []

for i in range(1, 100):
    post("/dev/split-pane", {"direction": directions[i % 2]})
    time.sleep(0.8)

    if i % 10 == 0:
        s, ms = state()
        ws = s["workspaces"][0] if s["workspaces"] else {}
        n = len(ws.get("terminalIds", []))
        depth_ok = "✓" if n == i + 1 else f"✗ (expected {i+1})"
        profile_rows.append((i + 1, n, ms))
        print(f"  split {i:>3}  →  {n:>3} terminals {depth_ok:20}  state={ms:.0f}ms")
        drain_logs()

# ── final count ────────────────────────────────────────────────────────────
time.sleep(1.0)
s, ms = state()
ws = s["workspaces"][0] if s["workspaces"] else {}
final_count = len(ws.get("terminalIds", []))

print(f"\n  Final: {final_count}/100 terminals")
drain_logs(show_all=True)
if final_count < 100:
    print(f"  ✗  stopped at {final_count}")
else:
    print(f"  ✓  all 100 terminals created")

# ── htop ───────────────────────────────────────────────────────────────────
if final_count > 0:
    print(f"\n  Launching htop in all {final_count} terminals...")
    for tid in ws.get("terminalIds", []):
        post("/dev/run-terminal", {"cmd": "htop\r", "terminalId": tid})
    time.sleep(3.0)

    s, htop_ms = state()
    ws2 = s["workspaces"][0] if s["workspaces"] else {}
    print(f"  state with htop running: {htop_ms:.0f}ms  (terminals: {len(ws2.get('terminalIds', []))})")

# ── profile table ──────────────────────────────────────────────────────────
print(f"\n  ┌{'─'*8}┬{'─'*12}┬{'─'*12}┬{'─'*10}┐")
print(f"  │ {'Event':>6} │ {'Expected':>10} │ {'Actual':>10} │ {'State ms':>8} │")
print(f"  ├{'─'*8}┼{'─'*12}┼{'─'*12}┼{'─'*10}┤")
for expected, actual, ms in profile_rows:
    ok = "✓" if actual == expected else "✗"
    print(f"  │ {expected:>6} │ {expected:>10} │ {actual:>9}{ok} │ {ms:>8.0f} │")
print(f"  └{'─'*8}┴{'─'*12}┴{'─'*12}┴{'─'*10}┘")

# ── cleanup ────────────────────────────────────────────────────────────────
try:
    post("/dev/reset", {})
except:
    pass
