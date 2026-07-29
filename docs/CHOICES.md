# Technical Choices & Trade-offs

This document records the load-bearing technical decisions behind DevBrain and the
trade-offs each one accepts. It is intentionally honest about limits: every choice
below was made for a concrete reason, and most have a clear migration path if the
constraints change.

DevBrain is a **local, per-developer, per-project memory** for AI coding agents,
exposed as a Model Context Protocol (MCP) server. That single sentence drives almost
every decision here.

---

## 1. Storage: SQLite (better-sqlite3), not Postgres

**Decision.** Persist the knowledge graph in a single SQLite file per machine, opened
with `better-sqlite3` (synchronous API), WAL journaling, and `foreign_keys = ON`.

**Why.**
- The workload is single-process, single-writer, local. There are no multi-tenant
  clients, no network round-trips, no connection pool to manage.
- SQLite in WAL mode gives ACID transactions and concurrent reads with disk-local
  latency, and ships *inside* the MCP binary — zero server to install or operate for
  the end user (a "vibe coder" running Claude Code).
- The synchronous `better-sqlite3` API removes a whole class of async race conditions
  in the write path and keeps transactions trivially atomic.

**Trade-off accepted.** No out-of-the-box multi-machine sharing, no horizontal write
scaling. That is not a current requirement.

**Migration path.** Data access is encapsulated behind `KnowledgeStore` / `VectorStore`.
Moving to a shared backend (Postgres + pgvector) for *team* memory is a store
implementation swap, not a rewrite of the tool layer.

---

## 2. Search: hybrid FTS5 + vectors, fused with Reciprocal Rank Fusion

**Decision.** Run two retrievers in parallel — SQLite **FTS5** (lexical) and
**sqlite-vec** (`vec0` cosine KNN, semantic) — and merge their rankings with
**Reciprocal Rank Fusion** (RRF, `k = 60`), with per-source weights (entity 1.0,
name-match 0.9, observation 0.7, issue 0.6).

**Why.**
- Pure vector search misses exact lexical hits — symbol names, IDs, rare tokens — and
  pays an embedding round-trip on every query. FTS5 catches those instantly.
- Pure lexical search misses paraphrase and conceptual similarity. Vectors catch those.
- RRF combines the two *rankings* without having to calibrate absolute score scales
  across heterogeneous sources — the same intuition behind modern hybrid search in
  Elasticsearch / Weaviate.

**Trade-off accepted.** Two indexes to maintain and keep in sync (handled by FTS5 sync
triggers and explicit embedding upserts).

**Bonus.** Graceful degradation: if embeddings are unavailable, FTS5 alone still
returns useful results (see §3).

---

## 3. Embeddings: pluggable provider (OpenAI / Ollama / NoOp)

**Decision.** Embeddings go through an `EmbeddingProvider` interface with three
implementations:
- **OpenAI** `text-embedding-3-small` (1536d) — best quality, default when an API key
  is present.
- **Ollama** `nomic-embed-text` (768d) — fully local, private, free, with a bounded
  worker pool (concurrency 4).
- **NoOp** (zero-vector) — explicit, safe fallback that never throws.

All embedding calls are wrapped by `tryEmbed`, which logs failures and returns `null`
instead of propagating — embeddings are an *enhancement*, never a hard dependency.

**Why.**
- Privacy/cost/quality is a real trade-off the user should own, not one I should hardcode.
  `EMBEDDING_PROVIDER=ollama` keeps everything on-device.
- Dimension changes (1536 ↔ 768) are guarded: switching providers requires an explicit
  `DEVBRAIN_ALLOW_EMBEDDING_RECREATE=1` to drop/recreate the `vec0` tables, so you never
  silently corrupt an index by changing a model.

**Trade-off accepted.** The default path depends on an external API (OpenAI). Mitigated
by the local Ollama option and by FTS5-only degradation.

---

## 4. Concurrency model: single-writer, queue-serialized daemon

**Decision.** The MCP server is the primary writer. The optional background **daemon**
(file watcher + git/build/deps observers) writes through a **WriteQueue** that serializes
operations FIFO and retries `SQLITE_BUSY` with exponential backoff.

**Why.**
- One logical writer + WAL means readers never block and writes stay atomic.
- The queue absorbs bursts (e.g. a git rebase touching hundreds of files) without
  hammering the database, and the retry loop handles the brief contention window between
  the daemon's connection and the server's.

**Graph integrity.** Relations and observations carry `ON DELETE CASCADE` foreign keys
with `foreign_keys = ON`, and IDs are UUIDs — so there are no orphaned edges and no
primary-key collisions, even under concurrent agent activity.

**Known residual risk.** Entity/embedding desynchronization if a purge fails midway
(the `vec0` virtual tables can't carry a real FK to `entities`). Tracked as a follow-up:
a delete trigger to garbage-collect orphaned embeddings.

---

## 5. Transport: MCP over stdio — stdout is sacred

**Decision.** The server speaks JSON-RPC over **stdio** (SSE optional). Every diagnostic
in the server path goes to **stderr**; `console.log` (stdout) appears *only* in the CLI
binaries (`bin/`), never in server-loaded modules.

**Why.** A single stray byte on stdout corrupts the MCP framing and breaks the client.
Keeping stdout exclusively for protocol traffic is a hard correctness invariant, not a
style preference.

---

## 6. Security posture: local-first, defense where it matters

**Decision & rationale.**
- The hook HTTP server binds to **`127.0.0.1` only** and has **no auth** — *by design*,
  because the trust boundary is the local machine and the user already runs the agent at
  their own privilege. Adding tokens would be security theater for a localhost socket.
- All MCP tool inputs are validated with **Zod**; SQL is **always** parameterized
  (prepared statements, positional binding) — no string-concatenated queries, including
  FTS5 (special characters are stripped before binding).
- No secrets are committed; DB files, `.env`, keys and personal data are gitignored.

**Honest gaps (tracked, not hidden).** The hook server lacks a request-body size cap and
its handler bodies aren't yet Zod-validated; `scan_project` doesn't yet guard against
path traversal above the project root; user-facing text fields aren't length-bounded.
None are remotely exploitable given the localhost boundary, but they're on the hardening
list.

---

## 7. Current state & limits (v0.1.0)

- **Solid:** 398 passing tests, strict TypeScript (zero `any`), well-covered data layer,
  graph integrity via FK cascades, graceful embedding degradation. The former `db/store.ts`
  god object is split into per-aggregate repositories (`store.ts` is now a ~290-LOC facade).
  Coverage reporting is wired (`npm run test:coverage`, v8): ~56% lines / 61% functions /
  46% branches today.
- **Weakest spots (known):** line coverage trails the 80% target. The daemon git observer
  and the MCP `isError` error paths have end-to-end tests; the other observers
  (build/deps/file) still lack integration coverage. Cursor-based pagination exists in the
  entity/issue repositories but is not yet surfaced through the MCP tools.
- **Not yet built:** shared/team memory, a formal schema-migration system (snapshots are
  versioned, but there's no migration runner), and request hardening on the hook server.

These are deliberate scope boundaries for a single-developer v0.1, documented so the next
contributor (or interviewer) sees the reasoning rather than guessing at it.
