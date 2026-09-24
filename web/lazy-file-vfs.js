// Read-only wa-sqlite VFS over browser File objects, for use inside a dedicated Worker.
//
// Nothing is ever copied into memory up front: SQLite asks for a page, the VFS reads just
// that range with FileReaderSync + File.slice(), so a multi-hundred-MB database opens
// instantly and uses a few MB of RAM (plus a bounded block cache).
//
// A companion "-wal" file is applied as an in-memory overlay: frames are validated
// (salts + checksum chain, exactly as SQLite does) and only frames up to the last commit
// are used. The files themselves are never modified.
import * as VFS from './vendor/wa-sqlite/src/VFS.js';

const BLOCK_SIZE = 64 * 1024;
const MAX_CACHED_BLOCKS = 512; // 32 MB

export class LazyFileVFS extends VFS.Base {
  name = 'lazyfile';
  mxPathName = 256;

  constructor() {
    super();
    this.reader = new FileReaderSync();
    /** name -> { file, wal: {pages: Map<pgno, walOffset>, walFile, pageSize, dbPages} | null } */
    this.dbs = new Map();
    /** fileId -> open handle */
    this.handles = new Map();
    /** LRU of `${fileKey}:${block}` -> Uint8Array */
    this.cache = new Map();
    this.fileKeys = new WeakMap();
    this.nextKey = 1;
  }

  /** Registers a database under `name`; `walFile` (optional) is its -wal companion. */
  register(name, file, walFile) {
    const entry = { file, wal: null, walError: null };
    if (walFile && walFile.size >= 32) {
      try {
        entry.wal = this.parseWal(walFile);
      } catch (e) {
        entry.walError = String(e && e.message || e);
      }
    }
    this.dbs.set(name, entry);
    return entry;
  }

  // ---- WAL -------------------------------------------------------------------------------

  parseWal(walFile) {
    const buf = new Uint8Array(this.reader.readAsArrayBuffer(walFile));
    const dv = new DataView(buf.buffer);
    const magic = dv.getUint32(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) throw new Error('Not a WAL file');
    const bigEndianSum = (magic & 1) === 1;
    const pageSize = dv.getUint32(8) || 65536;
    const salt1 = dv.getUint32(16), salt2 = dv.getUint32(20);
    let [s0, s1] = checksum(buf, 0, 24, 0, 0, bigEndianSum);
    if (s0 !== dv.getUint32(24) || s1 !== dv.getUint32(28)) throw new Error('WAL header checksum mismatch');

    const committed = new Map();
    let pending = new Map();
    let dbPages = 0;
    let frames = 0;
    const frameSize = 24 + pageSize;
    for (let off = 32; off + frameSize <= buf.length; off += frameSize) {
      if (dv.getUint32(off + 8) !== salt1 || dv.getUint32(off + 12) !== salt2) break;
      [s0, s1] = checksum(buf, off, 8, s0, s1, bigEndianSum);
      [s0, s1] = checksum(buf, off + 24, pageSize, s0, s1, bigEndianSum);
      if (s0 !== dv.getUint32(off + 16) || s1 !== dv.getUint32(off + 20)) break;
      const pgno = dv.getUint32(off);
      const commitSize = dv.getUint32(off + 4);
      pending.set(pgno, off + 24);
      if (commitSize) {
        for (const [p, o] of pending) committed.set(p, o);
        pending = new Map();
        dbPages = commitSize;
        frames++;
      }
    }
    if (!committed.size) return null;
    return { pages: committed, walFile, pageSize, dbPages, commits: frames };
  }

  // ---- Reading -----------------------------------------------------------------------------

  keyOf(blob) {
    let k = this.fileKeys.get(blob);
    if (!k) { k = this.nextKey++; this.fileKeys.set(blob, k); }
    return k;
  }

