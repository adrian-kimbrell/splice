#!/usr/bin/env python3
"""
Splice dev API integration test suite.
Calls the internal HTTP API and looks for bugs, stale data, and invariant violations.

Usage:
    python3 scripts/dev-api-test.py [--stress] [port]

    --stress   Run the 100-terminal htop stress test (slow, ~3 min)
    port       Dev server port (default: reads /tmp/splice-dev-api.port)
"""

import sys
import json
import time
import resource
import urllib.request
import urllib.error

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

args = sys.argv[1:]
RUN_STRESS = "--stress" in args
args = [a for a in args if not a.startswith("--")]

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

# ---------------------------------------------------------------------------
# Profiling state
# ---------------------------------------------------------------------------

_section_start: float = 0.0
_section_name: str = ""
_suite_start: float = 0.0

# Per-section: { name -> { wall_ms, calls, call_ms_list, state_ms_list } }
_profiles: dict = {}

def _current_rss_mb() -> float:
    """RSS in MB. ru_maxrss is bytes on macOS, KB on Linux."""
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "darwin":
        return rss / 1_048_576
    return rss / 1_024

def _record_call(elapsed_ms: float, is_state: bool):
    if not _section_name:
        return
    p = _profiles[_section_name]
    p["calls"] += 1
    p["call_ms"].append(elapsed_ms)
    if is_state:
        p["state_ms"].append(elapsed_ms)

def _close_section():
    global _section_start
    if _section_name and _section_start:
        _profiles[_section_name]["wall_ms"] = (time.perf_counter() - _section_start) * 1000

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def get(path):
    t0 = time.perf_counter()
    req = urllib.request.Request(f"{BASE}{path}")
    with urllib.request.urlopen(req, timeout=8) as r:
        result = json.loads(r.read())
    elapsed = (time.perf_counter() - t0) * 1000
    _record_call(elapsed, path == "/dev/state")
    return result

def post(path, body=None):
    t0 = time.perf_counter()
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        result = json.loads(r.read())
    elapsed = (time.perf_counter() - t0) * 1000
    _record_call(elapsed, path == "/dev/state")
    return result

def state():
    return get("/dev/state")

def wait(secs):
    time.sleep(secs)

# ---------------------------------------------------------------------------
# Assertion helpers
# ---------------------------------------------------------------------------

PASS = 0
FAIL = 0
WARN = 0
_section = ""

def section(name):
    global _section, _section_name, _section_start
    _close_section()
    _section = name
    _section_name = name
    _section_start = time.perf_counter()
    _profiles[name] = {"wall_ms": 0.0, "calls": 0, "call_ms": [], "state_ms": []}
    print(f"\n{'═'*60}")
    print(f"  {name}")
    print('═'*60)

def ok(label):
    global PASS
    PASS += 1
    print(f"  ✓  {label}")

def fail(label, detail=""):
    global FAIL
    FAIL += 1
    msg = f"  ✗  {label}"
    if detail:
        msg += f"\n       → {detail}"
    print(msg)

def warn(label, detail=""):
    global WARN
    WARN += 1
    msg = f"  ⚠  {label}"
    if detail:
        msg += f"\n       → {detail}"
    print(msg)

def check(label, condition, detail=""):
    if condition:
        ok(label)
    else:
        fail(label, detail)

def assert_eq(label, got, expected):
    if got == expected:
        ok(f"{label}: {got!r}")
    else:
        fail(f"{label}", f"expected {expected!r}, got {got!r}")

# ---------------------------------------------------------------------------
# Invariant checks on workspace state
# ---------------------------------------------------------------------------

