// Browser engine for the inspector page: the same actions (and JSON shapes) as the Android
// and iOS engines and dev/server.py, running on wa-sqlite (WebAssembly) over a lazy,
// read-only VFS. Databases never leave the machine.
import SQLiteESMFactory from './vendor/wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from './vendor/wa-sqlite/src/sqlite-api.js';
import { LazyFileVFS } from './lazy-file-vfs.js';

const GRID_TEXT_PREVIEW = 500;
const QUERY_TEXT_PREVIEW = 5000;
const CELL_TEXT_MAX = 8000000;
const CELL_BLOB_MAX = 8 * 1024 * 1024;
const HEADER = 'SQLite format 3\u0000';

const ready = (async () => {
  const module = await SQLiteESMFactory();
  const sqlite3 = SQLite.Factory(module);
  const vfs = new LazyFileVFS();
  sqlite3.vfs_register(vfs, false);
  return { sqlite3, vfs };
})();

/** id -> { name, file, wal, meta } */
const files = new Map();
/** id -> db handle */
const connections = new Map();

const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';

// ---- helpers ---------------------------------------------------------------------------

async function db(id) {
  const { sqlite3 } = await ready;
  if (connections.has(id)) return connections.get(id);
  const f = files.get(id);
  if (!f) throw new Error('Unknown database: ' + id);
  if (f.meta.encrypted) throw new Error('This database is encrypted (no plaintext SQLite header). Encrypted databases are not supported.');
  const handle = await sqlite3.open_v2(id, SQLite.SQLITE_OPEN_READONLY, 'lazyfile');
  // Keep sorting / temp b-trees in memory, and give SQLite a roomy page cache.
  await sqlite3.exec(handle, 'PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32768;');
  connections.set(id, handle);
  return handle;
}

function toJs(v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}

/** Small metadata queries (pragmas, sqlite_master): rows as objects, blobs as "<blob>". */
async function rows(handle, sql, params) {
  const { sqlite3 } = await ready;
  const out = [];
  for await (const stmt of sqlite3.statements(handle, sql)) {
    if (params) sqlite3.bind_collection(stmt, params);
    const cols = sqlite3.column_names(stmt);
    while (await sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
      const o = {};
      cols.forEach((c, i) => {
        const t = sqlite3.column_type(stmt, i);
        o[c] = t === SQLite.SQLITE_BLOB ? '<blob>' : toJs(sqlite3.column(stmt, i));
      });
      out.push(o);
    }
  }
  return out;
}

async function scalar(handle, sql, params) {
  const r = await rows(handle, sql, params);
  if (!r.length) return 0;
  const v = r[0][Object.keys(r[0])[0]];
  return v == null ? 0 : v;
}

function sniff(b) {
  if (!b || b.length < 4) return null;
  const s = (i, str) => [...str].every((ch, k) => b[i + k] === ch.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && s(1, 'PNG')) return 'image/png';
  if (s(0, 'GIF')) return 'image/gif';
  if (s(0, 'BM')) return 'image/bmp';
  if (b.length >= 12 && s(0, 'RIFF') && s(8, 'WEBP')) return 'image/webp';
  if (b.length >= 12 && s(4, 'ftyp')) return (s(8, 'hei') || s(8, 'mif')) ? 'image/heic' : 'video/mp4';
  if (s(0, '%PDF')) return 'application/pdf';
  if (s(0, 'PK') && b[2] === 3 && b[3] === 4) return 'application/zip';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'application/gzip';
  if (s(0, 'SQLi')) return 'application/x-sqlite3';
  return null;
}

const hex = (b, max) => Array.from(b.subarray(0, max), (x) => x.toString(16).padStart(2, '0')).join('');

