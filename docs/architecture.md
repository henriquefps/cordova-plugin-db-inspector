# Architecture & development

## Layout

```
plugin.xml                        Cordova manifest (Android + iOS)
www/DbInspector.js                JS API: open(), listDatabases(), runQueries() (input parsing, parameter rewriting)
www/inspector/db-inspector.html   The whole inspector UI — one self-contained file, no dependencies, works offline
src/android/
  DbInspectorPlugin.java          CordovaPlugin: starts the activity / lists databases / runs headless query batches
  DbInspectorActivity.java        Full-screen WebView host, bridge, Storage Access Framework, insets, back handling
  DbInspectorEngine.java          Discovery + read-only SQLite introspection (android.database.sqlite)
src/ios/
  DbInspectorPlugin.{h,m}         CDVPlugin: presents the view controller / lists databases / runs headless query batches
  DbInspectorViewController.{h,m} Full-screen WKWebView host, bridge, share sheet, document picker
  DbInspectorEngine.{h,m}         Discovery + read-only SQLite introspection (libsqlite3)
dev/server.py                     Desktop harness: serves the page and a Python bridge over ./test-data
web/                              Browser build (wa-sqlite + lazy File VFS) — see docs/web.md
sample-app/                       Capacitor 8 app that installs the plugin from ../
scripts/                          Push ./test-data databases into the sample app (Android device / iOS simulator)
```

The two native engines implement the same actions with the same JSON shapes. `dev/server.py` is a third, Python implementation of that contract, so the UI can be developed in a desktop browser.

## Bridge protocol

The page talks to the native host with asynchronous request/response calls:

```
page  → native   invoke(callId, action, args)
native → page    window.__dbiResolve(callId, '{"ok":true,"data":…}' | '{"ok":false,"error":"…"}')
```

| Host | Page → native | Native → page |
|---|---|---|
| Android | `DbInspectorAndroid.invoke(id, action, argsJson)` (`@JavascriptInterface`) | `WebView.evaluateJavascript` |
| iOS | `webkit.messageHandlers.dbInspector.postMessage({callId, action, args})` | `WKWebView.evaluateJavaScript` |
| Web build | `DbInspectorHost.invoke(id, action, argsJson)` → Web Worker | `window.__dbiResolve` |
| Dev harness | `fetch('/bridge', {action, args})` | HTTP response |

Work runs on a single serial background thread / queue per inspector instance. The one exception is `interrupt`, which bypasses the queue, because the queue is busy with the query being cancelled. It uses `CancellationSignal` on Android and `sqlite3_interrupt` on iOS.

### Actions

| Action | Args | Returns |
|---|---|---|
| `context` | — | platform, OS version, device, app id/version, `systemDark` (Android), `options` passed to `open()` |
| `listDatabases` | — | `[{id, name, dir, size, walSize, journalSize, modified, encrypted, empty}]` |
| `overview` | `db` | tables/views with row counts, logical names, flags; index/trigger counts; `outsystems` |
| `tableSchema` | `db, table` | columns (`table_xinfo`), indexes with columns, FKs, triggers, DDL, OutSystems attrs |
| `tableRows` | `db, table, offset, limit, sortColumn, sortDir, search` | `{columns, rowids, rows, total}` with preview-encoded cells |
| `cell` | `db, table, rowid, column` | full value: `text`, or `base64` + `mime` for blobs, plus `truncated` |
| `columnStats` | `db, table, column` | total, nulls, distinct, min/max/avg, lengths, storage types, top 10 values |
| `query` | `db, sql, maxRows` | `{columns, rows, hasMore, timeMs}` |
| `interrupt` | — | cancels the running query |
| `dbInfo` | `db` | file sizes, pragmas, SQLite version, object counts |
| `tableSizes` | `db` | per-table bytes: `dbstat` when compiled in, else a payload estimate |
| `integrityCheck` | `db` | `PRAGMA quick_check(50)` rows |
| `exportDatabase` | `db` | consistent single-file copy → save dialog / share sheet |
| `saveFile` | `name, mime, content, base64` | save dialog / share sheet |
| `pickFile` | — | `{name, text}` (max 10 MB) |
| `storageGet` / `storageSet` | `key[, value]` | host key/value store |
| `setTheme` | `dark, color` | matches system bar / background to the page theme |
| `close` | — | dismisses the screen |
| `addFiles` | — | web only: opens the file picker, returns the new database ids |

### Headless batches (`runQueries`)

`runQueries()` doesn't use the page bridge. It is a regular Cordova action (`exec('DbInspector', 'runQueries', [request])`) that runs on the Cordova thread pool (Android) or `runInBackground` (iOS), with a fresh `DbInspectorEngine` whose connections are closed afterwards.

The JS module does the input work so both platforms stay small and identical:

1. Parses `options` / `queries` / `params` (objects or JSON strings), accepts a query array or a presets document, clamps `maxRows` (default 1000, max 10000).
2. Tokenizes each query (skipping literals and comments), rejects a second statement, and rewrites named parameters (`:name`, `@name`, `$name`) to numbered ones (`?1`, `?2`, …) with an `args` array. Positional `?` queries pass through with the array as given. Input errors become that query's `error` without reaching native code.
3. After native code answers, it turns row arrays into objects keyed by de-duplicated column names and adds `name`, `sql`, `rowCount` and `startedAt`.