def check_workspace_invariants(ws, label=""):
    prefix = f"[{label}] " if label else ""
    name = ws.get("name", "?")

    # terminalIds matches terminals list
    tid_list = ws.get("terminalIds", [])
    terminals = ws.get("terminals", [])
    terminal_ids_in_detail = {t["id"] for t in terminals}
    tid_set = set(tid_list)

    if tid_set != terminal_ids_in_detail:
        extra_in_list = tid_set - terminal_ids_in_detail
        extra_in_detail = terminal_ids_in_detail - tid_set
        fail(f"{prefix}{name}: terminalIds vs terminals mismatch",
             f"only in terminalIds: {extra_in_list}, only in terminals detail: {extra_in_detail}")
    else:
        ok(f"{prefix}{name}: terminalIds matches terminals list {sorted(tid_list)}")

    # pane terminal IDs match terminalIds
    panes = ws.get("panes", [])
    terminal_pane_ids = {p["terminalId"] for p in panes if p.get("kind") == "terminal" and p.get("terminalId") is not None}
    if terminal_pane_ids != tid_set:
        fail(f"{prefix}{name}: pane terminalIds vs terminalIds mismatch",
             f"panes have {terminal_pane_ids}, terminalIds has {tid_set}")
    else:
        ok(f"{prefix}{name}: pane terminalIds consistent with terminalIds")

    # layout leaf IDs match pane IDs
    layout = ws.get("layout")
    pane_ids = {p["id"] for p in panes}
    if layout:
        leaf_ids = collect_layout_leaves(layout)
        if leaf_ids != pane_ids:
            fail(f"{prefix}{name}: layout leaves vs panes mismatch",
                 f"leaves: {leaf_ids}, panes: {pane_ids}")
        else:
            ok(f"{prefix}{name}: layout leaves match pane IDs {leaf_ids}")
    else:
        if pane_ids:
            fail(f"{prefix}{name}: layout is null but panes exist {pane_ids}")
        else:
            ok(f"{prefix}{name}: layout null with no panes (clean)")

    # no duplicate terminalIds
    if len(tid_list) != len(tid_set):
        fail(f"{prefix}{name}: duplicate terminalIds {tid_list}")
    else:
        ok(f"{prefix}{name}: no duplicate terminalIds")

    # terminal titles are unique within workspace
    titles = [p.get("title", "") for p in panes if p.get("kind") == "terminal"]
    if len(titles) != len(set(titles)):
        fail(f"{prefix}{name}: duplicate terminal titles {titles}")
    else:
        ok(f"{prefix}{name}: terminal titles unique {titles}")

    # active terminal is in terminalIds
    active = ws.get("activeTerminalId")
    if active is not None and active not in tid_set:
        fail(f"{prefix}{name}: activeTerminalId {active} not in terminalIds {tid_list}")
    else:
        ok(f"{prefix}{name}: activeTerminalId {active} valid")

def collect_layout_leaves(node):
    if node.get("type") == "leaf":
        return {node["paneId"]}
    result = set()
    for child in node.get("children", []):
        result |= collect_layout_leaves(child)
    return result

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_ping():
    section("PING")
    r = get("/dev/ping")
    check("ping returns ok:true", r.get("ok") is True)

def test_initial_state():
    section("INITIAL STATE SHAPE")
    s = state()
    check("state has ui key", "ui" in s)
    check("state has workspaces key", "workspaces" in s)
    check("state has notifications key", "notifications" in s)
    check("state has activeWorkspaceId key", "activeWorkspaceId" in s)
    ui = s.get("ui", {})
    for field in ["explorerVisible", "workspacesVisible", "prMode", "zenMode", "sidebarMode"]:
        check(f"ui.{field} present", field in ui)

def test_clean_reset():
    section("RESET — CLEAN STATE")
    post("/dev/reset")
    wait(1.5)
    s = state()
    assert_eq("workspaces count after reset", len(s["workspaces"]), 0)
    assert_eq("activeWorkspaceId after reset", s["activeWorkspaceId"], None)
    assert_eq("notifications after reset", len(s["notifications"]), 0)
    assert_eq("prMode after reset", s["ui"]["prMode"], False)
    assert_eq("zenMode after reset", s["ui"]["zenMode"], False)

