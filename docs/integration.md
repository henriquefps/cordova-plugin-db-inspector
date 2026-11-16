# Integration guide

How to add `cordova-plugin-db-inspector` to a Cordova, Ionic/Capacitor or OutSystems app, open it, and keep it out of the hands of end users.

- [Requirements](#requirements)
- [Cordova CLI](#cordova-cli)
- [Capacitor / Ionic](#capacitor--ionic)
- [OutSystems (O11 / ODC)](#outsystems-o11--odc)
- [Opening the inspector](#opening-the-inspector)
- [Running queries without the UI](#running-queries-without-the-ui)
- [Shipping team presets](#shipping-team-presets)
- [Keeping it out of production](#keeping-it-out-of-production)
- [Where your data has to live](#where-your-data-has-to-live)
- [Troubleshooting](#troubleshooting)

---

## Requirements

| | Minimum | Verified with |
|---|---|---|
| cordova-android | 10.0.0 | 15.1.0 (Cordova CLI 12), Capacitor 8.5 |
| cordova-ios | 6.0.0 | 8.1.1 (Cordova CLI 12), Capacitor 8.5 (Swift Package Manager) |
| Android | API 24 (7.0) | Android 16, targetSdk 36 |
| iOS | 13 (for `VACUUM INTO` export) | iOS 26.6 |

The plugin has **no native dependencies**. Android uses the platform `android.database.sqlite` from Java, so it needs no Kotlin or AndroidX preferences. iOS uses the system `libsqlite3` and `WebKit`, with no CocoaPods. It requests **no permissions**: files are saved and imported through the Storage Access Framework on Android and the share sheet / document picker on iOS.

The plugin is inert until you call `open()` or `runQueries()`. It adds no background work, no startup cost and no network access.

---

## Cordova CLI

```bash
cordova plugin add cordova-plugin-db-inspector
# or straight from git / a local checkout
cordova plugin add https://github.com/henriquefps/cordova-plugin-db-inspector.git#v1.1.0
cordova plugin add ../cordova-plugin-db-inspector
```

This is what gets installed:

| Platform | Files |
|---|---|
| Android | `DbInspectorPlugin`, `DbInspectorActivity` and `DbInspectorEngine` in `com.hfps.dbinspector`; `assets/db-inspector.html`; a non-exported `<activity>` entry in the manifest |
| iOS | `DbInspectorPlugin`, `DbInspectorViewController` and `DbInspectorEngine` (Obj-C); `db-inspector.html` as a bundle resource; links `libsqlite3.tbd` and `WebKit.framework` |

The JS API is available after `deviceready`:

```javascript
document.addEventListener('deviceready', () => {
  document.getElementById('debugButton').addEventListener('click', () => {
    cordova.plugins.DbInspector.open();
  });
});
```

---

## Capacitor / Ionic

Capacitor runs Cordova plugins through its compatibility layer:

```bash
npm install cordova-plugin-db-inspector
npx cap sync
```

- **Android:** the sources and the HTML asset are copied into the `capacitor-cordova-android-plugins` module.
- **iOS:** with the default Swift Package Manager setup (Capacitor 8), the plugin becomes the `CordovaPluginDbInspector` package, and the HTML ships in its resource bundle. The view controller finds the file either there or in the main bundle (CocoaPods / Cordova), so it works with both setups.

```typescript
declare const cordova: any;

export async function openDbInspector() {
  await cordova.plugins.DbInspector.open({ title: 'My App DB' });
}
```

`cordova` is a global in Capacitor apps once the plugin is installed. You don't need an import.

---

## OutSystems (O11 / ODC)

### 1. Wrap the plugin in a library / module

Create a mobile library (ODC) or a module (O11), for example `DbInspectorPlugin`. Set its **Extensibility Configuration** to:

```json
{
  "plugin": {
    "url": "https://github.com/henriquefps/cordova-plugin-db-inspector.git#v1.1.0"
  }
}
```

Pin a tag (`#v1.1.0`) so every build uses the same plugin version. The plugin runs on any build service (MABS) version that ships cordova-android ≥ 10 and cordova-ios ≥ 6.

### 2. Client actions

**`CheckDbInspectorPlugin`** (output `IsAvailable`, Boolean). Returns false in the browser, in the OutSystems preview app, or when the native build doesn't include the plugin:

```javascript
$parameters.IsAvailable = !!(window.cordova && cordova.plugins && cordova.plugins.DbInspector);
```

**`OpenDbInspector`** (optional inputs `DatabaseName`, `Title` and `PresetsJson`, all Text; outputs `Success` Boolean and `ErrorMessage` Text):

```javascript
var options = {};
if ($parameters.DatabaseName) options.database = $parameters.DatabaseName;
if ($parameters.Title) options.title = $parameters.Title;
if ($parameters.PresetsJson) options.presets = $parameters.PresetsJson;

cordova.plugins.DbInspector.open(options).then(function () {
  $parameters.Success = true;
  $resolve();
}, function (err) {
  $parameters.Success = false;
  $parameters.ErrorMessage = String(err);
  $resolve();
});
```

Call `CheckDbInspectorPlugin` first and show a message when the plugin isn't available.

**`RunDbQueries`** runs queries with no UI. Its input `RequestJson` (Text) holds the whole `runQueries()` options document. Its outputs are `ResultJson` (Text), `Success` (Boolean) and `ErrorMessage` (Text). Add a JavaScript node with the input and outputs mapped:

```javascript
// $parameters.RequestJson, for example:
// {"database":"bg_sync.db","maxRows":500,
//  "queries":[{"name":"pending","sql":"SELECT Id, Status FROM sync_queue WHERE Status = :s","params":{"s":1}}]}
cordova.plugins.DbInspector.runQueries($parameters.RequestJson).then(function (result) {
  $parameters.ResultJson = JSON.stringify(result);
  $parameters.Success = true;
  $resolve();
}, function (err) {
  $parameters.Success = false;
  $parameters.ErrorMessage = String(err);
  $resolve();
});
```

Then turn the text into data with **JSONDeserialize**, for example to a `RunQueriesResult` structure:

| Structure | Attributes |
|---|---|
| `RunQueriesResult` | `database` (`DbRef`), `startedAt` (Text), `durationMs` (Decimal), `results` (List of `QueryResult`) |
| `DbRef` | `id` (Text), `name` (Text) |
| `QueryResult` | `name` (Text), `sql` (Text), `columns` (List of Text), `rowCount` (Integer), `truncated` (Boolean), `durationMs` (Decimal), `error` (Text) |

The `rows` differ for each query, so they don't fit a fixed structure. Either deserialize one query's rows with a structure that matches its columns (`JSONDeserialize` of a `ResultJson` you build per query in JavaScript, for example `JSON.stringify(result.results[0].rows)` into a List of `PendingRow`), or keep `ResultJson` as Text and send it to your server as is. `JSONDeserialize` maps attribute names by their JSON names. Set each attribute's *Name in JSON* when the names differ.

> Gate `RunDbQueries` like `OpenDbInspector`. See [Keeping it out of production](#keeping-it-out-of-production).

### 3. What you'll see

- The OutSystems local storage database is the file in `databases/` on Android and `Library/LocalDatabase/` on iOS. Its file name is a pair of GUIDs, for example `3f2a…_9c41…`. When no `database` option is passed, the inspector selects the largest readable database, which is usually this one.
- Local entities are listed by their **logical names** (`LocalCustomer`) next to the physical tables (`OSUSR_A1B_LOCALCUSTOMER`), taken from `OSSYS_ENTITY`.
- Binary Data attributes are stored as base64 text. The inspector recognises PNG, JPEG, GIF, WebP, BMP, PDF and ZIP content and previews images directly.
- Local entities declare no foreign keys, so references are **inferred** from `<Entity>Id` attributes and marked as *inferred* in the UI. Treat them as hints: an attribute such as `CustomerId` may point to a server entity rather than a local one.
- If the app enables local storage encryption (SQLCipher), the database is listed as *encrypted* and cannot be opened. This is intentional: the plugin never tries to obtain another plugin's key.

---

## Opening the inspector

```javascript
cordova.plugins.DbInspector.open(options?, success?, error?) // → Promise<void>
cordova.plugins.DbInspector.listDatabases(success?, error?)  // → Promise<DatabaseFile[]>
```

| Option | Type | Description |
|---|---|---|
| `database` | string | File name (`"bg_sync.db"`) or id (`"databases/bg_sync.db"`) to select first. Defaults to the last one used, then the largest readable file. |
| `title` | string | Header title. Default: `DB Inspector`. |
| `presets` | object \| array \| JSON string | Presets merged into the saved ones on open (see [presets.md](presets.md)). |

`open()` resolves as soon as the screen is shown. There is no "closed" event; the screen dismisses itself (Close button, or hardware back on Android).

`listDatabases()` resolves with entries like:

```json
{
  "id": "databases/bg_sync.db",
  "name": "bg_sync.db",
  "dir": "databases",
  "size": 45056,
  "walSize": 0,
  "journalSize": 0,
  "modified": 1790261101000,
  "encrypted": false,
  "empty": false
}
```

---

## Running queries without the UI

```javascript
cordova.plugins.DbInspector.runQueries(options, success?, error?) // → Promise<RunQueriesResult>
```

Runs a batch of queries against one database, with no screen, on a background thread (Android thread pool / iOS background queue), and resolves with plain JSON. Use it for automated extraction, health checks or syncing local data to a server.

| Option | Type | Description |
|---|---|---|
| `database` | string | **Required.** File name (`"bg_sync.db"`) or id (`"databases/bg_sync.db"`), resolved like `open({ database })`: an exact id match first, then the file name. |
| `queries` | array \| object \| JSON string | `[{ name?, sql, params?, maxRows? }]` (a bare SQL string also works), or a presets document (`{ "format": "hfps-db-inspector-presets", "presets": [ … ] }`, see [presets.md](presets.md)). |
| `params` | object | Named parameter values shared by every query. A query's own `params` take precedence. |
| `maxRows` | number | Row cap per query. Default 1000, maximum 10000. A query's own `maxRows` overrides it (same maximum). |

`options` itself may be a JSON string, which is the easiest form to pass from an OutSystems Text variable.

**Parameters.** Named parameters use the inspector's syntax: `:name`, `@name` or `$name`, outside string literals and comments. Their values come from an object (`{ "s": 1 }`, and `{ ":s": 1 }` also works). Positional `?` parameters take an array (`"params": [1, "x"]`). The values are **bound**, never inlined into the SQL, with their own type: numbers as integer or real, strings as text, `true`/`false` as `1`/`0`, and `null` as NULL. Objects are bound as JSON text. A named parameter with no value fails that query (`Missing value for parameter :s.`).

**Statements.** Each query is one statement. The batch accepts `SELECT`, `WITH`, `VALUES`, `PRAGMA` and `EXPLAIN` only, on the same read-only connection as the inspector. Anything else (`DELETE`, `ATTACH`, `VACUUM INTO`, …) is refused before it runs.

**Result:**

```json
{
  "database": { "id": "databases/bg_sync.db", "name": "bg_sync.db" },
  "startedAt": "2026-11-16T18:28:19.734Z",
  "durationMs": 5.7,
  "results": [
    {
      "name": "pending",
      "sql": "SELECT Id, Name, Photo FROM Item WHERE Status = :s",
      "columns": ["Id", "Name", "Photo"],
      "rows": [ { "Id": 2, "Name": "item 2", "Photo": "iVBORw0KGgoAAAANSUhEUg==" } ],
      "rowCount": 1,
      "truncated": false,
      "durationMs": 0.19,
      "error": null
    },
    {
      "name": "broken",
      "sql": "SELECT * FROM NoSuchTable",
      "columns": [], "rows": [], "rowCount": 0, "truncated": false, "durationMs": 0.14,
      "error": "no such table: NoSuchTable …"
    }
  ]
}
```

- `rows` are objects keyed by column name. If a name repeats (`SELECT a.Id, b.Id …`), later columns get a suffix (`Id_2`), and `columns` lists those keys.
- Values: integers, reals, text and NULL keep their JSON types. BLOBs become **base64** strings. Integers beyond ±2^53 become strings, so JavaScript doesn't round them. Text and BLOBs are returned in full, with no preview cut. Keep `maxRows` modest for tables with large binary attributes.
- `truncated` is `true` when the query had more rows than `maxRows`.
- `error` is `null`, or the message for this query. The other queries still run.
- The promise **rejects** (with a message string) only when the whole batch can't run: the database doesn't exist, the database is encrypted, or the input is invalid (not JSON, no `database`, no `queries`).

> **Security.** `runQueries()` lets any JavaScript running in the app read every local database without the inspector screen. Gate it exactly like `open()`, and don't expose it to remote content or third-party scripts.

---

## Shipping team presets

Pass the presets your team maintains through `open()`. They are merged by `id`, so updating the app updates them, and presets saved on the device are kept:

```javascript
cordova.plugins.DbInspector.open({
  presets: {
    format: 'hfps-db-inspector-presets',
    version: 1,
    presets: [{
      id: 'team_pending_sync',
      name: 'Pending sync records',
      sql: "SELECT * FROM sync_queue WHERE Status IN ('pending', 'failed') ORDER BY Sequence DESC",
      database: 'bg_sync.db',
      tags: ['sync']
    }]
  }
});
```

A convenient workflow is to build the queries in the inspector, use **Presets → Export all**, commit the JSON to your app's repository, and pass it to `open()`. In OutSystems, store the JSON as a resource or a Site Property / Setting and send it in the `PresetsJson` input.

---

## Keeping it out of production

The inspector shows **everything** in the app's local storage to whoever holds the device. Every connection is read-only, but reading alone can expose personal data, tokens or cached records. Pick one of these:

1. **Debug and support builds only.** Add the plugin only to development builds (Cordova: a separate `config.xml` / build flavour; OutSystems: a separate debug app or a library consumed only by a DEV-only module).
2. **Gate the entry point.** Keep the plugin in every build but only call `open()` for users with a support role, behind a hidden gesture, or after the server confirms a support session.
3. **Never** add an unconditional, visible "Open DB Inspector" button to a production app.

The Android activity is `exported="false"`: other apps can't launch it, and only your own code calling `open()` can.

The same applies to `runQueries()`. It reads the databases **without any screen**, so any JavaScript in the app (including scripts the app loads from elsewhere) can call it. Call it only from code paths gated like `open()`, and leave the plugin out of builds that don't need it.

---

## Where your data has to live

The inspector reads only files inside the app sandbox:

| Platform | Scanned |
|---|---|
| Android | Every file in `databases/`. Files with a SQLite header in `files/` and `no_backup/` (4 levels deep; `app_webview`, `cache`, `code_cache` are skipped). |
| iOS | `Library/LocalDatabase`, `Documents/databases`, `Library/databases` (every file). Files with a SQLite header anywhere else in `Documents/` and `Library/` (5 levels deep; `Caches`, `WebKit`, `Preferences`, `Cookies`, `Saved Application State`, `SplashBoard`, `Snapshots` are skipped). |

This covers `cordova-sqlite-storage`, `cordova-sqlcipher-adapter` (listed as encrypted), the OutSystems local storage, `@capacitor-community/sqlite` (it keeps its files in `databases/` on Android and `Library/CapacitorDatabase` on iOS, both covered by the scan), and plain `android.database.sqlite` / `sqlite3` usage. IndexedDB and WebSQL databases owned by the WebView are not listed.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `cordova.plugins.DbInspector` is `undefined` | Called before `deviceready`, running in a browser / OutSystems preview app, or the native build didn't include the plugin (check the build log for `cordova-plugin-db-inspector`). |
| iOS shows *"db-inspector.html is missing from the app bundle"* | The resource wasn't copied. Run `npx cap sync ios` / `cordova prepare ios` again. With a custom SPM setup, make sure the package's resource bundle is embedded in the app. |
| A database is marked **Encrypted · not supported** | It has no plaintext SQLite header (SQLCipher or another encryption scheme). Encrypted databases are intentionally not opened. |
| Database list is empty | The app hasn't created its database yet (open the screen that initialises local storage first), or it keeps the file outside the scanned folders. |
| *"attempt to write a readonly database"* | Expected: every connection is read-only, including the SQL console. |
| A big image shows only its raw text | The value is larger than what the preview fetches (8 M chars / 8 MB; 500 K chars / 1 MB on Android < 9). Use **Save decoded file**. |
| A heavy `SELECT *` on binary columns is slow | Each large value has to be read before it's truncated for display. Select `length(col)` instead of the column, or browse the table (the grid reads only a preview per cell). |
