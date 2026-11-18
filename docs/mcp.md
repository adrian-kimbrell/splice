# Agents that drive Splice (MCP)

Splice can act as an MCP server, so a coding agent can control the app it is running in. It is **off by default**.

## Turn it on

Settings → Integrations → **MCP Server**.

Splice then registers a server named `splice` with Claude Code and Codex, using their own CLIs (`claude mcp add-json --scope user`, `codex mcp add`). The settings page shows whether each registration worked. Agent sessions started after that see the tools; sessions already running need a restart. Turning the switch off removes both registrations.

When the switch is off, the endpoint answers 404 and nothing is registered. There is no extra process, thread, timer or port either way: the endpoint is one more route on the local server Splice already runs for agent notifications.

## Tools

| Tool | What it does |
|---|---|
| `spawn_agent` | Start Claude (or Codex) on a task. `target: "new_terminal"` opens a pane in the caller's workspace; `target: "new_workspace"` with a `path` opens that folder as a workspace. The `task` text becomes the new agent's first prompt. |
| `list_terminals` | Terminals open in Splice: workspace, pane title, agent, model, and whether the agent is waiting for input or a permission. |
| `read_terminal` | The last lines of a terminal, to check on a delegated agent. |
| `inbox_add` / `inbox_list` / `inbox_read` / `inbox_delete` | The inbox (below). |
| `list_webhooks` / `send_webhook` | Send a message to a configured outbound webhook. |

So, in a Claude session inside Splice:

> ok I'm happy with the plan. Open a new Claude terminal and have it implement step 2.

> Open ~/code/api as a new workspace and start an agent there on the failing auth tests.

Splice shows a toast whenever an agent starts another one, naming the terminal that asked.

## Inbox

The inbox is a sidebar tab holding items sent with `inbox_add`: research results, a task request, notes. Nothing in it runs by itself. Open an item to read it, then **Start Claude** (new terminal in the current workspace, with the item as the brief), copy it, or delete it. When an item is handed to an agent it is labelled as content from a third party, not instructions from you.

## Outbound webhooks (Splice → Grok Bot)

Settings → Integrations → Outbound webhooks. Add a name, the URL and the key.

For Grok Bot: create a routine, add a **webhook** trigger, and copy its URL and key into Splice. Pick the header your routine's help page shows for the key (`Authorization: Bearer` or `X-Webhook-Secret`). "Send test" posts a test message.

Splice POSTs JSON:

```json
{ "text": "<the message>", "source": "splice", "workspace": "<workspace name or null>" }
```

An agent sends with `send_webhook`, for example: "send this question to grok-bot to research". Only HTTPS URLs are accepted. Keys are kept in `webhooks.json` in the Splice config folder, readable only by you, and are never shown again or given to agents.

## Remote access (Grok Bot → Splice)

A cloud agent cannot reach your machine directly, so this takes a tunnel.

1. Settings → Integrations → turn on **Remote Access**. Splice shows a header: `Authorization: Bearer <token>`.
2. Point a tunnel at the local endpoint shown on that page, for example:
   ```
   cloudflared tunnel --url http://127.0.0.1:19876
   ```
3. In Grok Bot, add a custom connector (MCP server): the tunnel URL ending in `/mcp`, transport "streamable HTTP", and the header from step 1.

What a remote caller can do:

| | Remote token | Agent in a Splice terminal |
|---|---|---|
| Add an inbox item | yes | yes |
| List terminals | only with "Remote Callers Can List Terminals" | yes |
| Read a terminal, start an agent, send a webhook, read the inbox | never | yes |

So Grok Bot can deliver findings or a task request to your inbox, and you decide what happens next. "Regenerate" on the settings page replaces the token at once.

The local token is refused when a request names any host other than `127.0.0.1` / `localhost`, so it cannot be used through the tunnel. A tunnel forwards the whole port, so every other endpoint on it (the agent notification hooks) refuses such requests too: `/mcp` with the remote token is the only thing reachable from outside. Requests carrying a browser `Origin` header are refused outright.

## Limits

- Request body 256 KB; task brief 100 KB; inbox item 64 KB, 200 items; webhook message 64 KB.
- 60 requests a second for local agents, 20 for the remote token (answered with 429 and `Retry-After: 1` beyond that).
- `spawn_agent` is not available in SSH workspaces (the brief is a local file).