def test_open_folder():
    section("OPEN FOLDER — WORKSPACE CREATION")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.5)

    s = state()
    check("one workspace created", len(s["workspaces"]) == 1)
    ws = s["workspaces"][0]
    assert_eq("workspace name", ws["name"], "api")
    assert_eq("workspace rootPath", ws["rootPath"], "/tmp/splice-demo/api")
    check("has exactly one terminal", len(ws["terminalIds"]) == 1)
    check("layout is leaf", ws.get("layout", {}).get("type") == "leaf")
    check("terminal title is Terminal 1", ws["panes"][0]["title"] == "Terminal 1")
    check("CWD set", ws["terminals"][0]["cwd"] is not None)
    cwd = ws["terminals"][0]["cwd"]
    check(f"CWD is api dir ({cwd})", "splice-demo/api" in (cwd or ""))
    check_workspace_invariants(ws, "after open-folder")
    return ws

def test_terminal_split():
    section("SPLIT — INCREMENT")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.5)

    s = state()
    ws = s["workspaces"][0]
    t1_id = ws["terminalIds"][0]

    post("/dev/split-pane", {"direction": "vertical"}); wait(0.8)
    s = state(); ws = s["workspaces"][0]

    check("two terminals after split", len(ws["terminalIds"]) == 2)
    check("two panes after split", len(ws["panes"]) == 2)
    check("layout is split", ws.get("layout", {}).get("type") == "split")
    check("original terminal still present", t1_id in ws["terminalIds"])
    titles = sorted([p["title"] for p in ws["panes"] if p.get("kind") == "terminal"])
    assert_eq("terminal titles", titles, ["Terminal 1", "Terminal 2"])
    check_workspace_invariants(ws, "after split")
    return ws

def test_terminal_kill_decrement():
    section("KILL — DECREMENT & NO STALE DATA")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.5)
    post("/dev/split-pane", {"direction": "vertical"}); wait(0.8)

    s = state(); ws = s["workspaces"][0]
    check("setup: two terminals", len(ws["terminalIds"]) == 2)
    t1_id, t2_id = ws["terminalIds"][0], ws["terminalIds"][1]

    # Kill the second terminal
    post("/dev/kill-pane", {"terminalId": t2_id}); wait(0.8)
    s = state(); ws = s["workspaces"][0]

    assert_eq("one terminal after kill", len(ws["terminalIds"]), 1)
    assert_eq("one pane after kill", len(ws["panes"]), 1)
    check("killed terminal removed from terminalIds", t2_id not in ws["terminalIds"])
    check("killed terminal removed from terminals detail", t2_id not in [t["id"] for t in ws["terminals"]])
    check("surviving terminal intact", t1_id in ws["terminalIds"])
    check_workspace_invariants(ws, "after kill")

def test_number_reuse():
    section("NUMBER REUSE — kill Terminal 2, split gets Terminal 2 back")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.5)
    post("/dev/split-pane", {"direction": "vertical"}); wait(0.8)

    s = state(); ws = s["workspaces"][0]
    t2_id = next(p["terminalId"] for p in ws["panes"] if p.get("title") == "Terminal 2")

    post("/dev/kill-pane", {"terminalId": t2_id}); wait(0.8)
    post("/dev/split-pane", {"direction": "vertical"}); wait(0.8)

    s = state(); ws = s["workspaces"][0]
    titles = sorted([p["title"] for p in ws["panes"] if p.get("kind") == "terminal"])
    assert_eq("titles after reuse", titles, ["Terminal 1", "Terminal 2"])
    new_t2_id = next(p["terminalId"] for p in ws["panes"] if p.get("title") == "Terminal 2")
    check("new Terminal 2 has different Rust ID than old", new_t2_id != t2_id)
    check_workspace_invariants(ws, "after reuse")

def test_multiple_splits():
    section("MULTIPLE SPLITS — three terminals")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.5)
    post("/dev/split-pane", {"direction": "vertical"}); wait(0.6)
    post("/dev/split-pane", {"direction": "vertical"}); wait(0.6)

    s = state(); ws = s["workspaces"][0]
    check("three terminals", len(ws["terminalIds"]) == 3)
    titles = sorted([p["title"] for p in ws["panes"] if p.get("kind") == "terminal"])
    assert_eq("terminal titles", titles, ["Terminal 1", "Terminal 2", "Terminal 3"])
    check_workspace_invariants(ws, "three terminals")