function base64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Cell wire format shared with the native engines. */
function encodeCell(sqlite3, stmt, i, lenIdx, preview) {
  switch (sqlite3.column_type(stmt, i)) {
    case SQLite.SQLITE_NULL: return null;
    case SQLite.SQLITE_INTEGER: case SQLite.SQLITE_FLOAT: {
      const v = sqlite3.column(stmt, i);
      if (typeof v === 'bigint') return v.toString();
      return Number.isFinite(v) ? v : String(v);
    }
    case SQLite.SQLITE_BLOB: {
      const b = sqlite3.column_blob(stmt, i); // view into WASM memory, no copy
      const len = lenIdx >= 0 ? Number(sqlite3.column(stmt, lenIdx)) : b.length;
      return { $t: 'blob', len, mime: sniff(b), hex: hex(b, 16) };
    }
    default: {
      let s = sqlite3.column_text(stmt, i);
      const len = lenIdx >= 0 ? Number(sqlite3.column(stmt, lenIdx)) : s.length;
      if (lenIdx < 0 && s.length > preview) s = s.slice(0, preview);
      return len > s.length ? { $t: 'text', v: s, len } : s;
    }
  }
}

function isSystem(name) {
  const u = name.toUpperCase();
  return u.startsWith('SQLITE_') || u.startsWith('OSSYS_') || u.startsWith('BACKUP_OSSYS_') || u === 'ANDROID_METADATA';
}

