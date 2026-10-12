# GHL Workflow MCP

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) read, create and edit **GoHighLevel workflows** through your own logged-in Chrome session.

It needs no API key and no marketplace app install. The server attaches to a Chrome window over the DevTools protocol, picks up the session token GoHighLevel already holds, and calls the same endpoints the workflow builder uses.

> **Status: 0.1.0, early release.** The write tools check every step against a strict shape validator before anything is saved, but always review a workflow in the GHL builder before you publish it.

## What you get

30 tools, all free:

| Area | Tools |
|---|---|
| Connection | `launch_chrome`, `reconnect`, `test_connection` |
| Read | `list_workflows`, `get_workflow`, `read_workflow_outline`, `read_workflow_step`, `audit_workflow` |
| Write | `create_workflow`, `update_workflow`, `patch_workflow`, `delete_workflow`, `publish_workflow`, `clone_workflow` |
| Folders | `list_folders`, `create_folder`, `rename_folder`, `delete_folder`, `move_workflow` |
| Location data | `list_tags`, `create_tag`, `list_users`, `list_pipelines`, `list_custom_fields`, `list_custom_values`, `list_associations`, `list_business_fields`, `list_forms`, `list_trigger_links`, `list_email_templates` |

`patch_workflow` applies small edits (insert, update, move or delete one step, or rewire a pointer) without resending the whole workflow. It rewires the step pointers on the server side, and it refuses the write if the workflow changed since you last read it.

## Requirements

- Node.js 20 or newer
- Google Chrome (or Chromium)
- A GoHighLevel account with access to the sub-account you want to work in

## Install

### Claude Code

```bash
claude mcp add ghl-workflow -- npx -y ghl-workflow-mcp
```

### Claude Desktop, Cursor and other MCP clients

Add this to your client's MCP config (for Claude Desktop that is `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ghl-workflow": {
      "command": "npx",
      "args": ["-y", "ghl-workflow-mcp"]
    }
  }
}
```

### From source

```bash
git clone <this repo>
cd ghl-workflow-mcp
npm install
npm test
node src/index.js --version
```

Then point your MCP client at `node /path/to/ghl-workflow-mcp/src/index.js`.

## Connecting to GoHighLevel

1. Ask Claude to connect to GoHighLevel. It calls `launch_chrome`, which opens a **dedicated** Chrome window. The window uses its own profile in `~/.ghl-wkfl-mcp/chrome-profile`, so your everyday browser is untouched.
2. Log in to GoHighLevel in that window and open the sub-account you want.
3. The server detects the sub-account and connects. `test_connection` confirms it.

To switch sub-accounts, change sub-account in that window, or call `reconnect` to pick a different tab.

If you would rather start Chrome yourself, launch it with the debug port:

```bash
google-chrome --remote-debugging-port=49222 --user-data-dir="$HOME/.ghl-wkfl-mcp/chrome-profile"
```

### Options

| Flag / env var | Default | Purpose |
|---|---|---|
| `--port <n>` / `GHL_MCP_CDP_PORT` | `49222` | Chrome DevTools debug port |
| `--no-kill-chrome-on-exit` | off | Leave the Chrome window open when the server stops |
| `--verbose` | off | Debug logging to stderr |
| `GHL_MCP_CACHE_DIR` | `~/.ghl-wkfl/cache` | Local cache of workflows read by `patch_workflow` |
| `--version` | | Print the version and exit |

## How writes are validated

Every action and trigger in a create, update or patch goes through a strict shape validator (`src/utils/action-shape-validator.js`). It checks each step against the registry in `src/registry/action-shapes.json`:

- Unknown step types are dropped, never sent.
- Steps whose attributes don't match the expected shape are dropped.
- Anything dropped is listed in `skippedActions[]`, with a reason, and advisory notes go in `warnings[]`.
- If anything was dropped, the workflow is saved as a **draft**, so a half-built workflow is never published.

The validator tells you a step is wrong. It does not tell you what every field means.

## The step reference: GHL Workflow Docs MCP

Building a correct workflow needs more than access. You need to know each trigger and action type's JSON shape, its required and optional fields, the allowed values, and how steps link together (`next`, if/else branches, waits, goto). That reference is published separately as the hosted **GHL Workflow Docs MCP**: a verified step reference with worked examples that your assistant can query while it builds. Connect both servers and Claude gets access plus the knowledge to use it well.

## Privacy and safety

- Everything runs on your machine. The server talks only to Chrome on `127.0.0.1` and to GoHighLevel's own endpoints, as you.
- No telemetry, no licence check and no phone-home.
- The session token is read from your browser and is never written to disk. The only local files are the dedicated Chrome profile and the workflow cache described above.
- The server can do anything your GHL user can do in the workflow builder, including deleting workflows. Use a user with the permissions you're comfortable giving an assistant.

## Development

```bash
npm install
npm test        # node --test 'src/**/*.test.js'
```

The tests run offline. GoHighLevel and Chrome are mocked, and all fixtures are synthetic.

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by or supported by HighLevel Inc. It uses the endpoints GoHighLevel's own web app uses, and those can change without notice.

## License

[MIT](LICENSE)
