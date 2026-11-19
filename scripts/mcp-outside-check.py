"""Outside-caller checks for the Splice MCP endpoint.

Run from another machine against a tunnel URL (or an SSH-forwarded port) with
Remote Access on:  mcp-outside-check.py https://<tunnel>/mcp REMOTE_TOKEN [LOCAL_TOKEN]
Checks the handshake, that the remote scope is confined to inbox_add, auth and
Origin refusals, malformed input, and the rate limit. Adds a few inbox items.
The rate-limit check needs a fast path (sequential requests over the internet
may never reach the limit).
"""
import json, sys, time, urllib.request, urllib.error
URL, REMOTE = sys.argv[1], sys.argv[2]
LOCAL = sys.argv[3] if len(sys.argv) > 3 else None
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
results = []
def post(body, headers=None, raw=None, timeout=20):
    h = {"Content-Type": "application/json", "User-Agent": "ext-client/1"}
    h.update(headers or {})
    data = raw if raw is not None else json.dumps(body).encode()
    req = urllib.request.Request(URL, data=data, headers=h, method="POST")
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
def auth(tok): return {"Authorization": "Bearer " + tok}
def rpc(method, params=None, tok=REMOTE, id=1):
    return post({"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}, auth(tok))
def call(name, args, tok=REMOTE):
    st, body = rpc("tools/call", {"name": name, "arguments": args}, tok)
    return st, (json.loads(body) if body else {})
def check(name, ok, detail=""):
    results.append(ok); print(("PASS  " if ok else "FAIL  ") + name + (("   [" + str(detail)[:140] + "]") if detail and not ok else ""))
def pace(): time.sleep(0.25)   # remote scope allows 5 requests a second

st, body = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "ext", "version": "1"}})
j = json.loads(body) if st == 200 else {}
check("handshake: initialize answers 200 with serverInfo splice", st == 200 and j.get("result", {}).get("serverInfo", {}).get("name") == "splice", (st, body))
pace(); st, body = post({"jsonrpc": "2.0", "method": "notifications/initialized"}, auth(REMOTE))
check("handshake: initialized notification is accepted with 202 and no body", st == 202 and body == "", (st, body))
pace(); st, body = rpc("tools/list")
names = [t["name"] for t in json.loads(body)["result"]["tools"]] if st == 200 else []
check("scope: remote tool list is exactly [inbox_add]", names == ["inbox_add"], names)
for name, args in [("spawn_agent", {"task": "rm -rf ~"}), ("read_terminal", {"terminal_id": 1}), ("list_terminals", {}),
                   ("send_webhook", {"name": "x", "message": "x"}), ("inbox_list", {}), ("inbox_read", {"id": "x"}),
                   ("inbox_delete", {"id": "x"}), ("list_webhooks", {})]:
    pace(); st, j = call(name, args)
    check("scope: remote call to %s is refused as unknown" % name, st == 200 and j.get("error", {}).get("code") == -32602, (st, j))
pace(); st, j = call("inbox_add", {"title": "From takeshi", "body": "ünïcödé ✓ body\nline 2", "source": "ext-client"})
text = j.get("result", {}).get("content", [{}])[0].get("text", "")
check("inbox_add from outside succeeds", st == 200 and j.get("result", {}).get("isError") is False and "id " in text, (st, j))
pace(); st, j = call("inbox_add", {"title": "", "body": "x"})
check("inbox_add with empty title is a tool error, not a crash", st == 200 and j.get("result", {}).get("isError") is True, (st, j))
pace(); st, j = call("inbox_add", {"title": "big", "body": "x" * 70000})
check("inbox_add over 64 KB is a tool error", st == 200 and j.get("result", {}).get("isError") is True, (st, j))
pace(); st, j = call("inbox_add", {"title": 5, "body": ["not", "a", "string"]})
check("inbox_add with wrong argument types is a tool error", st == 200 and j.get("result", {}).get("isError") is True, (st, j))
pace(); st, body = post(None, auth("0" * 32), raw=b'{"jsonrpc":"2.0","id":1,"method":"ping"}')
check("auth: wrong token is 401", st == 401, st)
pace(); st, body = post(None, {}, raw=b'{"jsonrpc":"2.0","id":1,"method":"ping"}')
check("auth: no token is 401", st == 401, st)
pace(); st, body = post({"jsonrpc": "2.0", "id": 1, "method": "ping"}, dict(auth(REMOTE), Origin="https://evil.example"))
check("browser: a request with an Origin header is 403", st == 403, st)
pace(); st, body = post(None, auth(REMOTE), raw=b"{ not json")
check("malformed JSON gets a JSON-RPC parse error (-32700)", st == 200 and json.loads(body).get("error", {}).get("code") == -32700, (st, body))
pace(); st, body = rpc("resources/list")
check("unknown method gets -32601", st == 200 and json.loads(body).get("error", {}).get("code") == -32601, (st, body))
pace(); st, body = post([{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}], auth(REMOTE))
check("a JSON-RPC batch gets one reply per request", st == 200 and len(json.loads(body)) == 2, (st, body[:120]))
time.sleep(1.2)
codes = [rpc("ping")[0] for _ in range(60)]
check("rate limit: a burst of 60 gets some 429s and some 200s", 429 in codes and 200 in codes, codes)
time.sleep(1.2)
check("rate limit: service resumes after a second", rpc("ping")[0] == 200)
if LOCAL:
    pace(); st, body = rpc("tools/list", tok=LOCAL)
    check("the LOCAL token presented from outside: status %s" % st, True)
    print("      (local token over this path gave HTTP %s)" % st)
print("\n%d/%d passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
