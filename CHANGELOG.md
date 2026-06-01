# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- ESLint flat config (`eslint.config.js`) with `typescript-eslint`, plus `lint` / `lint:fix` scripts.
- Coverage job in CI (Codecov upload) and a coverage badge in the README.
- `.env.example` documenting every supported environment variable.

## [0.1.0] - 2026-06-01

### Added
- MCP server exposing ~70 tools over stdio (JSON-RPC).
- Typed knowledge graph: entities, relations, observations, projects, traversal.
- Hybrid search fusing FTS5 full-text and `sqlite-vec` vector similarity via RRF.
- Embedding providers: OpenAI (1536d), Ollama (768d, local), and a NoOp fallback;
  the provider is inferred from configuration when unset.
- Sessions, rules (scoped global / file pattern / entity type), issues, lessons,
  goals, and snapshots.
- File digests with content-hash deduplication and symbol extraction.
- Git observer daemon with resume-from-HEAD and a serialized write queue.
- SQLite storage (WAL mode, foreign keys on) with automatic schema migration.

[Unreleased]: https://github.com/Clerks303/devbrain-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Clerks303/devbrain-mcp/releases/tag/v0.1.0