def test_run_terminal_output():
    section("RUN TERMINAL — command output appears in state")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.5)

    s = state(); tid = s["workspaces"][0]["terminalIds"][0]
    sentinel = "SPLICE_TEST_12345"
    post("/dev/run-terminal", {"cmd": f"echo {sentinel}\r", "terminalId": tid})
    wait(0.8)

    s = state(); ws = s["workspaces"][0]
    output = "\n".join(ws["terminals"][0].get("recentOutput", []))
    check(f"sentinel '{sentinel}' appears in output", sentinel in output, f"got: {output!r}")

def test_multiple_workspaces():
    section("MULTIPLE WORKSPACES — isolation")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/web"}); wait(1.2)

    s = state()
    check("two workspaces", len(s["workspaces"]) == 2)
    names = sorted([ws["name"] for ws in s["workspaces"]])
    assert_eq("workspace names", names, ["api", "web"])

    # Terminal IDs must not overlap
    all_tids = []
    for ws in s["workspaces"]:
        all_tids.extend(ws["terminalIds"])
    check("no terminal ID overlap between workspaces", len(all_tids) == len(set(all_tids)),
          f"IDs: {all_tids}")

    # Split in each workspace independently
    post("/dev/switch-workspace", {"index": 0}); wait(0.3)
    post("/dev/split-pane", {"direction": "vertical"}); wait(0.8)
    post("/dev/switch-workspace", {"index": 1}); wait(0.3)
    post("/dev/split-pane", {"direction": "vertical"}); wait(0.8)

    s = state()
    for ws in s["workspaces"]:
        check(f"{ws['name']}: two terminals after independent splits",
              len(ws["terminalIds"]) == 2)
        check_workspace_invariants(ws, ws["name"])

    # All 4 terminal IDs unique globally
    all_tids = []
    for ws in s["workspaces"]:
        all_tids.extend(ws["terminalIds"])
    check("all 4 terminal IDs globally unique", len(all_tids) == len(set(all_tids)))

def test_close_workspace():
    section("CLOSE WORKSPACE — terminals cleaned up")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/web"}); wait(1.2)
    post("/dev/split-pane", {"direction": "vertical"}); wait(0.8)

    s = state()
    check("setup: two workspaces", len(s["workspaces"]) == 2)
    web_ws = next(ws for ws in s["workspaces"] if ws["name"] == "web")
    web_tids = set(web_ws["terminalIds"])

    post("/dev/close-workspace", {"id": web_ws["id"]}); wait(1.0)
    s = state()

    assert_eq("one workspace after close", len(s["workspaces"]), 1)
    assert_eq("remaining workspace is api", s["workspaces"][0]["name"], "api")

    # Closed workspace terminals must not appear in remaining state
    remaining_tids = set(s["workspaces"][0]["terminalIds"])
    overlap = remaining_tids & web_tids
    check("no closed workspace terminals in remaining state", not overlap,
          f"leaked: {overlap}")

def test_notifications():
    section("NOTIFICATIONS — inject, check, clear")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.5)
    s = state(); tid = s["workspaces"][0]["terminalIds"][0]

    post("/dev/notify", {"terminalId": tid, "notifType": "permission", "message": "Allow: ls"})
    wait(0.3)
    s = state()
    notifs = s["notifications"]
    check("one notification", len(notifs) == 1)
    check("correct terminalId", notifs[0]["terminalId"] == tid)
    check("correct type", notifs[0]["type"] == "permission")
    check("correct message", notifs[0]["message"] == "Allow: ls")

    # Clear specific
    post("/dev/clear-notify", {"terminalId": tid}); wait(0.3)
    s = state()
    assert_eq("notifications cleared", len(s["notifications"]), 0)

    # Multiple notifications, clear all
    post("/dev/notify", {"terminalId": tid, "notifType": "idle", "message": "Done"})
    post("/dev/notify", {"terminalId": tid + 1, "notifType": "permission", "message": "rm"})
    wait(0.3)
    s = state()
    check("two notifications", len(s["notifications"]) == 2)
    post("/dev/clear-notify", {}); wait(0.3)
    s = state()
    assert_eq("all notifications cleared", len(s["notifications"]), 0)

