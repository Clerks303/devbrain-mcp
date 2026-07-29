# Contributing to devbrain-mcp

Thanks for your interest! Issues and pull requests are welcome.

## Getting started

```bash
git clone https://github.com/Clerks303/devbrain-mcp.git
cd devbrain-mcp
npm install
npm run build
npm test
```

Requirements: Node.js >= 20 and a C++ toolchain if prebuilt binaries are not
available for your platform (`better-sqlite3`, `sqlite-vec` are native modules).

## Development workflow

| Command             | Purpose                                  |
|---------------------|------------------------------------------|
| `npm run dev`       | TypeScript compiler in watch mode        |
| `npm test`          | Run the Vitest suite                     |
| `npm run test:watch`| Vitest in watch mode                     |
| `npm run lint`      | ESLint (zero warnings expected)          |
| `npm run typecheck` | `tsc --noEmit` (strict mode)             |

Before opening a PR, make sure `npm run lint`, `npm run typecheck` and
`npm test` all pass — CI runs the same three on Node 20 and 22.

## Guidelines

- **Tests first.** New behavior comes with a test that fails without the change.
  Repositories and stores are tested against in-memory SQLite; see
  `tests/db/` for the pattern.
- **Strict TypeScript.** No `any` (enforced by ESLint), no unchecked casts.
  Map raw SQLite rows through the `to*()` mappers in `src/db/repositories/`.
- **Validate at the boundary.** MCP tool inputs use Zod schemas; HTTP hook
  payloads are validated in `src/api/hook-handlers.ts`. Anything crossing a
  process boundary gets validated.
- **Parameterized SQL only.** Never interpolate user data into SQL strings.
- **Small, focused commits** using conventional commit prefixes
  (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`).

## Architecture notes

Key design decisions (SQLite vs Postgres, hybrid FTS5 + vector search with
Reciprocal Rank Fusion, embedding provider abstraction) are documented in
[`docs/CHOICES.md`](docs/CHOICES.md) with their trade-offs and migration
paths. Read it before proposing structural changes.

## Reporting issues

Please include your OS, Node version, the MCP client used (Claude Code,
Claude Desktop, Cursor…), and the relevant `DEVBRAIN_*` env vars (redact any
API keys). For search/ranking issues, a minimal reproduction with a few
entities is worth a thousand words.
