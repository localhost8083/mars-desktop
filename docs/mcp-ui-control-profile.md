# Control MarsAI from any MCP client

MarsAI exposes its UI as an MCP server so any MCP-capable app can read what's on screen and run actions — no DOM scraping, no coordinates, no accessibility hacks.

## Why this exists

Apps like HandsFree let people control their computers hands-free using AI. But generic computer-use flows (screenshot → click coordinate) are slow, fragile, and need a vision model for every step.

MarsAI takes a different approach: the app itself tells you what actions are available, what the current state is, and lets you execute actions by name. The MCP server wraps that surface so any MCP client gets a first-class, semantic control experience out of the box.

This means:

- **HandsFree** can drive MarsAI sessions, composer, navigation, and transcript without guessing pixels.
- **OpenCode** can automate MarsAI as part of a larger coding workflow.
- **Claude Desktop, Codex, Cursor**, or any MCP-compatible tool can add MarsAI control with a single config line.
- Your own app can do the same.

> Want to control MarsAI Cloud workers and server APIs instead of the desktop UI? Check out the **MarsAI Cloud MCP** (separate package, coming soon).

## Quick start with HandsFree

HandsFree auto-discovers the MarsAI MCP server when both apps are running on the same machine. No config needed.

1. Launch **MarsAI** (desktop app).
2. Launch **HandsFree**.
3. Open the HandsFree connector panel — you should see **MarsAI** with a green "Connected" status and an action count.

That's it. HandsFree can now list your sessions, read transcripts, type into the composer, send prompts, and navigate the app — all through MCP.

### What HandsFree can do once connected

- `ui_snapshot` — see the current route, status, and available actions.
- `ui_list_actions` — get every action the app currently exposes (session controls, composer, navigation, etc.).
- `ui_execute_action` — run an action by ID, e.g. `session.create_task`, `composer.set_text`, `composer.send`.
- `ui_status` — check if MarsAI is running and the bridge is reachable.

### Cross-session memory

MarsAI's cross-session memory currently comes from saved session history exposed through the UI control surface. It is not a separate long-term memory database.

For requests like `What did I say in the customer migration session?` or `Remind me what we decided in session ses_abc123`, an MCP client can:

1. Run `session.list_sessions` to find a matching session by ID, title, workspace, or topic words.
2. Run `session.open` with the selected `sessionId`.
3. Run `session.read_transcript` to read recent messages from that session.
4. Answer from the returned transcript, and say when the returned messages are insufficient.

This may navigate MarsAI away from the user's current session while the lookup runs. If multiple sessions match, ask which one to inspect.

### MarsAI agents

Inside MarsAI, agents control the app through the semantic tools (`mars_context`, `mars_query`, `mars_execute`) using affordance ids from context. External MCP clients can also use the hidden **MarsAI UI Control** MCP via **Settings -> Extensions -> Show hidden**.

## Install

Nothing to install. The UI-control MCP ships inside the MarsAI desktop app
as a single bundled file and runs with the app's own binary in Node mode:

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/mars.app/Contents/MacOS/mars" \
  "/Applications/mars.app/Contents/Resources/mars-ui-mcp/index.mjs"
