package com.hfps.dbinspector;

import android.content.Context;
import android.database.Cursor;
import android.database.CursorWindow;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteCursorDriver;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteQuery;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Read-only SQLite introspection for every database file inside the host app's sandbox.
 *
 * Every connection is opened with OPEN_READONLY, so nothing the inspector does (including
 * arbitrary SQL typed in the query console) can modify the app's data. Android's read-only
 * connections also skip the journal-mode/locale setup a writable open would perform, which
 * matters here: a writable open would silently switch a WAL database (e.g. OutSystems local
 * storage) back to the platform default journal mode.
 *
 * Encrypted (SQLCipher) databases are detected by their missing plaintext header and listed
 * as such, but are intentionally not opened.
 */
final class DbInspectorEngine {

    /** Text longer than this is truncated in grid views; the full value is fetched on demand. */
    static final int GRID_TEXT_PREVIEW = 500;
    /** Query-console results have no stable row identity, so they keep a larger preview. */
    static final int QUERY_TEXT_PREVIEW = 5000;
    static final int CELL_TEXT_MAX = 8_000_000;
    static final int CELL_BLOB_MAX = 8 * 1024 * 1024;
    static final int DEFAULT_QUERY_MAX_ROWS = 1000;
    /**
     * Android's default CursorWindow is 2 MB, and a single row larger than the window throws
     * "Row too big to fit into CursorWindow" — common with OutSystems binary attributes. On
     * API 28+ we can hand SQLiteCursor a bigger window.
     */
    private static final long LARGE_WINDOW_BYTES = 32L * 1024 * 1024;

    private static final byte[] SQLITE_HEADER = "SQLite format 3\u0000".getBytes();
    private static final String[] SIDE_FILE_SUFFIXES = {"-journal", "-wal", "-shm"};
    private static final String[] DB_EXTENSIONS = {".db", ".sqlite", ".sqlite3", ".db3"};
    private static final String[] SKIPPED_DIRS = {"app_webview", "cache", "code_cache", "app_textures", "lib", "oat"};
    private static final int MAX_SCAN_DEPTH = 4;

    private final Context context;
    private final Map<String, File> knownFiles = new LinkedHashMap<>();
    private final Map<String, SQLiteDatabase> connections = new HashMap<>();
    private volatile CancellationSignal activeSignal;

    DbInspectorEngine(Context context) {
        this.context = context.getApplicationContext();
    }

    // ---------------------------------------------------------------------------------------
    // Discovery
    // ---------------------------------------------------------------------------------------

    JSONArray listDatabases() throws JSONException {
        knownFiles.clear();
        File dataDir = new File(context.getApplicationInfo().dataDir);
        File databasesDir = context.getDatabasePath("probe").getParentFile();

        List<File> found = new ArrayList<>();
        if (databasesDir != null && databasesDir.isDirectory()) {
            File[] children = databasesDir.listFiles();
            if (children != null) {
                Arrays.sort(children);
                for (File f : children) {
                    // Everything in databases/ is a database by convention, even without the
                    // plaintext header (that's exactly what an encrypted one looks like).
                    if (f.isFile() && !isSideFile(f.getName())) found.add(f);
                }
            }
        }
        scanForSqlite(context.getFilesDir(), 0, found);
        scanForSqlite(context.getNoBackupFilesDir(), 0, found);

        JSONArray result = new JSONArray();
        for (File f : found) {
            String id = relativePath(dataDir, f);
            knownFiles.put(id, f);
            int slash = id.lastIndexOf('/');
            result.put(new JSONObject()
                    .put("id", id)
                    .put("name", f.getName())
                    .put("dir", slash > 0 ? id.substring(0, slash) : "")
                    .put("size", f.length())
                    .put("walSize", sideFileSize(f, "-wal"))
                    .put("journalSize", sideFileSize(f, "-journal"))
                    .put("modified", f.lastModified())
                    .put("encrypted", f.length() > 0 && !hasSqliteHeader(f))
                    .put("empty", f.length() == 0));
        }
        return result;
    }