def test_ui_state():
    section("UI STATE — set and verify")
    post("/dev/reset"); wait(1.0)

    post("/dev/ui", {"prMode": True, "explorerVisible": False, "zenMode": True,
                     "sidebarMode": "search"}); wait(0.3)
    s = state()
    assert_eq("prMode", s["ui"]["prMode"], True)
    assert_eq("explorerVisible", s["ui"]["explorerVisible"], False)
    assert_eq("zenMode", s["ui"]["zenMode"], True)
    assert_eq("sidebarMode", s["ui"]["sidebarMode"], "search")

    post("/dev/ui", {"prMode": False, "explorerVisible": True, "zenMode": False,
                     "sidebarMode": "files"}); wait(0.3)
    s = state()
    assert_eq("prMode reset", s["ui"]["prMode"], False)
    assert_eq("explorerVisible reset", s["ui"]["explorerVisible"], True)
    assert_eq("zenMode reset", s["ui"]["zenMode"], False)
    assert_eq("sidebarMode reset", s["ui"]["sidebarMode"], "files")

def test_switch_workspace():
    section("SWITCH WORKSPACE")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/web"}); wait(1.2)

    s = state()
    ws_ids = [ws["id"] for ws in s["workspaces"]]

    # Switch by index
    post("/dev/switch-workspace", {"index": 0}); wait(0.3)
    s = state()
    assert_eq("switch to index 0", s["activeWorkspaceId"], ws_ids[0])

    post("/dev/switch-workspace", {"index": 1}); wait(0.3)
    s = state()
    assert_eq("switch to index 1", s["activeWorkspaceId"], ws_ids[1])

    # Switch by id
    post("/dev/switch-workspace", {"id": ws_ids[0]}); wait(0.3)
    s = state()
    assert_eq("switch by id", s["activeWorkspaceId"], ws_ids[0])

def test_open_file():
    section("OPEN FILE — appears in workspace state")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.5)
    post("/dev/open-file", {"path": "/tmp/splice-demo/api/src/main.rs"}); wait(0.5)

    s = state(); ws = s["workspaces"][0]
    paths = [f["path"] for f in ws["openFiles"]]
    check("main.rs in openFiles", "/tmp/splice-demo/api/src/main.rs" in paths,
          f"openFiles: {paths}")

def test_reset_is_clean():
    section("RESET CLEANLINESS — no leaking terminals")
    post("/dev/reset"); wait(1.2)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.2)
    post("/dev/split-pane", {"direction": "vertical"}); wait(0.8)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/web"}); wait(1.2)
    post("/dev/split-pane", {"direction": "vertical"}); wait(0.8)

    s = state()
    pre_tids = []
    for ws in s["workspaces"]:
        pre_tids.extend(ws["terminalIds"])
    check(f"setup: 4 terminals before reset", len(pre_tids) == 4, f"got: {pre_tids}")

    post("/dev/reset"); wait(2.0)
    s = state()
    assert_eq("0 workspaces after reset", len(s["workspaces"]), 0)
    assert_eq("activeWorkspaceId None", s["activeWorkspaceId"], None)

    # Open fresh workspace — terminals should start fresh (no crossover with old IDs in state)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.5)
    s = state(); ws = s["workspaces"][0]
    new_tids = set(ws["terminalIds"])
    # Rust IDs are monotonic so no overlap is expected anyway, but state should be clean
    check("new workspace has exactly 1 terminal", len(new_tids) == 1)
    check_workspace_invariants(ws, "after reset+open")

# ---------------------------------------------------------------------------
# Profiling report
# ---------------------------------------------------------------------------

def _fmt_ms(ms: float) -> str:
    if ms >= 1000:
        return f"{ms/1000:.2f}s"
    return f"{ms:.0f}ms"