Native request and response:

```
→ {database, queries: [{sql, args: [number|string|null], maxRows} | {error}]}
← {database: {id, name}, durationMs, results: [{columns, rows: [[cell]], truncated, durationMs, error}]}
```

The engines (`runQueries` in `DbInspectorEngine.java` / `.m`) resolve the database by id, then by file name (`findDatabase`), refuse encrypted files, check that the statement starts with `SELECT`, `WITH`, `VALUES`, `PRAGMA` or `EXPLAIN`, and bind `args` with their SQLite types. On Android, `rawQuery()` can only bind strings, so the values are bound on the compiled `SQLiteQuery` inside a `CursorFactory`, which also gets the 32 MB window. Cells are returned in full: `null`, number, string, BLOB as base64, and integers beyond ±2^53 as strings.

### Cell encoding

To keep the bridge light, cells are `null`, a number, a string, or an object for values that can't be shown inline:

```json
{ "$t": "text", "v": "<first 500 chars>", "len": 1287808 }
{ "$t": "blob", "len": 1048576, "mime": "image/jpeg", "hex": "ffd8ffe000104a46…" }
```

- In the grid, each column is projected as `CASE WHEN typeof(c)='text' AND length(c)>500 THEN substr(c,1,500) WHEN typeof(c)='blob' THEN substr(c,1,16) ELSE c END, length(c)`, so full BLOBs and long strings never leave SQLite.
- Integers beyond ±2^53 are sent as strings, so JavaScript doesn't silently round them.

## Design decisions

- **Always read-only.** Connections use `OPEN_READONLY` / `SQLITE_OPEN_READONLY`. On Android this also skips the journal-mode setup a writable open performs, which would otherwise switch a WAL database (OutSystems) to the platform default.
- **No SQLCipher.** Encrypted files are detected by their missing plaintext header and listed as unsupported. Opening them would require another plugin's key.
- **Export without touching the original.**
  - iOS: `VACUUM INTO` a temp file on the read-only connection.
  - Android: its read-only connections refuse `VACUUM`, so the main file and its `-wal` are copied to the cache dir and the WAL is checkpointed **into the copy**.
- **Large rows on Android.** The default `CursorWindow` is 2 MB. On API 28+ the query console and the full-value fetch use a 32 MB window, which avoids *"Row too big to fit into CursorWindow"*.
- **Predictive back.** Android 16 with targetSdk 36 no longer calls `onBackPressed()`. Back is routed through `OnBackInvokedCallback` on API 33+ and `onBackPressed()` below that, and the page gets first say via `window.__dbiBack()`.
- **System theme on Android.** The WebView's `prefers-color-scheme` follows the activity theme, not the system, so the real night mode is passed in `context.systemDark` and on `onConfigurationChanged`.
- **Java, not Kotlin.** No Kotlin Gradle preferences are needed, which keeps OutSystems MABS and older Cordova toolchains happy.
- **Single-file UI.** No build step, no CDN, and it works offline in any WebView from Android 7 / iOS 13.

## Developing

### UI in a desktop browser

```bash
mkdir -p test-data && cp /path/to/app.db test-data/
python3 dev/server.py            # http://localhost:8787 — reload to pick up HTML changes
DBI_NO_DBSTAT=1 python3 dev/server.py   # simulate a SQLite build without dbstat (like most Android devices)
```

### Sample app (Capacitor 8)

```bash
cd sample-app
npm install
npx cap add android && npx cap add ios    # first time only (generated folders are git-ignored)
npx cap sync                              # after every plugin change
npx cap run android                       # or: npx cap open ios
```

Load real databases into it (debuggable builds only):

```bash
scripts/push-test-dbs-android.sh          # → /data/data/<app>/databases/ via run-as
scripts/push-test-dbs-ios-sim.sh          # → Library/LocalDatabase on the booted simulator
```

On a physical iPhone, `xcrun devicectl device copy to --domain-type appDataContainer --domain-identifier <bundle-id> --source test-data/x.db --destination Library/LocalDatabase/x.db`.

### Debugging the inspector page on a device

In debug builds, the inspector's WebView is inspectable:

- Android: `WebView.setWebContentsDebuggingEnabled` when the app is debuggable. Use `chrome://inspect`.
- iOS 16.4+: `WKWebView.inspectable` under `#ifdef DEBUG`. Use Safari → Develop → *your device* → *DB Inspector*.

### Manual test checklist

- [ ] Database list shows every file, including encrypted (badge) and empty ones
- [ ] Table list: logical names, row counts, system toggle, sort by size
- [ ] Grid: paging, sorting, search, row sheet, base64 image preview, blob hex, save file
- [ ] Structure, Relations and column stats (tap a top value → filtered query)
- [ ] Builder: suggested join, aggregate + auto group-by, nested OR group, `:param`, Explain
- [ ] SQL editor: autocomplete after `alias.`, format, Ctrl/⌘+Enter, cancel a long query
- [ ] Write statement is rejected (read-only)
- [ ] Presets: save from builder, reopen visually, export → import (reports added/unchanged), examples
- [ ] Info: sizes, integrity check, export database
- [ ] Light/dark follows the system; hardware back closes modal → sub-view → inspector (Android)