```

The paths above are the macOS default. **Settings -> Extensions -> UI Control**
shows the exact command, environment, and client config for your installation.

> `mars-ui-mcp` is **not** published on npm. Never configure it as
> `npx mars-ui-mcp` or install it with `npm install`: a package with that
> name on a public registry is not the UI-control MCP. mars-server refuses
> to store or launch any MCP command that resolves `mars-ui-mcp` by name
> (`npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec`, a global install). On
> startup the desktop app rewrites a stored `npx -y mars-ui-mcp` command to
> the bundled one; a standalone server removes it, and UI control is
> reconnected from the desktop app.
>
> Configs outside the app are not migrated. If desktop 1.0.8 or earlier gave
> you the `npx` snippet for Claude Desktop, Cursor, or OpenCode, or wrote it
> into a workspace `opencode.json`, replace it with the command shown in
> **Settings -> Extensions -> UI Control**.

## Add to OpenCode

Add the MCP server to your workspace or global `opencode.json`, using the
command shown in the app:

```json
{
  "mcp": {
    "mars-ui": {
      "type": "local",
      "command": [
        "/Applications/mars.app/Contents/MacOS/mars",
        "/Applications/mars.app/Contents/Resources/mars-ui-mcp/index.mjs"
      ],
      "environment": { "ELECTRON_RUN_AS_NODE": "1" },
      "enabled": true
    }
  }
}
```

Then use the tools in any session:

```
> Use ui_snapshot to see what's on screen in MarsAI, then list the available sessions.
```

## Add to Claude Desktop or Codex

Both use the same MCP config shape. Add to your `claude_desktop_config.json` or Codex MCP settings:

```json
{
  "mcpServers": {
    "mars-ui": {
      "command": "/Applications/mars.app/Contents/MacOS/mars",
      "args": ["/Applications/mars.app/Contents/Resources/mars-ui-mcp/index.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Restart the app. The four tools (`ui_status`, `ui_snapshot`, `ui_list_actions`, `ui_execute_action`) will appear in the tool list.

## Add to your own MCP client

If you're building an app that speaks MCP, you can connect to the MarsAI UI server the same way:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "/Applications/mars.app/Contents/MacOS/mars",
  args: ["/Applications/mars.app/Contents/Resources/mars-ui-mcp/index.mjs"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(transport);

// Check if MarsAI is running
const status = await client.callTool({ name: "ui_status", arguments: {} });
console.log(status);

// See what actions are available
const actions = await client.callTool({ name: "ui_list_actions", arguments: {} });
console.log(actions);

// Type something into the composer
await client.callTool({
  name: "ui_execute_action",
  arguments: { actionId: "composer.set_text", args: { text: "Hello from my app" } },
});
```

## Tool reference

### `ui_status`

Check if MarsAI is running and reachable. Returns connection status and app info.

**No arguments.**

Example response:

```
Connected to MarsAI
Bridge: http://127.0.0.1:52431
Version: 1
```

### `ui_snapshot`

Get the current MarsAI UI state: active route, narration, visible actions, and status. Call this before acting to understand what the user sees.

**No arguments.**

Example response:

```
Route: /session/ses_abc123
Status: ready
Narration: Ready. A controller can inspect and run visible actions.

Actions (26):
  session.create_task — Create a new task
  session.list_sessions — List available sessions
  composer.set_text — Type into the composer [text]
  composer.send — Send the composer prompt
  ...
```

### `ui_list_actions`

List all UI control actions currently available. Each action has an `id` you can pass to `ui_execute_action`.

**No arguments.**

Returns the full list with labels, descriptions, and argument info.

### `ui_execute_action`

Execute an MarsAI UI action by its id.

| Argument | Type | Description |
|----------|------|-------------|
| `actionId` | string | The action id from `ui_list_actions`, e.g. `session.create_task` or `composer.set_text` |
| `args` | object (optional) | JSON arguments for the action, if required |

Example — list sessions:

```json
{ "actionId": "session.list_sessions" }
```

Example — type into the composer:

```json
{ "actionId": "composer.set_text", "args": { "text": "Summarize this project" } }
```

Example — send the composer prompt:

```json
{ "actionId": "composer.send" }
```

## Available actions

The exact list depends on the current MarsAI route and state. Common actions include:

| Action | Description |
|--------|-------------|
| `session.create_task` | Create a new session in the selected workspace |
| `session.list_sessions` | List sessions across workspaces |
| `session.open` | Navigate to a session by ID |
| `session.rename` | Rename a session |
| `session.delete` | Delete a session (requires confirmation) |
| `session.latest_message` | Read the latest message in the current session |
| `session.read_transcript` | Read the last N messages as text |
| `composer.set_text` | Type text into the composer (visible typing animation) |
| `composer.send` | Send the current draft |
| `composer.stop` | Stop a running session |
| `session.scroll_top` | Scroll to the top of the transcript |
| `session.scroll_bottom` | Scroll to the bottom |
| `route.session` | Navigate to the session view |
| `route.settings.*` | Navigate to various settings pages |
| `command_palette.open` | Open the command palette |
| `session.model_picker.open` | Open the model picker |
| `status.docs.open` | Open documentation |

## Requirements

- **MarsAI desktop** must be running. The MCP server connects to MarsAI's local bridge which starts automatically when the desktop app launches.
- **macOS** is the primary supported platform. The bridge uses Electron IPC and writes a discovery file to `~/Library/Application Support/ai.marsai.desktop/`.
- The MCP server runs as a **stdio** process — your MCP client spawns it and communicates over stdin/stdout.

## How it works under the hood

```
┌─────────────┐     MCP stdio      ┌──────────────────┐     HTTP localhost     ┌──────────────┐
│  MCP client  │ ←────────────────→ │  mars-ui-mcp │ ←───────────────────→ │  MarsAI app │
│  (HandsFree, │                    │  (Node.js)       │                       │  (Electron)   │
│   OpenCode,  │                    │                  │                       │               │
│   Codex)     │                    └──────────────────┘                       └──────────────┘
└─────────────┘
```

1. MarsAI desktop starts a private localhost HTTP bridge on a random port, protected by a bearer token.
2. It writes a discovery file with the port and token so `mars-ui-mcp` can find it.
3. `mars-ui-mcp` reads the discovery file, proxies MCP tool calls to the bridge, and returns structured results.
4. The bridge calls `window.__marsControl` inside the Electron renderer to snapshot state and execute actions.

The bridge and discovery file are implementation details — you never need to touch them directly. Just point your MCP client at the bundled `mars-ui-mcp/index.mjs` shown in the app.