  readBlock(blob, block) {
    const key = this.keyOf(blob) + ':' + block;
    let data = this.cache.get(key);
    if (data) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, data);
      return data;
    }
    const start = block * BLOCK_SIZE;
    data = new Uint8Array(this.reader.readAsArrayBuffer(blob.slice(start, Math.min(blob.size, start + BLOCK_SIZE))));
    this.cache.set(key, data);
    if (this.cache.size > MAX_CACHED_BLOCKS) this.cache.delete(this.cache.keys().next().value);
    return data;
  }

  /** Copies blob[offset, offset+len) into dst at dstOffset; returns bytes copied. */
  readRange(blob, offset, len, dst, dstOffset) {
    let copied = 0;
    while (copied < len && offset + copied < blob.size) {
      const pos = offset + copied;
      const block = Math.floor(pos / BLOCK_SIZE);
      const data = this.readBlock(blob, block);
      const inBlock = pos - block * BLOCK_SIZE;
      const n = Math.min(len - copied, data.length - inBlock);
      if (n <= 0) break;
      dst.set(data.subarray(inBlock, inBlock + n), dstOffset + copied);
      copied += n;
    }
    return copied;
  }

  dbSize(entry) {
    return entry.wal ? entry.wal.dbPages * entry.wal.pageSize : entry.file.size;
  }

  readDb(entry, pData, iOffset) {
    const size = this.dbSize(entry);
    const want = Math.max(0, Math.min(pData.length, size - iOffset));
    if (!entry.wal) {
      this.readRange(entry.file, iOffset, want, pData, 0);
    } else {
      const { pages, walFile, pageSize } = entry.wal;
      let done = 0;
      while (done < want) {
        const pos = iOffset + done;
        const pgno = Math.floor(pos / pageSize) + 1;
        const inPage = pos - (pgno - 1) * pageSize;
        const n = Math.min(want - done, pageSize - inPage);
        const walOffset = pages.get(pgno);
        if (walOffset !== undefined) this.readRange(walFile, walOffset + inPage, n, pData, done);
        else this.readRange(entry.file, pos, n, pData, done);
        done += n;
      }
    }
    // Present WAL-mode files as rollback-journal mode: SQLite then never looks for a -wal or
    // -shm (the overlay above already contains the committed WAL content).
    if (iOffset <= 18 && iOffset + want > 19 && pData[18 - iOffset] === 2 && pData[19 - iOffset] === 2) {
      pData[18 - iOffset] = 1;
      pData[19 - iOffset] = 1;
    }
    return want;
  }

  /**
   * A single Blob equal to the database with its WAL applied (lazily composed from slices,
   * so exporting a large file costs no memory).
   */
  mergedBlob(name) {
    const entry = this.dbs.get(name);
    if (!entry.wal) return entry.file;
    const { pages, walFile, pageSize, dbPages } = entry.wal;
    const parts = [];
    let runStart = -1;
    for (let p = 1; p <= dbPages; p++) {
      const walOffset = pages.get(p);
      if (walOffset === undefined) {
        if (runStart < 0) runStart = p;
        continue;
      }
      if (runStart > 0) { parts.push(entry.file.slice((runStart - 1) * pageSize, (p - 1) * pageSize)); runStart = -1; }
      parts.push(walFile.slice(walOffset, walOffset + pageSize));
    }
    if (runStart > 0) parts.push(entry.file.slice((runStart - 1) * pageSize, dbPages * pageSize));
    return new Blob(parts, { type: 'application/vnd.sqlite3' });
  }

  // ---- VFS methods -------------------------------------------------------------------------

  xOpen(name, fileId, flags, pOutFlags) {
    const entry = name ? this.dbs.get(name) : null;
    if (entry && (flags & VFS.SQLITE_OPEN_MAIN_DB)) {
      this.handles.set(fileId, { kind: 'db', entry });
      pOutFlags.setInt32(0, (flags & ~VFS.SQLITE_OPEN_READWRITE) | VFS.SQLITE_OPEN_READONLY, true);
      return VFS.SQLITE_OK;
    }
    // Temp files (sorting, temp tables, statement journals) live in memory.
    if (!name || (flags & (VFS.SQLITE_OPEN_DELETEONCLOSE | VFS.SQLITE_OPEN_TEMP_DB | VFS.SQLITE_OPEN_TEMP_JOURNAL |
        VFS.SQLITE_OPEN_TRANSIENT_DB | VFS.SQLITE_OPEN_SUBJOURNAL))) {
      this.handles.set(fileId, { kind: 'mem', data: new Uint8Array(0), size: 0 });
      pOutFlags.setInt32(0, flags, true);
      return VFS.SQLITE_OK;
    }
    // Anything else (a -journal / -wal for a registered db, an unknown file) doesn't exist.
    return VFS.SQLITE_CANTOPEN;
  }

  xClose(fileId) {
    this.handles.delete(fileId);
    return VFS.SQLITE_OK;
  }

  xRead(fileId, pData, iOffset) {
    const h = this.handles.get(fileId);
    if (!h) return VFS.SQLITE_IOERR;
    try {
      let n;
      if (h.kind === 'db') {
        n = this.readDb(h.entry, pData, iOffset);
      } else {
        n = Math.max(0, Math.min(pData.length, h.size - iOffset));
        if (n) pData.set(h.data.subarray(iOffset, iOffset + n));
      }
      if (n < pData.length) {
        pData.fill(0, n);
        return VFS.SQLITE_IOERR_SHORT_READ;
      }
      return VFS.SQLITE_OK;
    } catch (e) {
      console.error('xRead', e);
      return VFS.SQLITE_IOERR;
    }
  }

  xWrite(fileId, pData, iOffset) {
    const h = this.handles.get(fileId);
    if (!h || h.kind !== 'mem') return VFS.SQLITE_READONLY;
    const end = iOffset + pData.length;
    if (end > h.data.length) {
      const grown = new Uint8Array(Math.max(end, h.data.length * 2));
      grown.set(h.data.subarray(0, h.size));
      h.data = grown;
    }
    h.data.set(pData, iOffset);
    h.size = Math.max(h.size, end);
    return VFS.SQLITE_OK;
  }

  xTruncate(fileId, iSize) {
    const h = this.handles.get(fileId);
    if (!h || h.kind !== 'mem') return VFS.SQLITE_READONLY;
    h.size = Math.min(h.size, iSize);
    return VFS.SQLITE_OK;
  }

  xFileSize(fileId, pSize64) {
    const h = this.handles.get(fileId);
    if (!h) return VFS.SQLITE_IOERR;
    const size = h.kind === 'db' ? this.dbSize(h.entry) : h.size;
    pSize64.setBigInt64(0, BigInt(size), true);
    return VFS.SQLITE_OK;
  }

  xDeviceCharacteristics(fileId) {
    const h = this.handles.get(fileId);
    // Immutable: SQLite skips locking and change detection for the snapshot.
    return h && h.kind === 'db' ? VFS.SQLITE_IOCAP_IMMUTABLE : 0;
  }

  xDelete(name, syncDir) {
    return VFS.SQLITE_OK;
  }

  xAccess(name, flags, pResOut) {
    pResOut.setInt32(0, this.dbs.has(name) ? 1 : 0, true);
    return VFS.SQLITE_OK;
  }
}

/** SQLite's WAL checksum over `len` bytes (a multiple of 8) starting at `off`. */
function checksum(buf, off, len, s0, s1, bigEndian) {
  const dv = new DataView(buf.buffer, buf.byteOffset + off, len);
  for (let i = 0; i < len; i += 8) {
    const x0 = dv.getUint32(i, !bigEndian);
    const x1 = dv.getUint32(i + 4, !bigEndian);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}
