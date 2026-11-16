var exec = require('cordova/exec');

var PRESET_FORMAT = 'hfps-db-inspector-presets';
var DEFAULT_MAX_ROWS = 1000;
/** Hard ceiling per query, whatever the caller asks for (same as the inspector's console). */
var MAX_ROWS_CEILING = 10000;

function promisify(action, args, success, error) {
    return new Promise(function (resolve, reject) {
        exec(function (result) {
            if (success) success(result);
            resolve(result);
        }, function (err) {
            if (error) error(err);
            reject(err);
        }, 'DbInspector', action, args);
    });
}

function fail(message, error) {
    if (error) error(message);
    return Promise.reject(message);
}

function parseMaybeJson(value, what) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        throw new Error(what + ' is not valid JSON: ' + e.message);
    }
}

function clampRows(value, fallback) {
    var n = Number(value);
    if (value == null || value === '' || !isFinite(n)) return fallback;
    return Math.min(MAX_ROWS_CEILING, Math.max(1, Math.floor(n)));
}

/**
 * Normalizes `queries` into [{name, sql, params, maxRows}]. Accepts an array of queries
 * (objects or bare SQL strings), a presets document ({format, version, presets: [...]}),
 * a single query object, or a JSON string of any of these.
 */
function normalizeQueries(queries) {
    queries = parseMaybeJson(queries, 'queries');
    var list = Array.isArray(queries) ? queries
        : queries && Array.isArray(queries.presets) ? queries.presets
        : queries && typeof queries === 'object' && queries.sql != null ? [queries]
        : null;
    if (!list || !list.length) {
        throw new Error('queries must be a non-empty array of {name, sql, params} or a presets document ({"format":"' + PRESET_FORMAT + '","presets":[…]}).');
    }
    return list.map(function (q, i) {
        if (typeof q === 'string') q = { sql: q };
        if (!q || typeof q !== 'object') q = {};
        return {
            name: q.name != null && String(q.name).trim() ? String(q.name) : 'query ' + (i + 1),
            sql: q.sql == null ? '' : String(q.sql),
            params: q.params,
            maxRows: q.maxRows
        };
    });
}

/**
 * Splits SQL into tokens, skipping over string literals, quoted identifiers and comments, so
 * parameters and statement separators are only recognized where SQLite would see them.
 * Parameter syntax matches the inspector's console: :name, @name, $name — plus ? and ?NNN.
 */