def _fmt_mb(mb: float) -> str:
    return f"{mb:.1f} MB"

def print_profile_report(total_wall_ms: float, peak_rss_mb: float):
    print(f"\n{'─'*60}")
    print(f"  Performance Profile")
    print(f"{'─'*60}")

    # Header
    col_w = [28, 8, 7, 9, 9]
    hdr = f"  {'Section':<{col_w[0]}}  {'Time':>{col_w[1]}}  {'Calls':>{col_w[2]}}  {'Avg':>{col_w[3]}}  {'State':>{col_w[4]}}"
    print(hdr)
    print(f"  {'─'*col_w[0]}  {'─'*col_w[1]}  {'─'*col_w[2]}  {'─'*col_w[3]}  {'─'*col_w[4]}")

    all_call_ms = []
    all_state_ms = []

    for name, p in _profiles.items():
        wall = p["wall_ms"]
        calls = p["calls"]
        call_ms = p["call_ms"]
        state_ms = p["state_ms"]
        all_call_ms.extend(call_ms)
        all_state_ms.extend(state_ms)

        avg_call = (sum(call_ms) / len(call_ms)) if call_ms else 0
        avg_state = (sum(state_ms) / len(state_ms)) if state_ms else 0

        short_name = name[:col_w[0]]
        state_col = _fmt_ms(avg_state) if state_ms else "—"
        print(f"  {short_name:<{col_w[0]}}  {_fmt_ms(wall):>{col_w[1]}}  {calls:>{col_w[2]}}  {_fmt_ms(avg_call):>{col_w[3]}}  {state_col:>{col_w[4]}}")

    # Totals row
    total_calls = len(all_call_ms)
    avg_all = (sum(all_call_ms) / total_calls) if all_call_ms else 0
    avg_state_all = (sum(all_state_ms) / len(all_state_ms)) if all_state_ms else 0
    slowest_call = max(all_call_ms) if all_call_ms else 0
    slowest_state = max(all_state_ms) if all_state_ms else 0

    print(f"  {'─'*col_w[0]}  {'─'*col_w[1]}  {'─'*col_w[2]}  {'─'*col_w[3]}  {'─'*col_w[4]}")
    print(f"  {'TOTAL':<{col_w[0]}}  {_fmt_ms(total_wall_ms):>{col_w[1]}}  {total_calls:>{col_w[2]}}  {_fmt_ms(avg_all):>{col_w[3]}}  {_fmt_ms(avg_state_all):>{col_w[4]}}")

    print(f"\n  Slowest single call  : {_fmt_ms(slowest_call)}")
    print(f"  Slowest /dev/state   : {_fmt_ms(slowest_state)}")
    print(f"  Script RSS (peak)    : {_fmt_mb(peak_rss_mb)}")
    print(f"{'─'*60}")

# ---------------------------------------------------------------------------
# Stress test — 100 terminals + htop
# ---------------------------------------------------------------------------

