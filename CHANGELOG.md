# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-09-24

### Added
- `open(options)` and `listDatabases()` JS API (Promise and callback styles).
- Native hosts for Android (`WebView`, Java) and iOS (`WKWebView`, Obj-C) over a shared async bridge.
- Discovery of every SQLite file in the app sandbox, with detection (but no opening) of encrypted databases.
- Table browser: row counts, sizes, OutSystems logical entity names, system-table toggle.
- Data grid with pagination, sorting, search and row detail; BLOB and base64 image previews, hex dump, save to file.
- Structure view (columns, indexes, foreign keys, triggers, DDL), relations (declared and inferred), column statistics.
- Visual query builder with suggested joins, aggregates, nested filters, grouping, sorting and limits.
- SQL editor with highlighting, completion, formatting, `EXPLAIN QUERY PLAN` and cancellation; `:parameters`.
- Query presets with JSON import/export, database scoping and builder state; presets passed via `open()`; query history.
- Database info, quick integrity check and a consistent database export.
- Light/dark themes following the system, phone and tablet layouts, Android predictive back support.
- Always read-only connections.
- Web version of the inspector (`web/`, deployable to Cloudflare Pages): SQLite in WebAssembly over a lazy, read-only File VFS with WAL overlay, drag & drop, demo database, strict CSP.
- Generic host hooks in the inspector page (`window.DbInspectorHost`, `addFiles`, `context.canAddFiles` / `canClose`, `window.__dbiDatabasesChanged`).

[Unreleased]: https://github.com/henriquefps/cordova-plugin-db-inspector/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/henriquefps/cordova-plugin-db-inspector/releases/tag/v1.0.0