function tokenize(sql) {
    var out = [], i = 0, n = sql.length, m;
    while (i < n) {
        var c = sql[i], rest = sql.slice(i);
        if (c === '-' && sql[i + 1] === '-') {
            var e = sql.indexOf('\n', i); if (e < 0) e = n;
            out.push({ t: 'cmt', v: sql.slice(i, e) }); i = e;
        } else if (c === '/' && sql[i + 1] === '*') {
            var e2 = sql.indexOf('*/', i + 2); e2 = e2 < 0 ? n : e2 + 2;
            out.push({ t: 'cmt', v: sql.slice(i, e2) }); i = e2;
        } else if (c === "'" || c === '"' || c === '`' || c === '[') {
            var close = c === '[' ? ']' : c, j = i + 1;
            while (j < n) {
                if (sql[j] === close) { if (sql[j + 1] === close && close !== ']') { j += 2; continue; } j++; break; }
                j++;
            }
            out.push({ t: 'lit', v: sql.slice(i, j) }); i = j;
        } else if ((m = /^[:@$][A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
            out.push({ t: 'named', v: m[0] }); i += m[0].length;
        } else if ((m = /^\?(\d*)/.exec(rest))) {
            out.push({ t: 'pos', v: m[0] }); i += m[0].length;
        } else if (/\s/.test(c)) {
            out.push({ t: 'ws', v: c }); i++;
        } else {
            out.push({ t: 'other', v: c }); i++;
        }
    }
    return out;
}

/** JS value → value the native side binds: number, string or null. */
function bindValue(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') {
        if (!isFinite(v)) throw new Error('Parameter values must be finite numbers.');
        return v;
    }
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return JSON.stringify(v);
}

/**
 * Turns one query into {sql, args} for the native side. Named parameters are rewritten to
 * numbered ones (?1, ?2, …) bound with their real types, never inlined into the SQL.
 */
function prepareQuery(q, sharedParams) {
    var sql = q.sql.trim();
    if (!sql) throw new Error('Empty SQL.');
    var tokens = tokenize(sql);

    // Strip trailing semicolons/whitespace; anything after a separator is a second statement.
    var last = tokens.length - 1;
    while (last >= 0 && (tokens[last].t === 'ws' || tokens[last].t === 'cmt' || (tokens[last].t === 'other' && tokens[last].v === ';'))) last--;
    tokens = tokens.slice(0, last + 1);
    for (var k = 0; k < tokens.length; k++) {
        if (tokens[k].t === 'other' && tokens[k].v === ';') throw new Error('Only one SQL statement per query.');
    }

    var params = parseMaybeJson(q.params, 'params');
    if (Array.isArray(params)) {
        // Positional: SQL is passed as is and SQLite numbers the parameters itself.
        return { sql: tokens.map(function (t) { return t.v; }).join(''), args: params.map(bindValue) };
    }
    var values = {};
    [sharedParams, params].forEach(function (src) {
        if (src && typeof src === 'object' && !Array.isArray(src)) {
            Object.keys(src).forEach(function (key) {
                values[/^[:@$]/.test(key) ? key.slice(1) : key] = src[key];
            });
        }
    });
    var index = {}, args = [];
    var text = tokens.map(function (t) {
        if (t.t === 'pos') throw new Error('Positional "?" parameters need params as an array.');
        if (t.t !== 'named') return t.v;
        var key = t.v.slice(1);
        if (!index[key]) {
            if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error('Missing value for parameter ' + t.v + '.');
            args.push(bindValue(values[key]));
            index[key] = args.length;
        }
        return '?' + index[key];
    }).join('');
    return { sql: text, args: args };
}

/** Native rows are arrays; expose them as objects keyed by (de-duplicated) column name. */
function toObjects(columns, rows) {
    var seen = {};
    var keys = columns.map(function (c) {
        var key = c, n = 1;
        while (Object.prototype.hasOwnProperty.call(seen, key)) key = c + '_' + (++n);
        seen[key] = 1;
        return key;
    });
    return {
        columns: keys,
        rows: rows.map(function (r) {
            var o = {};
            for (var i = 0; i < keys.length; i++) o[keys[i]] = r[i];
            return o;
        })
    };
}

module.exports = {
    /**
     * Opens the full-screen, read-only database inspector.
     *
     * options (all optional):
     *   database: string     - file name (or id) of the database to select first
     *   presets:  Array|obj  - query presets to merge into the saved ones (same JSON format
     *                          the inspector exports), e.g. team-wide queries shipped with the app
     *   title:    string     - header title (default "DB Inspector")
     */
    open: function (options, success, error) {
        if (typeof options === 'function') {
            error = success;
            success = options;
            options = {};
        }
        return promisify('open', [options || {}], success, error);
    },

    /** Lists the SQLite files found in the app sandbox (no UI). */
    listDatabases: function (success, error) {
        return promisify('listDatabases', [], success, error);
    },

    /**
     * Runs a batch of read-only queries against one database, with no UI, and resolves with
     * the results as plain JSON. `options` may be an object or a JSON string:
     *
     *   database: string     - required: file name (e.g. "bg_sync.db") or id from listDatabases()
     *   queries:  Array|obj  - [{name?, sql, params?, maxRows?}] (or bare SQL strings), or a
     *                          presets document {format: "hfps-db-inspector-presets", presets: [...]}
     *   params:   obj        - optional named parameter values shared by every query
     *   maxRows:  number     - optional per-query row cap (default 1000, max 10000)
     *
     * Resolves to {database: {id, name}, startedAt, durationMs, results: [{name, sql, columns,
     * rows: [{col: value}], rowCount, truncated, durationMs, error}]}. A failing query only sets
     * its own `error`; the promise rejects only when the whole batch can't run.
     */
    runQueries: function (options, success, error) {
        var request, startedAt = new Date().toISOString();
        try {
            options = parseMaybeJson(options, 'options');
            if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('options must be an object or a JSON string.');
            if (typeof options.database !== 'string' || !options.database.trim()) throw new Error('options.database is required (file name or id).');
            var sharedParams = parseMaybeJson(options.params, 'params');
            var maxRows = clampRows(options.maxRows, DEFAULT_MAX_ROWS);
            request = {
                database: options.database.trim(),
                queries: normalizeQueries(options.queries).map(function (q) {
                    var item = { name: q.name, sql: q.sql, maxRows: clampRows(q.maxRows, maxRows) };
                    try {
                        var prepared = prepareQuery(q, sharedParams);
                        item.exec = prepared.sql;
                        item.args = prepared.args;
                    } catch (e) {
                        item.error = e.message;
                    }
                    return item;
                })
            };
        } catch (e) {
            return fail(e.message, error);
        }
        var nativeRequest = {
            database: request.database,
            queries: request.queries.map(function (q) {
                return q.error ? { error: q.error } : { sql: q.exec, args: q.args, maxRows: q.maxRows };
            })
        };
        return new Promise(function (resolve, reject) {
            exec(function (res) {
                var out = {
                    database: res.database,
                    startedAt: startedAt,
                    durationMs: res.durationMs,
                    results: request.queries.map(function (q, i) {
                        var r = (res.results && res.results[i]) || {};
                        var shaped = toObjects(r.columns || [], r.rows || []);
                        return {
                            name: q.name,
                            sql: q.sql,
                            columns: shaped.columns,
                            rows: shaped.rows,
                            rowCount: shaped.rows.length,
                            truncated: !!r.truncated,
                            durationMs: r.durationMs || 0,
                            error: q.error || r.error || null
                        };
                    })
                };
                if (success) success(out);
                resolve(out);
            }, function (err) {
                if (error) error(err);
                reject(err);
            }, 'DbInspector', 'runQueries', [nativeRequest]);
        });
    }
};
