[![repotato](https://repotato.sh/api/badge/frkak-piyaz)](https://repotato.sh/p/frkak-piyaz)

# maus-mcp

MCP server that gives Claude Code, Cursor, Codex and other MCP clients
access to your **[Maus](https://mausformac.com)** clipboard on macOS.

Local-only. No cloud. No clipboard content ever leaves your Mac. Respects
your Maus tier (Free vs Pro) automatically.

## Why

When Claude writes you an email, a SQL query, a regex or a snippet,
copying it back out of the chat terminal drags monospace formatting,
markdown asterisks and extra whitespace into your destination app.

With Maus + this MCP, the agent can put text **straight into your Maus
history**. You paste from Maus into Mail / Slack / wherever — clean.

It also lets the agent search, list, and tidy your clipboard history,
including OCR text from screenshots.

## Requirements

- **macOS** (Maus is macOS-only; this MCP reads its local SQLite).
- **[Maus](https://mausformac.com)** installed and running.
- **Node.js ≥ 20**.

## Install

### Claude Code

```bash
claude mcp add -s user maus -- npx maus-mcp@latest
```

The `-s user` flag installs Maus globally for your user so it works in every
project. Without it, the MCP only loads in the directory where you ran the
command.

Restart Claude Code (close every session, open a new one) and try:

> *"Maus, show me my last 5 clipboard items"*

### Cursor

Add to your Cursor MCP config (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "maus": {
      "command": "npx",
      "args": ["maus-mcp@latest"]
    }
  }
}
```

### Other MCP clients

Anything that supports the [Model Context Protocol](https://modelcontextprotocol.io)
stdio transport. Run `npx maus-mcp@latest` directly.

## Tools

| Tool | What it does |
|---|---|
| `list_recent` | Latest items chronologically, with filters. |
| `search` | Substring search across content, titles, source apps, URLs, **and OCR text of screenshots**. |
| `get` | Fetch one item by id. For images: returns OCR + a token-light reduced JPEG. |
| `set_title` | Rename an item. Lets the agent organise the clipboard. |
| `forget` | Permanently delete one item (by id) or many (by filter). |
| `add_item` | Write a clean text item into Maus history. Maus Pro only. |

## Pro vs Free

The MCP follows your Maus tier exactly:

- **Free**: full access to the last 24 hours of history.
- **Pro**: full history + advanced filters (`source_apps`, `content_patterns`) + writes (`add_item`).

When the agent requests something beyond your tier, the response carries
an upgrade link so the agent can offer it in context.

[Upgrade to Maus Pro →](https://mausformac.lemonsqueezy.com/checkout/buy/fa311099-77f7-4b0d-8d39-eab756710f15)

## Privacy

Maus MCP does not send your clipboard content anywhere. No queries, no
titles, no text from items.

The server does report anonymous usage shape (which tool was called, how
long it took, your Maus tier) so the maintainer can see what's used and
what's broken. Opt out with `MAUS_MCP_TELEMETRY=off`.

## Development

```bash
git clone https://github.com/mausformac/maus-mcp.git
cd maus-mcp
npm install
npm run dev    # run with tsx (live TypeScript)
npm run build  # compile to dist/
```

Manual testing without an MCP client:

```bash
node test_get.mjs
node test_list_recent.mjs
node test_search.mjs
node test_set_title.mjs
node test_forget.mjs
MAUS_MCP_TIER_OVERRIDE=pro node test_add_item.mjs
```

## License

[MIT](./LICENSE)

## Links

- [Maus](https://mausformac.com)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Report a bug](https://github.com/mausformac/maus-mcp/issues)
