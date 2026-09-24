#!/usr/bin/env python3
"""
Desktop harness for the inspector page: serves www/inspector/db-inspector.html and answers
its bridge calls (POST /bridge) the same way the Android/iOS engines do, against the SQLite
files in a local folder (default: ../test-data). Only for UI development — not shipped.

    python3 dev/server.py [--dir test-data] [--port 8787]
    open http://localhost:8787/
"""
import argparse
import base64
import json
import os
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "www", "inspector", "db-inspector.html")
HEADER = b"SQLite format 3\x00"
GRID_TEXT_PREVIEW = 500
QUERY_TEXT_PREVIEW = 5000
STORAGE = {}
DB_DIR = None


def q(name):
    return '"' + name.replace('"', '""') + '"'


def has_header(path):
    with open(path, "rb") as f:
        return f.read(16) == HEADER


def list_databases():
    out = []
    for name in sorted(os.listdir(DB_DIR)):
        path = os.path.join(DB_DIR, name)
        if not os.path.isfile(path) or name.endswith(("-wal", "-shm", "-journal")) or name.startswith("."):
            continue
        size = os.path.getsize(path)
        side = lambda s: os.path.getsize(path + s) if os.path.exists(path + s) else 0
        out.append({"id": "databases/" + name, "name": name, "dir": "databases", "size": size,
                    "walSize": side("-wal"), "journalSize": side("-journal"),
                    "modified": int(os.path.getmtime(path) * 1000),
                    "encrypted": size > 0 and not has_header(path), "empty": size == 0})
    return out


def resolve(db_id):
    path = os.path.join(DB_DIR, db_id.split("/", 1)[-1])
    if not os.path.isfile(path):
        raise ValueError("Unknown database: " + db_id)
    return path