    private void scanForSqlite(File dir, int depth, List<File> out) {
        if (dir == null || !dir.isDirectory() || depth > MAX_SCAN_DEPTH) return;
        File[] children = dir.listFiles();
        if (children == null) return;
        Arrays.sort(children);
        for (File f : children) {
            if (f.isDirectory()) {
                if (!Arrays.asList(SKIPPED_DIRS).contains(f.getName())) scanForSqlite(f, depth + 1, out);
            } else if (!isSideFile(f.getName()) && f.length() >= 512) {
                if (hasSqliteHeader(f) || (hasDbExtension(f.getName()) && !out.contains(f))) out.add(f);
            }
        }
    }

    private static boolean isSideFile(String name) {
        for (String s : SIDE_FILE_SUFFIXES) if (name.endsWith(s)) return true;
        return name.contains("-mj");
    }

    private static boolean hasDbExtension(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        for (String e : DB_EXTENSIONS) if (lower.endsWith(e)) return true;
        return false;
    }

    private static boolean hasSqliteHeader(File f) {
        byte[] buf = new byte[16];
        try (InputStream in = new FileInputStream(f)) {
            return in.read(buf) == 16 && Arrays.equals(buf, SQLITE_HEADER);
        } catch (IOException e) {
            return false;
        }
    }

    private static long sideFileSize(File db, String suffix) {
        File side = new File(db.getPath() + suffix);
        return side.exists() ? side.length() : 0;
    }

    private static String relativePath(File root, File f) {
        String rootPath = root.getAbsolutePath();
        String path = f.getAbsolutePath();
        return path.startsWith(rootPath + "/") ? path.substring(rootPath.length() + 1) : path;
    }

    File resolve(String dbId) throws JSONException {
        File f = knownFiles.get(dbId);
        if (f == null) {
            listDatabases();
            f = knownFiles.get(dbId);
        }
        if (f == null) throw new IllegalArgumentException("Unknown database: " + dbId);
        return f;
    }