def test_100_terminals_htop():
    section("STRESS — 100 terminals + htop")

    post("/dev/reset"); wait(1.5)
    post("/dev/open-folder", {"path": "/tmp/splice-demo/api"}); wait(1.5)

    rows: list[tuple[int | str, float, float]] = []  # (label, state_ms, rss_mb)

    def snapshot(label: int | str) -> tuple[dict, float]:
        t0 = time.perf_counter()
        s = get("/dev/state")
        elapsed = (time.perf_counter() - t0) * 1000
        rows.append((label, elapsed, _current_rss_mb()))
        return s, elapsed

    # Snapshot at 1 terminal (baseline)
    snapshot(1)

    directions = ["vertical", "horizontal"]
    print(f"\n  Spawning 99 more terminals (this takes ~90s)...")
    for i in range(1, 100):
        direction = directions[i % 2]
        post("/dev/split-pane", {"direction": direction})
        wait(0.8)

    # Wait a moment for the last few spawns to settle, then measure at checkpoints
    wait(1.0)
    for n in [10, 25, 50, 75, 100]:
        snapshot(n)

    # Final count check
    s = get("/dev/state")
    ws = s["workspaces"][0]
    actual = len(ws["terminalIds"])
    check(f"100 terminals created", actual == 100, f"got {actual}")

    # Run htop in every terminal
    print(f"\n  Launching htop in all {actual} terminals...")
    for tid in ws["terminalIds"]:
        post("/dev/run-terminal", {"cmd": "htop\r", "terminalId": tid})
    wait(3.0)  # let htop settle

    # State fetch with all htop running
    t0 = time.perf_counter()
    s = get("/dev/state")
    htop_state_ms = (time.perf_counter() - t0) * 1000
    htop_rss = _current_rss_mb()
    rows.append((-1, htop_state_ms, htop_rss))  # -1 = "100 + htop"

    ws = s["workspaces"][0]
    check(f"still 100 terminals with htop running", len(ws["terminalIds"]) == 100)
    check_workspace_invariants(ws, "100 terminals + htop")

    # Print scaling table
    print(f"\n  ┌{'─'*12}┬{'─'*12}┬{'─'*10}┐")
    print(f"  │ {'Terminals':>10} │ {'State (ms)':>10} │ {'RSS (MB)':>8} │")
    print(f"  ├{'─'*12}┼{'─'*12}┼{'─'*10}┤")
    for n, ms, rss in rows:
        label = "100 + htop" if n == -1 else str(n)
        print(f"  │ {label:>10} │ {ms:>10.0f} │ {rss:>8.1f} │")
    print(f"  └{'─'*12}┴{'─'*12}┴{'─'*10}┘")

    # Regression flags
    if rows:
        baseline_ms = rows[0][1]  # 1-terminal state fetch
        peak_ms = max(r[1] for r in rows)
        warn_threshold = baseline_ms * 20
        if peak_ms > warn_threshold:
            warn(f"state fetch degraded >20x vs baseline ({baseline_ms:.0f}ms → {peak_ms:.0f}ms)")
        else:
            ok(f"state fetch scaling acceptable ({baseline_ms:.0f}ms → {peak_ms:.0f}ms, {peak_ms/baseline_ms:.1f}x)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global _suite_start
    _suite_start = time.perf_counter()

    print(f"\n{'█'*60}")
    print(f"  Splice Dev API Test Suite  →  {BASE}")
    if RUN_STRESS:
        print(f"  Mode: STRESS (100-terminal htop test included)")
    print(f"{'█'*60}")

    try:
        get("/dev/ping")
    except Exception as e:
        print(f"\n  FATAL: Cannot reach dev server at {BASE}")
        print(f"  {e}")
        sys.exit(1)

    try:
        test_ping()
        test_initial_state()
        test_clean_reset()
        test_open_folder()
        test_terminal_split()
        test_terminal_kill_decrement()
        test_number_reuse()
        test_multiple_splits()
        test_run_terminal_output()
        test_multiple_workspaces()
        test_close_workspace()
        test_notifications()
        test_ui_state()
        test_switch_workspace()
        test_open_file()
        test_reset_is_clean()
        if RUN_STRESS:
            test_100_terminals_htop()
    except KeyboardInterrupt:
        print("\n\n  Interrupted.")
    except Exception as e:
        fail("UNEXPECTED EXCEPTION", str(e))
        import traceback; traceback.print_exc()
    finally:
        _close_section()
        _section_name = ""  # don't attribute cleanup call to last section
        try:
            post("/dev/reset")
        except:
            pass

    total_wall_ms = (time.perf_counter() - _suite_start) * 1000
    peak_rss_mb = _current_rss_mb()

    print(f"\n{'═'*60}")
    total = PASS + FAIL + WARN
    print(f"  Results: {PASS}/{total} passed  |  {FAIL} failed  |  {WARN} warnings")
    print('═'*60)

    print_profile_report(total_wall_ms, peak_rss_mb)

    sys.exit(0 if FAIL == 0 else 1)

if __name__ == "__main__":
    main()