def connect(db_id):
    path = resolve(db_id)
    if os.path.getsize(path) and not has_header(path):
        raise ValueError("This database is encrypted (no plaintext SQLite header). Encrypted databases are not supported.")
    con = sqlite3.connect("file:" + path + "?mode=ro", uri=True, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


def rows(con, sql, args=()):
    cur = con.execute(sql, args)
    cols = [d[0] for d in cur.description] if cur.description else []
    return [{c: ("<blob>" if isinstance(v, bytes) else v) for c, v in zip(cols, r)} for r in cur.fetchall()]


def scalar(con, sql, args=()):
    r = con.execute(sql, args).fetchone()
    return r[0] if r and r[0] is not None else 0


def sniff(b):
    if not b or len(b) < 4:
        return None
    if b[:3] == b"\xff\xd8\xff": return "image/jpeg"
    if b[:4] == b"\x89PNG": return "image/png"
    if b[:3] == b"GIF": return "image/gif"
    if b[:2] == b"BM": return "image/bmp"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP": return "image/webp"
    if b[4:8] == b"ftyp": return "image/heic" if b[8:11] in (b"hei", b"mif") else "video/mp4"
    if b[:4] == b"%PDF": return "application/pdf"
    if b[:4] == b"PK\x03\x04": return "application/zip"
    if b[:2] == b"\x1f\x8b": return "application/gzip"
    if b[:4] == b"SQLi": return "application/x-sqlite3"
    return None


def encode(v, length=None, preview=GRID_TEXT_PREVIEW):
    if v is None or isinstance(v, (int, float)):
        if isinstance(v, int) and abs(v) > 9007199254740991:
            return str(v)
        return v
    if isinstance(v, bytes):
        return {"$t": "blob", "len": length if length is not None else len(v), "mime": sniff(v), "hex": v[:16].hex()}
    n = length if length is not None else len(v)
    if length is None and len(v) > preview:
        v = v[:preview]
    return {"$t": "text", "v": v, "len": n} if n > len(v) else v


def entities(con):
    try:
        if not scalar(con, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='OSSYS_ENTITY'"):
            return {}
        return {r["physical"].upper(): r for r in rows(con, "SELECT Name AS name, Physical_Table_name AS physical, Extra_Info AS extra FROM OSSYS_ENTITY") if r["physical"]}
    except sqlite3.Error:
        return {}


def is_system(name):
    u = name.upper()
    return u.startswith(("SQLITE_", "OSSYS_", "BACKUP_OSSYS_")) or u == "ANDROID_METADATA"


def overview(con, a):
    ents = entities(con)
    objs = rows(con, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name COLLATE NOCASE")
    idx = {}
    for o in objs:
        if o["type"] == "index":
            idx[o["tbl_name"]] = idx.get(o["tbl_name"], 0) + 1
    tables = []
    for o in objs:
        if o["type"] not in ("table", "view"):
            continue
        sql = (o["sql"] or "").upper()
        virtual = sql.startswith("CREATE VIRTUAL TABLE")
        t = {"name": o["name"], "type": o["type"], "virtual": virtual, "withoutRowid": "WITHOUT ROWID" in sql,
             "system": is_system(o["name"]), "indexes": idx.get(o["name"], 0)}
        e = ents.get(o["name"].upper())
        if e:
            t["logicalName"] = e["name"]
        if o["type"] == "table" and not virtual:
            try:
                t["rows"] = scalar(con, "SELECT count(*) FROM " + q(o["name"]))
            except sqlite3.Error:
                t["rows"] = None
        tables.append(t)
    return {"tables": tables, "indexCount": sum(1 for o in objs if o["type"] == "index"),
            "triggerCount": sum(1 for o in objs if o["type"] == "trigger"), "outsystems": bool(ents)}


def table_schema(con, a):
    t = a["table"]
    m = rows(con, "SELECT type, sql FROM sqlite_master WHERE name = ?", (t,))
    if not m:
        raise ValueError("Unknown table: " + t)
    m = m[0]
    indexes = []
    for i in rows(con, "PRAGMA index_list(%s)" % q(t)):
        i["columns"] = [c["name"] if c["name"] is not None else "<expr>" for c in rows(con, "PRAGMA index_info(%s)" % q(i["name"]))]
        s = rows(con, "SELECT sql FROM sqlite_master WHERE type='index' AND name = ?", (i["name"],))
        i["sql"] = s[0]["sql"] if s else None
        indexes.append(i)
    sql = m["sql"] or ""
    out = {"name": t, "type": m["type"], "sql": sql, "rowid": m["type"] == "table" and "WITHOUT ROWID" not in sql.upper(),
           "columns": rows(con, "PRAGMA table_xinfo(%s)" % q(t)), "indexes": indexes,
           "foreignKeys": rows(con, "PRAGMA foreign_key_list(%s)" % q(t)),
           "triggers": rows(con, "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?", (t,))}
    e = entities(con).get(t.upper())
    if e:
        out["logicalName"] = e["name"]
        try:
            out["outsystemsAttrs"] = json.loads(e["extra"] or "{}").get("attrs")
        except ValueError:
            pass
    return out


def table_rows(con, a):
    t = a["table"]
    offset = max(0, int(a.get("offset", 0)))
    limit = min(500, max(1, int(a.get("limit", 50))))
    sort = a.get("sortColumn") or ""
    desc = (a.get("sortDir") or "asc").lower() == "desc"
    search = (a.get("search") or "").strip()
    m = rows(con, "SELECT type, sql FROM sqlite_master WHERE name = ?", (t,))
    if not m:
        raise ValueError("Unknown table: " + t)
    has_rowid = m[0]["type"] == "table" and "WITHOUT ROWID" not in (m[0]["sql"] or "").upper()
    info = rows(con, "PRAGMA table_info(%s)" % q(t))
    names = [c["name"] for c in info]
    searchable = [c["name"] for c in info if "BLOB" not in (c["type"] or "").upper()]
    proj = ["rowid" if has_rowid else "NULL"]
    for n in names:
        c = q(n)
        proj.append("CASE WHEN typeof({c})='text' AND length({c})>{p} THEN substr({c},1,{p}) WHEN typeof({c})='blob' THEN substr({c},1,16) ELSE {c} END, length({c})".format(c=c, p=GRID_TEXT_PREVIEW))
    where, args = "", ()
    if search and searchable:
        where = " WHERE (" + " OR ".join(q(n) + " LIKE ?1" for n in searchable) + ")"
        args = ("%" + search + "%",)
    order = " ORDER BY %s %s" % (q(sort), "DESC" if desc else "ASC") if sort in names else ""
    total = scalar(con, "SELECT count(*) FROM " + q(t) + where, args)
    cur = con.execute("SELECT " + ", ".join(proj) + " FROM " + q(t) + where + order + " LIMIT %d OFFSET %d" % (limit, offset), args)
    out_rows, rowids = [], []
    for r in cur.fetchall():
        rowids.append(r[0] if has_rowid else None)
        out_rows.append([encode(r[1 + i * 2], r[2 + i * 2]) for i in range(len(names))])
    return {"columns": names, "rowids": rowids if has_rowid else None, "rows": out_rows, "total": total, "offset": offset, "limit": limit}


def cell(con, a):
    c = q(a["column"])
    r = con.execute("SELECT typeof({c}), length({c}), CASE WHEN typeof({c})='text' THEN substr({c},1,8000000) WHEN typeof({c})='blob' THEN substr({c},1,8388608) ELSE {c} END FROM {t} WHERE rowid = ?".format(c=c, t=q(a["table"])), (a["rowid"],)).fetchone()
    if not r:
        raise ValueError("Row not found")
    typ, ln, v = r[0], r[1] or 0, r[2]
    out = {"type": typ, "len": ln}
    if isinstance(v, bytes):
        out.update(base64=base64.b64encode(v).decode(), mime=sniff(v), truncated=len(v) < ln)
    elif isinstance(v, str):
        out.update(text=v, truncated=len(v) < ln)
    else:
        out["value"] = v
    return out


def column_stats(con, a):
    t, c = q(a["table"]), q(a["column"])
    types = rows(con, "SELECT typeof(%s) AS type, count(*) AS count FROM %s GROUP BY 1 ORDER BY 2 DESC" % (c, t))
    blobs = sum(r["count"] for r in types if r["type"] == "blob")
    nb = "CASE WHEN typeof({c})='text' THEN substr({c},1,200) WHEN typeof({c})<>'blob' THEN {c} END".format(c=c)
    s = rows(con, "SELECT count(*) AS total, count({c}) AS nonNull, min({nb}) AS min, max({nb}) AS max, avg(CASE WHEN typeof({c}) IN ('integer','real') THEN {c} END) AS avg, min(length({c})) AS minLength, max(length({c})) AS maxLength, sum(length({c})) AS totalLength FROM {t}".format(c=c, nb=nb, t=t))[0]
    s["types"] = types
    if blobs == 0:
        s["distinct"] = scalar(con, "SELECT count(DISTINCT %s) FROM %s" % (c, t))
        s["top"] = rows(con, "SELECT %s AS value, count(*) AS count FROM %s GROUP BY %s ORDER BY 2 DESC LIMIT 10" % (nb, t, c))
    else:
        s["distinct"], s["top"] = None, []
    return s


def query(con, a):
    sql = a["sql"].strip().rstrip(";").strip()
    max_rows = min(10000, max(1, int(a.get("maxRows", 1000))))
    start = time.perf_counter()
    try:
        cur = con.execute(sql)
    except sqlite3.OperationalError as e:
        raise ValueError(str(e))
    cols = [d[0] for d in cur.description] if cur.description else []
    fetched = cur.fetchmany(max_rows + 1)
    has_more = len(fetched) > max_rows
    out = [[encode(v, preview=QUERY_TEXT_PREVIEW) for v in r] for r in fetched[:max_rows]]
    return {"columns": cols, "rows": out, "hasMore": has_more, "timeMs": (time.perf_counter() - start) * 1000}


def db_info(con, a):
    path = resolve(a["db"])
    pr = {}
    for p in ("page_size", "page_count", "freelist_count", "journal_mode", "user_version", "application_id", "encoding", "auto_vacuum", "schema_version"):
        try:
            r = con.execute("PRAGMA " + p).fetchone()
            pr[p] = r[0] if r else None
        except sqlite3.Error:
            pr[p] = None
    side = lambda s: os.path.getsize(path + s) if os.path.exists(path + s) else 0
    return {"path": path, "size": os.path.getsize(path), "walSize": side("-wal"), "shmSize": side("-shm"), "journalSize": side("-journal"),
            "modified": int(os.path.getmtime(path) * 1000), "sqliteVersion": scalar(con, "SELECT sqlite_version()"),
            "pragmas": pr, "objects": {r["type"]: r["n"] for r in rows(con, "SELECT type, count(*) AS n FROM sqlite_master GROUP BY type")}}


def table_sizes(con, a):
    if os.environ.get("DBI_NO_DBSTAT") != "1":
        try:
            return {"method": "dbstat", "sizes": {r["name"]: r["bytes"] for r in rows(con, "SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name")}}
        except sqlite3.Error:
            pass
    sizes = {}
    for t in rows(con, "SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE 'CREATE VIRTUAL%'"):
        expr = "0" + "".join("+ifnull(length(%s),0)" % q(c["name"]) for c in rows(con, "PRAGMA table_info(%s)" % q(t["name"])))
        sizes[t["name"]] = scalar(con, "SELECT ifnull(sum(%s),0) FROM %s" % (expr, q(t["name"])))
    return {"method": "estimate", "sizes": sizes}


def handle(action, a):
    if action == "context":
        return {"platform": "dev", "osVersion": "desktop", "device": "Python harness", "appId": "dev.harness", "appVersion": "0.0.0", "options": {}}
    if action == "listDatabases":
        return list_databases()
    if action == "storageGet":
        return STORAGE.get(a["key"])
    if action == "storageSet":
        if a.get("value") is None:
            STORAGE.pop(a["key"], None)
        else:
            STORAGE[a["key"]] = a["value"]
        return True
    if action in ("saveFile", "exportDatabase"):
        return {"saved": True, "devNote": "file save is a no-op in the dev harness"}
    if action == "pickFile":
        return {"cancelled": True}
    if action in ("setTheme", "close", "interrupt"):
        return True
    handlers = {"overview": overview, "tableSchema": table_schema, "tableRows": table_rows, "cell": cell,
                "columnStats": column_stats, "query": query, "dbInfo": db_info, "tableSizes": table_sizes,
                "integrityCheck": lambda con, a: [r[0] for r in con.execute("PRAGMA quick_check(50)").fetchall()]}
    if action not in handlers:
        raise ValueError("Unknown action: " + action)
    con = connect(a["db"])
    try:
        return handlers[action](con, a)
    finally:
        con.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        with open(PAGE, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            env = {"ok": True, "data": handle(req["action"], req.get("args") or {})}
        except Exception as e:  # mirror the native envelope
            env = {"ok": False, "error": str(e)}
        body = json.dumps(env).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--dir", default=os.path.join(ROOT, "test-data"))
    p.add_argument("--port", type=int, default=8787)
    o = p.parse_args()
    DB_DIR = os.path.abspath(o.dir)
    print("DB Inspector dev harness on http://localhost:%d/ (databases from %s)" % (o.port, DB_DIR))
    ThreadingHTTPServer(("127.0.0.1", o.port), Handler).serve_forever()
