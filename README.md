# devbrain-mcp

**Persistent project memory for AI coding agents.**
A [Model Context Protocol](https://modelcontextprotocol.io) server that maintains
a live knowledge graph of your codebase — entities, relations, decisions,
conventions, lessons — so Claude Code (or any MCP-compatible client) picks up
where the last session left off instead of starting from a blank slate.

DevBrain is the memory half of [AgentWeave × DevBrain](https://github.com/artefis):
an agentic desktop IDE for vibe coders. It also works standalone.

## Install

```bash
npm i -g devbrain-mcp
```

This installs the `devbrain-mcp` binary on your `PATH`.

## Quick start

### Claude Desktop / Claude Code

Add to your MCP config (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "devbrain": {
      "command": "devbrain-mcp",
      "env": {
        "DEVBRAIN_DB_PATH": "~/.devbrain/memory.db",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Restart the client. DevBrain now appears as a tool provider.

### Configuration (env vars)

| Variable                        | Default                        | Purpose                                              |
|---------------------------------|--------------------------------|------------------------------------------------------|
| `DEVBRAIN_DB_PATH`              | `./devbrain.db`                | SQLite file (WAL mode, auto-migrated).               |
| `DEVBRAIN_EMBEDDING_PROVIDER`   | `openai`                       | `openai`, `ollama`, or `none`.                       |
| `OPENAI_API_KEY`                | —                              | Required when provider is `openai`.                  |
| `DEVBRAIN_OLLAMA_URL`           | `http://localhost:11434`       | Ollama endpoint for local embeddings.                |
| `DEVBRAIN_LOG_LEVEL`            | `info`                         | `debug` / `info` / `warn` / `error`.                 |
| `DEVBRAIN_HOOK_PORT`            | `7384`                         | HTTP port for Claude Code hooks integration.         |

## What it gives your agent

DevBrain exposes **~54 MCP tools** across these categories:

- **Graph (15)** — entities, relations, observations, projects, traversal.
- **Files (5)** — content-hash digests, symbol extraction, fast file lookup.
- **Search (4)** — FTS5 full-text + vector similarity + hybrid ranking.
- **Issues (4)** — report / resolve / list known bugs and tech debt.
- **Sessions (5)** — session start/end with summary, auto-context on resume.
- **Rules (3)** — project conventions with scope (global / file pattern / entity type).
- **Lessons (4)** — learn from outcomes, recall on similar situations, reinforce.
- **Snapshots (3)** — label a state before risky refactors, diff across time.
- **Linking (3)** — bind files to entities / rules / issues.
- **Auto-context (2)** — one-call context retrieval for a task description.
- **Health & metrics (4)** — DB stats, embedding coverage, learning trends.

The full authoritative list is surfaced via the MCP `tools/list` request.

## Integration with AgentWeave

[AgentWeave](https://github.com/artefis/agentweave) is the companion desktop app.
It spawns `devbrain-mcp` as a sidecar, proxies the 54 tools over Tauri IPC, and
builds the visual project map and context-builder UI on top.

If AgentWeave finds `devbrain-mcp` on your `PATH` it will use it automatically;
otherwise you can set `DEVBRAIN_SCRIPT_PATH` to point at a local checkout's
`dist/src/index.js` for development.

## Development

```bash
git clone <repo>
cd devbrain
npm install
npm run build
npm test
```

Tests use Vitest. Build output goes to `dist/`. `npm run build` also applies a
shebang to binary entry points so `npm i -g` produces working CLI shims.

## License

MIT