async function entities(handle) {
  try {
    if (!await scalar(handle, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='OSSYS_ENTITY'")) return new Map();
    const map = new Map();
    for (const r of await rows(handle, 'SELECT Name AS name, Physical_Table_name AS physical, Extra_Info AS extra FROM OSSYS_ENTITY')) {
      if (r.physical) map.set(String(r.physical).toUpperCase(), r);
    }
    return map;
  } catch (e) {
    return new Map();
  }
}

// ---- actions -------------------------------------------------------------------------------

const actions = {
  async listDatabases() {
    return [...files.values()].map((f) => f.meta);
  },

  async overview({ db: id }) {
    const h = await db(id);
    const ents = await entities(h);
    const objs = await rows(h, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name COLLATE NOCASE');
    const idx = {};
    let indexCount = 0, triggerCount = 0;
    for (const o of objs) {
      if (o.type === 'index') { indexCount++; idx[o.tbl_name] = (idx[o.tbl_name] || 0) + 1; }
      if (o.type === 'trigger') triggerCount++;
    }
    const tables = [];
    for (const o of objs) {
      if (o.type !== 'table' && o.type !== 'view') continue;
      const sql = String(o.sql || '').toUpperCase();
      const virtual = sql.startsWith('CREATE VIRTUAL TABLE');
      const t = { name: o.name, type: o.type, virtual, withoutRowid: sql.includes('WITHOUT ROWID'), system: isSystem(o.name), indexes: idx[o.name] || 0 };
      const e = ents.get(o.name.toUpperCase());
      if (e) t.logicalName = e.name;
      if (o.type === 'table' && !virtual) {
        try { t.rows = await scalar(h, 'SELECT count(*) FROM ' + q(o.name)); } catch (err) { t.rows = null; }
      }
      tables.push(t);
    }
    return { tables, indexCount, triggerCount, outsystems: ents.size > 0 };
  },

  async tableSchema({ db: id, table }) {
    const h = await db(id);
    const m = (await rows(h, 'SELECT type, sql FROM sqlite_master WHERE name = ?', [table]))[0];
    if (!m) throw new Error('Unknown table: ' + table);
    let columns;
    try { columns = await rows(h, `PRAGMA table_xinfo(${q(table)})`); } catch (e) { columns = await rows(h, `PRAGMA table_info(${q(table)})`); }
    const indexes = [];
    for (const i of await rows(h, `PRAGMA index_list(${q(table)})`)) {
      i.columns = (await rows(h, `PRAGMA index_info(${q(i.name)})`)).map((c) => c.name == null ? '<expr>' : c.name);
      const s = await rows(h, "SELECT sql FROM sqlite_master WHERE type='index' AND name = ?", [i.name]);
      i.sql = s.length ? s[0].sql : null;
      indexes.push(i);
    }
    const sql = m.sql || '';
    const out = {
      name: table, type: m.type, sql, rowid: m.type === 'table' && !sql.toUpperCase().includes('WITHOUT ROWID'),
      columns, indexes,
      foreignKeys: await rows(h, `PRAGMA foreign_key_list(${q(table)})`),
      triggers: await rows(h, "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?", [table])
    };
    const e = (await entities(h)).get(table.toUpperCase());
    if (e) {
      out.logicalName = e.name;
      try { out.outsystemsAttrs = JSON.parse(e.extra || '{}').attrs; } catch (err) { /* ignore */ }
    }
    return out;
  },

  async tableRows({ db: id, table, offset = 0, limit = 50, sortColumn = '', sortDir = 'asc', search = '' }) {
    const { sqlite3 } = await ready;
    const h = await db(id);
    offset = Math.max(0, offset | 0);
    limit = Math.min(500, Math.max(1, limit | 0));
    search = String(search || '').trim();
    const m = (await rows(h, 'SELECT type, sql FROM sqlite_master WHERE name = ?', [table]))[0];
    if (!m) throw new Error('Unknown table: ' + table);
    const hasRowid = m.type === 'table' && !String(m.sql || '').toUpperCase().includes('WITHOUT ROWID');
    const info = await rows(h, `PRAGMA table_info(${q(table)})`);
    const names = info.map((c) => c.name);
    const searchable = info.filter((c) => !String(c.type || '').toUpperCase().includes('BLOB')).map((c) => c.name);
    const proj = [hasRowid ? 'rowid' : 'NULL'];
    for (const n of names) {
      const c = q(n);
      proj.push(`CASE WHEN typeof(${c})='text' AND length(${c})>${GRID_TEXT_PREVIEW} THEN substr(${c},1,${GRID_TEXT_PREVIEW}) WHEN typeof(${c})='blob' THEN substr(${c},1,16) ELSE ${c} END, length(${c})`);
    }
    let where = '';
    const args = [];
    if (search && searchable.length) {
      where = ' WHERE (' + searchable.map((n) => q(n) + ' LIKE ?1').join(' OR ') + ')';
      args.push('%' + search + '%');
    }
    const order = names.includes(sortColumn) ? ` ORDER BY ${q(sortColumn)} ${String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}` : '';
    const total = await scalar(h, 'SELECT count(*) FROM ' + q(table) + where, args.length ? args : undefined);
    const outRows = [], rowids = [];
    const sql = `SELECT ${proj.join(', ')} FROM ${q(table)}${where}${order} LIMIT ${limit} OFFSET ${offset}`;
    for await (const stmt of sqlite3.statements(h, sql)) {
      if (args.length) sqlite3.bind_collection(stmt, args);
      while (await sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
        rowids.push(hasRowid ? toJs(sqlite3.column(stmt, 0)) : null);
        const row = [];
        for (let i = 0; i < names.length; i++) row.push(encodeCell(sqlite3, stmt, 1 + i * 2, 2 + i * 2, GRID_TEXT_PREVIEW));
        outRows.push(row);
      }
    }
    return { columns: names, rowids: hasRowid ? rowids : null, rows: outRows, total, offset, limit };
  },

  async cell({ db: id, table, column, rowid }) {
    const { sqlite3 } = await ready;
    const h = await db(id);
    const c = q(column);
    const sql = `SELECT typeof(${c}), length(${c}), CASE WHEN typeof(${c})='text' THEN substr(${c},1,${CELL_TEXT_MAX}) WHEN typeof(${c})='blob' THEN substr(${c},1,${CELL_BLOB_MAX}) ELSE ${c} END FROM ${q(table)} WHERE rowid = ?`;
    for await (const stmt of sqlite3.statements(h, sql)) {
      sqlite3.bind_collection(stmt, [Number(rowid)]);
      if (await sqlite3.step(stmt) !== SQLite.SQLITE_ROW) throw new Error('Row not found');
      const type = sqlite3.column_text(stmt, 0);
      const len = Number(sqlite3.column(stmt, 1) || 0);
      const out = { type, len };
      const t = sqlite3.column_type(stmt, 2);
      if (t === SQLite.SQLITE_BLOB) {
        const b = sqlite3.column_blob(stmt, 2);
        Object.assign(out, { base64: base64(b), mime: sniff(b), truncated: b.length < len });
      } else if (t === SQLite.SQLITE_TEXT) {
        const s = sqlite3.column_text(stmt, 2);
        Object.assign(out, { text: s, truncated: s.length < len });
      } else {
        out.value = t === SQLite.SQLITE_NULL ? null : toJs(sqlite3.column(stmt, 2));
      }
      return out;
    }
    throw new Error('Row not found');
  },

  async columnStats({ db: id, table, column }) {
    const h = await db(id);
    const t = q(table), c = q(column);
    const types = await rows(h, `SELECT typeof(${c}) AS type, count(*) AS count FROM ${t} GROUP BY 1 ORDER BY 2 DESC`);
    const blobs = types.filter((r) => r.type === 'blob').reduce((a, r) => a + r.count, 0);
    const nb = `CASE WHEN typeof(${c})='text' THEN substr(${c},1,200) WHEN typeof(${c})<>'blob' THEN ${c} END`;
    const s = (await rows(h, `SELECT count(*) AS total, count(${c}) AS nonNull, min(${nb}) AS min, max(${nb}) AS max, avg(CASE WHEN typeof(${c}) IN ('integer','real') THEN ${c} END) AS avg, min(length(${c})) AS minLength, max(length(${c})) AS maxLength, sum(length(${c})) AS totalLength FROM ${t}`))[0];
    s.types = types;
    if (!blobs) {
      s.distinct = await scalar(h, `SELECT count(DISTINCT ${c}) FROM ${t}`);
      s.top = await rows(h, `SELECT ${nb} AS value, count(*) AS count FROM ${t} GROUP BY ${c} ORDER BY 2 DESC LIMIT 10`);
    } else {
      s.distinct = null;
      s.top = [];
    }
    return s;
  },

  async query({ db: id, sql, maxRows = 1000 }) {
    const { sqlite3 } = await ready;
    const h = await db(id);
    sql = String(sql).trim().replace(/;+\s*$/, '');
    maxRows = Math.min(10000, Math.max(1, maxRows | 0));
    const start = performance.now();
    let columns = [];
    const out = [];
    let hasMore = false;
    for await (const stmt of sqlite3.statements(h, sql)) {
      columns = sqlite3.column_names(stmt);
      while (await sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
        if (out.length >= maxRows) { hasMore = true; break; }
        const row = [];
        for (let i = 0; i < columns.length; i++) row.push(encodeCell(sqlite3, stmt, i, -1, QUERY_TEXT_PREVIEW));
        out.push(row);
      }
      break; // first statement only, like the native engines
    }
    return { columns, rows: out, hasMore, timeMs: performance.now() - start };
  },

  async dbInfo({ db: id }) {
    const { sqlite3 } = await ready;
    const h = await db(id);
    const f = files.get(id);
    const pragmas = {};
    for (const p of ['page_size', 'page_count', 'freelist_count', 'journal_mode', 'user_version', 'application_id', 'encoding', 'auto_vacuum', 'schema_version']) {
      try { const r = await rows(h, 'PRAGMA ' + p); pragmas[p] = r.length ? r[0][Object.keys(r[0])[0]] : null; } catch (e) { pragmas[p] = null; }
    }
    // The VFS presents WAL files as rollback mode; report what the file really is.
    if (f.meta.walMode) pragmas.journal_mode = 'wal';
    const objects = {};
    for (const r of await rows(h, 'SELECT type, count(*) AS n FROM sqlite_master GROUP BY type')) objects[r.type] = r.n;
    return {
      path: f.name + (f.wal ? ' + ' + f.wal.name : ''),
      size: f.file.size, walSize: f.wal ? f.wal.size : 0, shmSize: 0, journalSize: 0,
      modified: f.file.lastModified, sqliteVersion: sqlite3.libversion(), pragmas, objects,
      walFrames: f.meta.walCommits || 0, walNote: f.meta.walNote || null
    };
  },

  async tableSizes({ db: id }) {
    const h = await db(id);
    try {
      const sizes = {};
      for (const r of await rows(h, 'SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name')) sizes[r.name] = r.bytes;
      return { method: 'dbstat', sizes };
    } catch (e) { /* dbstat not compiled in */ }
    const sizes = {};
    for (const t of await rows(h, "SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE 'CREATE VIRTUAL%'")) {
      try {
        const expr = '0' + (await rows(h, `PRAGMA table_info(${q(t.name)})`)).map((c) => `+ifnull(length(${q(c.name)}),0)`).join('');
        sizes[t.name] = await scalar(h, `SELECT ifnull(sum(${expr}),0) FROM ${q(t.name)}`);
      } catch (e) { /* skip */ }
    }
    return { method: 'estimate', sizes };
  },

  async integrityCheck({ db: id }) {
    const h = await db(id);
    return (await rows(h, 'PRAGMA quick_check(50)')).map((r) => r[Object.keys(r)[0]]);
  },

  async exportDatabase({ db: id }) {
    const { vfs } = await ready;
    const f = files.get(id);
    const name = f.name.replace(/\.(db|sqlite3?|db3)$/i, '') + (f.wal ? '-merged' : '') + '.db';
    return { name, blob: vfs.mergedBlob(id) };
  }
};

// ---- registration & messaging ----------------------------------------------------------------

function readHeader(file) {
  const bytes = new Uint8Array(new FileReaderSync().readAsArrayBuffer(file.slice(0, 100)));
  return bytes;
}

async function register({ id, name, file, wal }) {
  const { sqlite3, vfs } = await ready;
  if (connections.has(id)) { // re-registered (e.g. its -wal was added later)
    await sqlite3.close(connections.get(id));
    connections.delete(id);
  }
  const head = file.size ? readHeader(file) : new Uint8Array(0);
  const isSqlite = head.length >= 16 && String.fromCharCode(...head.subarray(0, 16)) === HEADER;
  const meta = {
    id, name, dir: 'local file', size: file.size, walSize: wal ? wal.size : 0, journalSize: 0,
    modified: file.lastModified, encrypted: file.size > 0 && !isSqlite, empty: file.size === 0,
    walMode: isSqlite && head[18] === 2 && head[19] === 2
  };
  const entry = vfs.register(id, file, isSqlite ? wal : null);
  if (wal) {
    if (entry.wal) { meta.walCommits = entry.wal.commits; meta.walNote = `WAL applied: ${entry.wal.pages.size} pages from ${entry.wal.commits} commits`; }
    else meta.walNote = entry.walError ? 'WAL ignored: ' + entry.walError : 'WAL ignored: no committed frames';
  }
  files.set(id, { name, file, wal, meta });
  return meta;
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      let data;
      if (msg.type === 'register') data = await register(msg);
      else {
        const fn = actions[msg.action];
        if (!fn) throw new Error('Unknown action: ' + msg.action);
        data = await fn(msg.args || {});
      }
      self.postMessage({ callId: msg.callId, envelope: { ok: true, data } });
    } catch (err) {
      self.postMessage({ callId: msg.callId, envelope: { ok: false, error: err && err.message ? err.message : String(err) } });
    }
  });
};
self.postMessage({ type: 'booted' });
