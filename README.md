# cordova-plugin-db-inspector

**A read-only SQLite inspector and visual query builder that runs inside your mobile app.** Browse any SQLite database in the app sandbox, understand its structure and data, and build queries visually. It works on Android and iOS, in Cordova, Capacitor/Ionic and OutSystems apps.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-Android%20%7C%20iOS-lightgrey.svg)
![Cordova](https://img.shields.io/badge/cordova--android-%E2%89%A510-green.svg)
![Cordova](https://img.shields.io/badge/cordova--ios-%E2%89%A56-green.svg)

```javascript
cordova.plugins.DbInspector.open();
```

That call opens a full-screen native screen (Android `WebView` / iOS `WKWebView`) over your app. You don't need to pull the database off the device, root it, or make the build debuggable.

> 🌐 **Already have a `.db` file you want to inspect?** Open it at **[db-inspector.hfps.dev](https://db-inspector.hfps.dev)**. Drop the file on the page and you get the same inspector, no install needed. The file is opened **in your browser** and is never uploaded anywhere. Try it with the [demo database](https://db-inspector.hfps.dev/?demo).

---

## Why

Hybrid apps keep most of their state in local SQLite: offline data, sync queues, OutSystems local entities. When something goes wrong on a device, that data is effectively invisible. `adb run-as` only works on debuggable Android builds, iOS offers nothing comparable, and neither lets you *query* the data where it lives. This plugin puts a proper database tool inside the app, where the data is.

## Features

**Explore**
- Database picker listing every SQLite file in the sandbox, with size, WAL size and modification time. Encrypted files are detected and flagged.
- Table list with row counts and on-disk size. OutSystems databases show **logical entity names** next to the physical `OSUSR_*` tables.
- Data grid with pagination, sorting and search, plus a row detail sheet.
- Rich value viewers: JSON pretty-printing, image preview for BLOBs **and for base64 text** (how OutSystems stores Binary Data), a hex dump, and save-to-file.
- Structure: columns, indexes, foreign keys, triggers, formatted DDL.
- Relations: declared foreign keys plus relations **inferred** from `<Entity>Id` naming, in both directions.
- Column statistics: nulls, distinct count, min/max/avg, lengths, storage types, most frequent values.

**Query**
- Visual query builder: FROM → JOIN (suggested joins, automatic `ON`) → columns & aggregates → nested AND/OR filters → GROUP BY → ORDER BY → LIMIT, with live SQL.
- SQL editor with syntax highlighting, context-aware completion (`alias.` → columns), formatter, `EXPLAIN QUERY PLAN` as a tree, and cancellation.
- `:parameters`, filled in at run time.
- Export results as CSV / JSON.

**Keep**
- **Presets**: saved queries with description, tags, an optional database scope and the builder state (they reopen visually). They import and export as **JSON**, and your team's presets can ship with the app.
- History of the last 60 queries.

**Maintain**
- Database info: pages, free space, journal mode, versions, largest tables.
- Quick integrity check.
- **Export the database** as a consistent single-file copy (WAL included). The original file is never touched.

**Everywhere**
- Light and dark themes (following the system), a phone layout and a tablet two-pane layout, and Android hardware/predictive back.
- A single self-contained HTML UI: no CDN, works offline.

## Safe by design

- **Read-only.** Every connection is opened with `SQLITE_OPEN_READONLY`, so nothing in the inspector, including SQL typed in the console, can modify the app's data.
- **No SQLCipher.** Encrypted databases are listed but never opened. The plugin doesn't try to obtain another plugin's key.
- **No permissions, no network, no background work.** Files are saved and imported through the system pickers. The plugin does nothing until `open()` or `runQueries()` is called.
- **Read statements only, headless too.** `runQueries()` uses the same read-only connection and accepts only `SELECT`, `WITH`, `VALUES`, `PRAGMA` and `EXPLAIN`.
- **Not exported.** The Android activity can't be launched by other apps.

> ⚠️ **Don't ship an open door.** The inspector shows everything in local storage to whoever holds the device. Use it in debug/support builds, or gate `open()` behind a support role or a hidden gesture. `runQueries()` lets any JavaScript in the app read the local databases without showing the UI, so gate it exactly like `open()`. See [Keeping it out of production](docs/integration.md#keeping-it-out-of-production).

## Compatibility

| | Supported | Verified |
|---|---|---|
| Cordova | cordova-android ≥ 10, cordova-ios ≥ 6 | Cordova CLI 12 · cordova-android 15.1 · cordova-ios 8.1 |
| Capacitor | via the Cordova compatibility layer (CocoaPods or SPM) | Capacitor 8.5 (SPM) |
| OutSystems | O11 & ODC mobile apps (MABS) | OutSystems local storage database |
| Android | 7.0+ (API 24) | Android 16, targetSdk 36 |
| iOS | 13+ | iOS 26.6 (iPhone) |

No native dependencies: platform `android.database.sqlite` (Java) and the system `libsqlite3` (Obj-C).

## Install

```bash
# Cordova
cordova plugin add cordova-plugin-db-inspector

# Capacitor / Ionic
npm install cordova-plugin-db-inspector
npx cap sync
```

**OutSystems:** create a library or module with this Extensibility Configuration, then call the plugin from a client action:

```json
{ "buildConfigurations": { "cordova": { "source": { "url": "https://github.com/henriquefps/cordova-plugin-db-inspector.git#v1.1.0" } } } }
```

The full [integration guide](docs/integration.md) covers Cordova, Capacitor and OutSystems, the client actions (`OpenInspector`, `ListDatabases`, `RunQueries`), production gating and troubleshooting.

## Usage

```javascript
// Open (resolves once the screen is shown)
await cordova.plugins.DbInspector.open();

// With options
await cordova.plugins.DbInspector.open({
  database: 'bg_sync.db',     // file name or id to select first
  title: 'Support tools',     // header title
  presets: teamPresetsJson    // merged into the saved presets
});

// List database files without opening the UI
const dbs = await cordova.plugins.DbInspector.listDatabases();
// → [{ id: 'databases/bg_sync.db', name: 'bg_sync.db', size: 45056, walSize: 0, encrypted: false, … }]
```

### Run queries without the UI

`runQueries()` runs a batch of read-only queries against one database and resolves with plain JSON. It's for automated extraction, checks or syncing from app code, for example an OutSystems client action:

```javascript
const out = await cordova.plugins.DbInspector.runQueries({
  database: 'bg_sync.db',                 // file name or id, like open({ database })
  queries: [
    { name: 'pending', sql: 'SELECT * FROM sync_queue WHERE Status = :s', params: { s: 1 } },
    { name: 'count', sql: 'SELECT count(*) AS n FROM sync_queue' }
  ],                                      // or a presets document, or a JSON string of either
  maxRows: 1000                           // per query; default 1000, max 10000
});
// → { database: { id, name }, startedAt, durationMs,
//     results: [{ name, sql, columns, rows: [{ Id: 1, … }], rowCount, truncated, durationMs, error }] }
```

`options` can also be a JSON string. A query that fails gets its own `error` and the rest of the batch still runs. The promise rejects only when the batch can't run (unknown or encrypted database, invalid input). BLOBs come back as base64, and integers beyond 2^53 as strings. Details: [Running queries without the UI](docs/integration.md#running-queries-without-the-ui).

All methods return Promises and also accept `(success, error)` callbacks.

## Presets

```json
{
  "format": "hfps-db-inspector-presets",
  "version": 1,
  "presets": [
    {
      "id": "team_pending_sync",
      "name": "Pending sync records",
      "description": "Everything still waiting to be uploaded.",
      "sql": "SELECT * FROM sync_queue WHERE Status IN ('pending', 'failed')",
      "database": "bg_sync.db",
      "tags": ["sync"]
    }
  ]
}
```

Presets are merged by `id`. Import also accepts a bare array or a single preset. See [docs/presets.md](docs/presets.md) for every field, the merge rules, parameters and the builder state. The same document can be passed to `runQueries()` to run the presets headlessly.

## Web version — [db-inspector.hfps.dev](https://db-inspector.hfps.dev)

If you already have a database file (for example one exported from a device with *Info → Export database file*, pulled with `adb`, or copied from a simulator), open it at **https://db-inspector.hfps.dev** and inspect it with the same tools: tables, structure, relations, the query builder and presets.

- **Your file stays on your machine.** It's read in place by SQLite compiled to WebAssembly and is never uploaded. A strict Content-Security-Policy blocks connections to any other site.
- **Large files are fine.** Pages are read on demand, so a 500 MB database opens in a moment.
- **Pending WAL changes.** Drop the `-wal` file together with the `.db` to include changes that haven't been checkpointed yet.
- **Presets** export and import in the same JSON format as the app.
- **Demo:** [db-inspector.hfps.dev/?demo](https://db-inspector.hfps.dev/?demo) opens a fictional OutSystems-style database.

To run or deploy it yourself, see [docs/web.md](docs/web.md):

```bash
npm install && npm run web:dev    # http://localhost:8788 — add ?demo for the demo database
```

## Documentation

| | |
|---|---|
| [Integration guide](docs/integration.md) | Cordova, Capacitor/Ionic, OutSystems, API, production gating, troubleshooting |
| [Presets](docs/presets.md) | JSON format, merge rules, parameters, builder state |
| [Web version](docs/web.md) | Browser build: how it works, WAL handling, build, Cloudflare Pages deploy |
| [Architecture & development](docs/architecture.md) | Bridge protocol, actions, design decisions, dev harness, sample app, test checklist |
| [Changelog](CHANGELOG.md) | Release notes |

## Development

```bash
python3 dev/server.py        # UI in a desktop browser against ./test-data/*.db
cd sample-app && npm install && npx cap add android && npx cap run android
```

`test-data/` is git-ignored, so real databases stay on your machine. Details are in [docs/architecture.md](docs/architecture.md).

## License

[Apache License 2.0](LICENSE) © 2026 Henrique Silva