    private SQLiteDatabase db(String dbId) throws JSONException {
        SQLiteDatabase db = connections.get(dbId);
        if (db != null && db.isOpen()) return db;
        File f = resolve(dbId);
        if (f.length() > 0 && !hasSqliteHeader(f)) {
            throw new IllegalStateException("This database is encrypted (no plaintext SQLite header). Encrypted databases are not supported.");
        }
        db = SQLiteDatabase.openDatabase(f.getAbsolutePath(), null,
                SQLiteDatabase.OPEN_READONLY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
        connections.put(dbId, db);
        return db;
    }

    void closeAll() {
        for (SQLiteDatabase db : connections.values()) {
            try { db.close(); } catch (Exception ignored) { }
        }
        connections.clear();
    }

    // ---------------------------------------------------------------------------------------
    // Schema
    // ---------------------------------------------------------------------------------------

    JSONObject overview(String dbId) throws JSONException {
        SQLiteDatabase db = db(dbId);
        Map<String, JSONObject> entities = outSystemsEntities(db);

        JSONArray tables = new JSONArray();
        Map<String, Integer> indexCounts = new HashMap<>();
        int indexCount = 0, triggerCount = 0;
        List<JSONObject> objects = rows(db, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name COLLATE NOCASE", null);
        for (JSONObject o : objects) {
            String type = o.optString("type");
            if (type.equals("index")) {
                indexCount++;
                String t = o.optString("tbl_name");
                Integer n = indexCounts.get(t);
                indexCounts.put(t, n == null ? 1 : n + 1);
            } else if (type.equals("trigger")) {
                triggerCount++;
            }
        }
        for (JSONObject o : objects) {
            String type = o.optString("type");
            if (!type.equals("table") && !type.equals("view")) continue;
            String name = o.optString("name");
            String sql = o.optString("sql", "");
            String upperSql = sql.toUpperCase(Locale.ROOT);
            boolean virtual = upperSql.startsWith("CREATE VIRTUAL TABLE");
            JSONObject t = new JSONObject()
                    .put("name", name)
                    .put("type", type)
                    .put("virtual", virtual)
                    .put("withoutRowid", upperSql.contains("WITHOUT ROWID"))
                    .put("system", isSystemTable(name))
                    .put("indexes", indexCounts.containsKey(name) ? indexCounts.get(name) : 0);
            JSONObject entity = entities.get(name.toUpperCase(Locale.ROOT));
            if (entity != null) t.put("logicalName", entity.optString("name"));
            if (type.equals("table") && !virtual) {
                try {
                    t.put("rows", scalarLong(db, "SELECT count(*) FROM " + q(name)));
                } catch (Exception e) {
                    t.put("rows", JSONObject.NULL);
                }
            }
            tables.put(t);
        }
        return new JSONObject()
                .put("tables", tables)
                .put("indexCount", indexCount)
                .put("triggerCount", triggerCount)
                .put("outsystems", !entities.isEmpty());
    }

    private static boolean isSystemTable(String name) {
        String upper = name.toUpperCase(Locale.ROOT);
        return upper.startsWith("SQLITE_") || upper.equals("ANDROID_METADATA")
                || upper.startsWith("OSSYS_") || upper.startsWith("BACKUP_OSSYS_");
    }

    /** OutSystems keeps a map of logical entity names -> physical tables in OSSYS_ENTITY. */
    private Map<String, JSONObject> outSystemsEntities(SQLiteDatabase db) {
        Map<String, JSONObject> map = new HashMap<>();
        try {
            if (scalarLong(db, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='OSSYS_ENTITY'") == 0) return map;
            for (JSONObject r : rows(db, "SELECT Name AS name, Physical_Table_name AS physical, Extra_Info AS extra FROM OSSYS_ENTITY", null)) {
                String physical = r.optString("physical", "");
                if (!physical.isEmpty()) map.put(physical.toUpperCase(Locale.ROOT), r);
            }
        } catch (Exception ignored) {
            // Not an OutSystems database, or an unexpected OSSYS_ENTITY shape.
        }
        return map;
    }

    JSONObject tableSchema(String dbId, String table) throws JSONException {
        SQLiteDatabase db = db(dbId);
        JSONObject master = firstRow(db, "SELECT type, sql FROM sqlite_master WHERE name = ?", new String[]{table});
        if (master == null) throw new IllegalArgumentException("Unknown table: " + table);

        List<JSONObject> columns;
        try {
            columns = rows(db, "PRAGMA table_xinfo(" + q(table) + ")", null);
        } catch (Exception e) {
            columns = rows(db, "PRAGMA table_info(" + q(table) + ")", null); // SQLite < 3.26
        }

        JSONArray indexes = new JSONArray();
        for (JSONObject idx : rows(db, "PRAGMA index_list(" + q(table) + ")", null)) {
            JSONArray cols = new JSONArray();
            for (JSONObject c : rows(db, "PRAGMA index_info(" + q(idx.optString("name")) + ")", null)) {
                cols.put(c.isNull("name") ? "<expr>" : c.optString("name"));
            }
            JSONObject idxSql = firstRow(db, "SELECT sql FROM sqlite_master WHERE type='index' AND name = ?", new String[]{idx.optString("name")});
            idx.put("columns", cols);
            idx.put("sql", idxSql == null ? JSONObject.NULL : idxSql.opt("sql"));
            indexes.put(idx);
        }

        String sql = master.optString("sql", "");
        String type = master.optString("type");
        JSONObject result = new JSONObject()
                .put("name", table)
                .put("type", type)
                .put("sql", sql)
                .put("rowid", type.equals("table") && !sql.toUpperCase(Locale.ROOT).contains("WITHOUT ROWID"))
                .put("columns", new JSONArray(columns))
                .put("indexes", indexes)
                .put("foreignKeys", new JSONArray(rows(db, "PRAGMA foreign_key_list(" + q(table) + ")", null)))
                .put("triggers", new JSONArray(rows(db, "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?", new String[]{table})));

        JSONObject entity = outSystemsEntities(db).get(table.toUpperCase(Locale.ROOT));
        if (entity != null) {
            result.put("logicalName", entity.optString("name"));
            try {
                result.put("outsystemsAttrs", new JSONObject(entity.optString("extra", "{}")).optJSONObject("attrs"));
            } catch (JSONException ignored) { }
        }
        return result;
    }

    // ---------------------------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------------------------

    JSONObject tableRows(String dbId, JSONObject args) throws JSONException {
        SQLiteDatabase db = db(dbId);
        String table = args.getString("table");
        int offset = Math.max(0, args.optInt("offset", 0));
        int limit = Math.min(500, Math.max(1, args.optInt("limit", 50)));
        String sortColumn = args.optString("sortColumn", "");
        boolean desc = "desc".equalsIgnoreCase(args.optString("sortDir", "asc"));
        String search = args.optString("search", "").trim();

        JSONObject schema = firstRow(db, "SELECT type, sql FROM sqlite_master WHERE name = ?", new String[]{table});
        if (schema == null) throw new IllegalArgumentException("Unknown table: " + table);
        boolean hasRowid = schema.optString("type").equals("table")
                && !schema.optString("sql", "").toUpperCase(Locale.ROOT).contains("WITHOUT ROWID");

        List<String> names = new ArrayList<>();
        List<String> searchable = new ArrayList<>();
        for (JSONObject c : rows(db, "PRAGMA table_info(" + q(table) + ")", null)) {
            String n = c.optString("name");
            names.add(n);
            if (!c.optString("type", "").toUpperCase(Locale.ROOT).contains("BLOB")) searchable.add(n);
        }

        // Two projected columns per real column: a display value that never carries a full
        // blob or a huge string across the JNI boundary, plus its real length.
        StringBuilder select = new StringBuilder("SELECT ");
        select.append(hasRowid ? "rowid" : "NULL");
        for (String n : names) {
            String c = q(n);
            select.append(", CASE WHEN typeof(").append(c).append(")='text' AND length(").append(c).append(")>").append(GRID_TEXT_PREVIEW)
                    .append(" THEN substr(").append(c).append(",1,").append(GRID_TEXT_PREVIEW).append(")")
                    .append(" WHEN typeof(").append(c).append(")='blob' THEN substr(").append(c).append(",1,16) ELSE ").append(c).append(" END")
                    .append(", length(").append(c).append(")");
        }
        String from = " FROM " + q(table);
        String where = "";
        List<String> whereArgs = new ArrayList<>();
        if (!search.isEmpty() && !searchable.isEmpty()) {
            StringBuilder w = new StringBuilder(" WHERE (");
            for (int i = 0; i < searchable.size(); i++) {
                if (i > 0) w.append(" OR ");
                w.append(q(searchable.get(i))).append(" LIKE ?1");
            }
            where = w.append(")").toString();
            whereArgs.add("%" + search + "%");
        }
        String order = "";
        if (!sortColumn.isEmpty() && names.contains(sortColumn)) {
            order = " ORDER BY " + q(sortColumn) + (desc ? " DESC" : " ASC");
        }
        String[] argv = whereArgs.toArray(new String[0]);

        long total = scalarLong(db, "SELECT count(*)" + from + where, argv);
        JSONArray rows = new JSONArray();
        JSONArray rowids = new JSONArray();
        try (Cursor cur = db.rawQuery(select + from + where + order + " LIMIT " + limit + " OFFSET " + offset, argv)) {
            while (cur.moveToNext()) {
                rowids.put(hasRowid ? cur.getLong(0) : JSONObject.NULL);
                JSONArray row = new JSONArray();
                for (int i = 0; i < names.size(); i++) {
                    row.put(encodeCell(cur, 1 + i * 2, 2 + i * 2, GRID_TEXT_PREVIEW));
                }
                rows.put(row);
            }
        }
        return new JSONObject()
                .put("columns", new JSONArray(names))
                .put("rowids", hasRowid ? rowids : JSONObject.NULL)
                .put("rows", rows)
                .put("total", total)
                .put("offset", offset)
                .put("limit", limit);
    }

    JSONObject cell(String dbId, JSONObject args) throws JSONException {
        SQLiteDatabase db = db(dbId);
        String table = args.getString("table");
        String column = args.getString("column");
        long rowid = args.getLong("rowid");
        String c = q(column);
        String sql = "SELECT typeof(" + c + "), length(" + c + "), CASE WHEN typeof(" + c + ")='text' THEN substr(" + c + ",1," + textFetchLimit()
                + ") WHEN typeof(" + c + ")='blob' THEN substr(" + c + ",1," + blobFetchLimit() + ") ELSE " + c + " END FROM " + q(table) + " WHERE rowid = ?";
        try (Cursor cur = rawQueryLarge(db, sql, new String[]{String.valueOf(rowid)}, null)) {
            if (!cur.moveToFirst()) throw new IllegalArgumentException("Row not found");
            String type = cur.getString(0);
            long len = cur.isNull(1) ? 0 : cur.getLong(1);
            JSONObject out = new JSONObject().put("type", type).put("len", len);
            switch (cur.getType(2)) {
                case Cursor.FIELD_TYPE_BLOB: {
                    byte[] bytes = cur.getBlob(2);
                    out.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    out.put("mime", sniffMime(bytes));
                    out.put("truncated", bytes.length < len);
                    break;
                }
                case Cursor.FIELD_TYPE_STRING: {
                    String s = cur.getString(2);
                    out.put("text", s);
                    out.put("truncated", s.length() < len);
                    break;
                }
                case Cursor.FIELD_TYPE_NULL:
                    out.put("value", JSONObject.NULL);
                    break;
                default:
                    out.put("value", numberValue(cur, 2));
            }
            return out;
        }
    }

    private static int textFetchLimit() {
        // UTF-8 text can take up to 3 bytes per char inside the CursorWindow.
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? CELL_TEXT_MAX : 500_000;
    }

    private static int blobFetchLimit() {
        // Without a larger CursorWindow (API < 28) a single cell must stay well under 2 MB.
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? CELL_BLOB_MAX : 1024 * 1024;
    }

    JSONObject columnStats(String dbId, JSONObject args) throws JSONException {
        SQLiteDatabase db = db(dbId);
        String t = q(args.getString("table"));
        String c = q(args.getString("column"));

        JSONArray types = new JSONArray();
        long blobs = 0;
        for (JSONObject r : rows(db, "SELECT typeof(" + c + ") AS type, count(*) AS count FROM " + t + " GROUP BY 1 ORDER BY 2 DESC", null)) {
            types.put(r);
            if ("blob".equals(r.optString("type"))) blobs = r.optLong("count");
        }
        String nonBlob = "CASE WHEN typeof(" + c + ")='text' THEN substr(" + c + ",1,200) WHEN typeof(" + c + ")<>'blob' THEN " + c + " END";
        JSONObject stats = firstRow(db, "SELECT count(*) AS total, count(" + c + ") AS nonNull, min(" + nonBlob + ") AS min, max(" + nonBlob + ") AS max, "
                + "avg(CASE WHEN typeof(" + c + ") IN ('integer','real') THEN " + c + " END) AS avg, "
                + "min(length(" + c + ")) AS minLength, max(length(" + c + ")) AS maxLength, sum(length(" + c + ")) AS totalLength FROM " + t, null);
        if (stats == null) stats = new JSONObject();
        stats.put("types", types);
        // Grouping on a blob column would read every blob; skip distinct/top values there.
        if (blobs == 0) {
            stats.put("distinct", scalarLong(db, "SELECT count(DISTINCT " + c + ") FROM " + t));
            stats.put("top", new JSONArray(rows(db, "SELECT " + nonBlob + " AS value, count(*) AS count FROM " + t + " GROUP BY " + c + " ORDER BY 2 DESC LIMIT 10", null)));
        } else {
            stats.put("distinct", JSONObject.NULL);
            stats.put("top", new JSONArray());
        }
        return stats;
    }

    JSONObject query(String dbId, JSONObject args) throws JSONException {
        SQLiteDatabase db = db(dbId);
        String sql = args.getString("sql").trim();
        while (sql.endsWith(";")) sql = sql.substring(0, sql.length() - 1).trim();
        int maxRows = Math.min(10000, Math.max(1, args.optInt("maxRows", DEFAULT_QUERY_MAX_ROWS)));

        CancellationSignal signal = new CancellationSignal();
        activeSignal = signal;
        long start = System.nanoTime();
        try (Cursor cur = rawQueryLarge(db, sql, null, signal)) {
            String[] cols = cur.getColumnNames();
            JSONArray rows = new JSONArray();
            boolean hasMore = false;
            while (cur.moveToNext()) {
                if (rows.length() >= maxRows) { hasMore = true; break; }
                JSONArray row = new JSONArray();
                for (int i = 0; i < cols.length; i++) row.put(encodeCell(cur, i, -1, QUERY_TEXT_PREVIEW));
                rows.put(row);
            }
            return new JSONObject()
                    .put("columns", new JSONArray(Arrays.asList(cols)))
                    .put("rows", rows)
                    .put("hasMore", hasMore)
                    .put("timeMs", (System.nanoTime() - start) / 1_000_000.0);
        } catch (OperationCanceledException e) {
            throw new IllegalStateException("Query cancelled.");
        } finally {
            activeSignal = null;
        }
    }

    void interrupt() {
        CancellationSignal s = activeSignal;
        if (s != null) s.cancel();
    }

    // ---------------------------------------------------------------------------------------
    // Database-level info
    // ---------------------------------------------------------------------------------------

    JSONObject dbInfo(String dbId) throws JSONException {
        SQLiteDatabase db = db(dbId);
        File f = resolve(dbId);
        JSONObject pragmas = new JSONObject();
        for (String p : new String[]{"page_size", "page_count", "freelist_count", "journal_mode", "user_version",
                "application_id", "encoding", "auto_vacuum", "schema_version"}) {
            try {
                JSONObject r = firstRow(db, "PRAGMA " + p, null);
                pragmas.put(p, r == null || r.length() == 0 ? JSONObject.NULL : r.opt(r.keys().next()));
            } catch (Exception e) {
                pragmas.put(p, JSONObject.NULL);
            }
        }
        JSONObject counts = new JSONObject();
        for (JSONObject r : rows(db, "SELECT type, count(*) AS n FROM sqlite_master GROUP BY type", null)) {
            counts.put(r.optString("type"), r.optLong("n"));
        }
        JSONObject v = firstRow(db, "SELECT sqlite_version() AS v", null);
        return new JSONObject()
                .put("path", f.getAbsolutePath())
                .put("size", f.length())
                .put("walSize", sideFileSize(f, "-wal"))
                .put("shmSize", sideFileSize(f, "-shm"))
                .put("journalSize", sideFileSize(f, "-journal"))
                .put("modified", f.lastModified())
                .put("sqliteVersion", v == null ? JSONObject.NULL : v.opt("v"))
                .put("pragmas", pragmas)
                .put("objects", counts);
    }

    /** Per-table on-disk size: exact via dbstat when compiled in, otherwise a payload estimate. */
    JSONObject tableSizes(String dbId) throws JSONException {
        SQLiteDatabase db = db(dbId);
        JSONObject sizes = new JSONObject();
        try {
            for (JSONObject r : rows(db, "SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name", null)) {
                sizes.put(r.optString("name"), r.optLong("bytes"));
            }
            return new JSONObject().put("method", "dbstat").put("sizes", sizes);
        } catch (Exception ignored) {
            // dbstat isn't compiled into most platform SQLite builds.
        }
        for (JSONObject t : rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE 'CREATE VIRTUAL%'", null)) {
            String name = t.optString("name");
            try {
                StringBuilder expr = new StringBuilder("0");
                for (JSONObject c : rows(db, "PRAGMA table_info(" + q(name) + ")", null)) {
                    // length() on a blob reads only the record header, not the blob pages.
                    expr.append("+ifnull(length(").append(q(c.optString("name"))).append("),0)");
                }
                sizes.put(name, scalarLong(db, "SELECT ifnull(sum(" + expr + "),0) FROM " + q(name)));
            } catch (Exception ignored) { }
        }
        return new JSONObject().put("method", "estimate").put("sizes", sizes);
    }

    JSONArray integrityCheck(String dbId) throws JSONException {
        JSONArray out = new JSONArray();
        for (JSONObject r : rows(db(dbId), "PRAGMA quick_check(50)", null)) out.put(r.opt(r.keys().next()));
        return out;
    }

    /**
     * Produces a self-contained snapshot of a database: the main file plus its WAL are copied
     * into the cache dir, and the WAL is checkpointed into the copy (never the original).
     */
    File snapshot(String dbId) throws IOException, JSONException {
        File src = resolve(dbId);
        File dir = new File(context.getCacheDir(), "db-inspector-export");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Cannot create export directory");
        File dst = new File(dir, src.getName().endsWith(".db") ? src.getName() : src.getName() + ".db");
        for (String suffix : new String[]{"", "-wal", "-shm", "-journal"}) {
            File stale = new File(dst.getPath() + suffix);
            if (stale.exists()) stale.delete();
        }
        copy(src, dst);
        File wal = new File(src.getPath() + "-wal");
        if (wal.exists() && wal.length() > 0) {
            copy(wal, new File(dst.getPath() + "-wal"));
            SQLiteDatabase copy = SQLiteDatabase.openDatabase(dst.getPath(), null, SQLiteDatabase.OPEN_READWRITE);
            try (Cursor c = copy.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null)) {
                c.moveToFirst();
            } finally {
                copy.close();
            }
            new File(dst.getPath() + "-wal").delete();
            new File(dst.getPath() + "-shm").delete();
        }
        return dst;
    }

    static void copy(File src, File dst) throws IOException {
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
            copy(in, out);
        }
    }

    static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    // ---------------------------------------------------------------------------------------
    // Cursor helpers
    // ---------------------------------------------------------------------------------------

    private Cursor rawQueryLarge(SQLiteDatabase db, String sql, String[] args, CancellationSignal signal) {
        SQLiteDatabase.CursorFactory factory = new SQLiteDatabase.CursorFactory() {
            @Override
            public Cursor newCursor(SQLiteDatabase d, SQLiteCursorDriver driver, String editTable, SQLiteQuery query) {
                SQLiteCursor cursor = new SQLiteCursor(driver, editTable, query);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    cursor.setWindow(new CursorWindow("db-inspector", LARGE_WINDOW_BYTES));
                }
                return cursor;
            }
        };
        return db.rawQueryWithFactory(factory, sql, args, null, signal);
    }

    /**
     * Cell wire format: null, number, string, or an object for values that can't be shown
     * inline — {"$t":"text","v":preview,"len":n} for truncated text and
     * {"$t":"blob","len":n,"mime":...,"hex":firstBytes} for blobs.
     */
    private static Object encodeCell(Cursor cur, int idx, int lenIdx, int textPreview) throws JSONException {
        switch (cur.getType(idx)) {
            case Cursor.FIELD_TYPE_NULL:
                return JSONObject.NULL;
            case Cursor.FIELD_TYPE_INTEGER:
            case Cursor.FIELD_TYPE_FLOAT:
                return numberValue(cur, idx);
            case Cursor.FIELD_TYPE_BLOB: {
                byte[] bytes = cur.getBlob(idx);
                long len = lenIdx >= 0 ? cur.getLong(lenIdx) : bytes.length;
                return new JSONObject().put("$t", "blob").put("len", len).put("mime", sniffMime(bytes)).put("hex", hex(bytes, 16));
            }
            default: {
                String s = cur.getString(idx);
                long len = lenIdx >= 0 ? cur.getLong(lenIdx) : s.length();
                if (lenIdx < 0 && s.length() > textPreview) s = s.substring(0, textPreview);
                if (len > s.length()) return new JSONObject().put("$t", "text").put("v", s).put("len", len);
                return s;
            }
        }
    }

    private static Object numberValue(Cursor cur, int idx) {
        if (cur.getType(idx) == Cursor.FIELD_TYPE_INTEGER) {
            long v = cur.getLong(idx);
            // Beyond 2^53 a JS number would silently lose precision.
            return Math.abs(v) > 9007199254740991L ? String.valueOf(v) : (Object) v;
        }
        double d = cur.getDouble(idx);
        return Double.isNaN(d) || Double.isInfinite(d) ? String.valueOf(d) : (Object) d;
    }

    static String sniffMime(byte[] b) {
        if (b == null || b.length < 4) return null;
        if ((b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8 && (b[2] & 0xFF) == 0xFF) return "image/jpeg";
        if ((b[0] & 0xFF) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return "image/gif";
        if (b[0] == 'B' && b[1] == 'M') return "image/bmp";
        if (b.length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
        if (b.length >= 12 && b[4] == 'f' && b[5] == 't' && b[6] == 'y' && b[7] == 'p') {
            String brand = new String(b, 8, 4);
            return brand.startsWith("hei") || brand.startsWith("mif") ? "image/heic" : "video/mp4";
        }
        if (b[0] == '%' && b[1] == 'P' && b[2] == 'D' && b[3] == 'F') return "application/pdf";
        if (b[0] == 'P' && b[1] == 'K' && b[2] == 3 && b[3] == 4) return "application/zip";
        if ((b[0] & 0xFF) == 0x1F && (b[1] & 0xFF) == 0x8B) return "application/gzip";
        if (b[0] == 'S' && b[1] == 'Q' && b[2] == 'L' && b[3] == 'i') return "application/x-sqlite3";
        return null;
    }

    private static String hex(byte[] b, int max) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(max, b.length); i++) sb.append(String.format(Locale.ROOT, "%02x", b[i] & 0xFF));
        return sb.toString();
    }

    static String q(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private static long scalarLong(SQLiteDatabase db, String sql) {
        return scalarLong(db, sql, null);
    }

    private static long scalarLong(SQLiteDatabase db, String sql, String[] args) {
        try (Cursor c = db.rawQuery(sql, args)) {
            return c.moveToFirst() && !c.isNull(0) ? c.getLong(0) : 0;
        }
    }

    private static JSONObject firstRow(SQLiteDatabase db, String sql, String[] args) throws JSONException {
        List<JSONObject> r = rows(db, sql, args);
        return r.isEmpty() ? null : r.get(0);
    }

    /** Small metadata queries only (pragmas, sqlite_master) — values are read as-is. */
    private static List<JSONObject> rows(SQLiteDatabase db, String sql, String[] args) throws JSONException {
        List<JSONObject> out = new ArrayList<>();
        try (Cursor c = db.rawQuery(sql, args)) {
            String[] cols = c.getColumnNames();
            while (c.moveToNext()) {
                JSONObject o = new JSONObject();
                for (int i = 0; i < cols.length; i++) {
                    switch (c.getType(i)) {
                        case Cursor.FIELD_TYPE_NULL: o.put(cols[i], JSONObject.NULL); break;
                        case Cursor.FIELD_TYPE_INTEGER: o.put(cols[i], c.getLong(i)); break;
                        case Cursor.FIELD_TYPE_FLOAT: o.put(cols[i], c.getDouble(i)); break;
                        case Cursor.FIELD_TYPE_BLOB: o.put(cols[i], "<blob>"); break;
                        default: o.put(cols[i], c.getString(i));
                    }
                }
                out.add(o);
            }
        }
        return out;
    }
}
