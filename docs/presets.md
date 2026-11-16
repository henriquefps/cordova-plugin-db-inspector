# Query presets

Presets are saved queries: a name, a description, SQL (optionally with `:parameters`), tags, an optional database scope, and optionally the visual builder state they were made with. They can be created in the inspector, exported and imported as JSON, and shipped with the app through `open({ presets })`.

The same document can be run without the UI: pass it as `queries` to `runQueries()` (see [Running queries without the UI](integration.md#running-queries-without-the-ui)). There, parameters are bound as real SQLite values instead of inlined, and come from `params`; `database`, `builder` and the other preset fields are ignored.

## File format

```json
{
  "format": "hfps-db-inspector-presets",
  "version": 1,
  "exportedAt": "2026-09-24T15:32:23.721Z",
  "source": { "app": "com.example.app", "platform": "android" },
  "presets": [
    {
      "id": "team_entity_lookup",
      "name": "OutSystems · entity lookup by name",
      "description": "Physical table behind an OutSystems entity.",
      "sql": "SELECT Name, Physical_Table_name\nFROM OSSYS_ENTITY\nWHERE Name LIKE '%' || :entity || '%'",
      "tags": ["outsystems"],
      "database": null,
      "builder": null,
      "createdAt": 1790263548454,
      "updatedAt": 1790263548454
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `format`, `version` | written on export | Ignored on import. |
| `exportedAt`, `source` | written on export | Informational. |
| `presets[].sql` | **yes** | Entries without SQL are counted as *invalid* and skipped. |
| `presets[].name` | recommended | Defaults to `Untitled query`. Max 200 chars. |
| `presets[].id` | recommended | Stable id used for merging. Generated when missing. |
| `presets[].description` | no | Max 2000 chars. |
| `presets[].tags` | no | Up to 10 strings, shown as `#tag` and matched by search. |
| `presets[].database` | no | A database **file name** (`"bg_sync.db"`). The preset then appears under *This DB* and is flagged in red when a different database is open. `null` = any database. |
| `presets[].builder` | no | Visual builder state (see below). `null` = SQL only. |
| `presets[].createdAt`, `updatedAt` | no | Epoch milliseconds. `updatedAt` decides which side wins a merge. |

Import also accepts a **bare array** of presets, or **a single preset object**.

## Merge rules

For each incoming preset:

1. It matches an existing preset with the same `id`, or failing that the same `name` **and** `sql`.
2. With no match, it is **added**.
3. With a match, it **replaces** the existing one when its `updatedAt` is newer or its SQL differs. The existing `id` is kept.
4. Otherwise it is left **unchanged**.

The inspector reports the outcome, for example `1 added · 0 updated · 7 unchanged · 0 invalid`. Nothing is ever deleted by an import.

## Parameters

Any `:name`, `@name` or `$name` token outside string literals and comments is a parameter. When a query runs, the inspector asks for each value and remembers the last values per parameter name.

Values are inlined as SQL literals:

| You type | Becomes |
|---|---|
| `42`, `-3.5` | `42`, `-3.5` |
| `hello` | `'hello'` (single quotes escaped) |
| `'already quoted'` | kept as is |
| `null` | `NULL` |
| `true` / `false` | `1` / `0` |

Inlining is safe here because every connection is read-only.

In the visual builder, a filter value such as `:company` becomes a parameter too. With *contains / starts with / ends with* it is wrapped as `'%' || :company || '%'`.

## Builder state

When a preset carries `builder`, **Open** restores it in the visual builder, provided the tables it references exist in the current database. Otherwise it opens in the SQL editor. The object is produced by the inspector; editing it by hand is possible but not needed:

```json
{
  "from": { "table": "OSUSR_A1B_LOCALORDER", "alias": "lo" },
  "joins": [
    { "type": "LEFT", "table": "OSUSR_A1B_LOCALCUSTOMER", "alias": "lc",
      "on": [{ "l": "lo.CustomerId", "r": "lc.Id" }] }
  ],
  "columns": [
    { "agg": "", "expr": "lc.Id", "alias": "" },
    { "agg": "COUNT", "expr": "*", "alias": "total" }
  ],
  "distinct": false,
  "where": { "kind": "group", "op": "AND", "items": [
    { "kind": "cond", "col": "lo.IsActive", "opr": "=", "v": ":active" }
  ] },
  "groupBy": ["lc.Id"],
  "orderBy": [{ "col": "total", "dir": "DESC" }],
  "limit": 100
}
```

Condition operators (`opr`): `=`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `starts`, `ends`, `LIKE`, `NOT LIKE`, `IN`, `NOT IN` (comma-separated `v`), `BETWEEN` (`v` and `v2`), `IS NULL`, `IS NOT NULL`, `EMPTY` (null or `''`), `NOT EMPTY`. Groups (`kind: "group"`) nest up to two levels, and each has its own `AND` / `OR`.

## Where presets are stored

On the device, presets, the query history (last 60) and UI preferences are kept by the host app:

- Android: `SharedPreferences` file `hfps_db_inspector`
- iOS: `NSUserDefaults`, keys prefixed with `hfps_db_inspector.`

They survive app updates and are removed when the app is uninstalled.

## Built-in examples

**Presets → Add examples** adds generic starting points: schema listings (tables, all columns, find a column by name, indexes), page and free-space usage, and, for OutSystems databases only, the entity map, the client logs (`OSSYS_LOG`) and the runtime key/value store (`OSSYS_PERSISTENTKEYVALUE`). They're regular presets you can edit or delete.
