#import "DbInspectorEngine.h"
#import <sqlite3.h>
#import <stdatomic.h>

static const int kGridTextPreview = 500;
static const int kQueryTextPreview = 5000;
static const int kCellTextMax = 8000000;
static const int kCellBlobMax = 8 * 1024 * 1024;
static const int kMaxScanDepth = 5;

static void DbiFail(NSString *reason) {
  @throw [NSException exceptionWithName:@"DbInspectorError" reason:reason userInfo:nil];
}

static NSString *DbiQ(NSString *identifier) {
  return [NSString stringWithFormat:@"\"%@\"", [identifier stringByReplacingOccurrencesOfString:@"\"" withString:@"\"\""]];
}

@interface DbInspectorEngine ()
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *knownFiles;
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSValue *> *connections;
@end

@implementation DbInspectorEngine {
  _Atomic(sqlite3 *) _running;
}

- (instancetype)init {
  if ((self = [super init])) {
    _knownFiles = [NSMutableDictionary dictionary];
    _connections = [NSMutableDictionary dictionary];
    atomic_store(&_running, NULL);
  }
  return self;
}

- (void)dealloc {
  [self closeAll];
}

#pragma mark - Discovery

+ (BOOL)hasSqliteHeader:(NSString *)path {
  NSFileHandle *h = [NSFileHandle fileHandleForReadingAtPath:path];
  if (!h) return NO;
  NSData *d = [h readDataOfLength:16];
  [h closeFile];
  return d.length == 16 && memcmp(d.bytes, "SQLite format 3\0", 16) == 0;
}

+ (BOOL)isSideFile:(NSString *)name {
  return [name hasSuffix:@"-wal"] || [name hasSuffix:@"-shm"] || [name hasSuffix:@"-journal"] || [name containsString:@"-mj"];
}

+ (BOOL)hasDbExtension:(NSString *)name {
  NSString *ext = name.pathExtension.lowercaseString;
  return [@[@"db", @"sqlite", @"sqlite3", @"db3"] containsObject:ext];
}

- (NSArray *)listDatabases {
  [self.knownFiles removeAllObjects];
  NSString *home = NSHomeDirectory();
  NSFileManager *fm = [NSFileManager defaultManager];
  // Directories where every file is a database by convention (so a file without the
  // plaintext header there is reported as encrypted rather than ignored).
  NSArray *dbDirs = @[@"Library/LocalDatabase", @"Documents/databases", @"Library/databases"];
  NSSet *skipped = [NSSet setWithArray:@[@"Caches", @"WebKit", @"Cookies", @"Saved Application State", @"SplashBoard", @"Preferences", @"Snapshots"]];

  NSMutableArray<NSString *> *found = [NSMutableArray array];
  NSMutableArray<NSArray *> *stack = [NSMutableArray arrayWithObjects:@[[home stringByAppendingPathComponent:@"Documents"], @0],
                                      @[[home stringByAppendingPathComponent:@"Library"], @0], nil];
  while (stack.count) {
    NSArray *top = stack.lastObject;
    [stack removeLastObject];
    NSString *dir = top[0];
    int depth = [top[1] intValue];
    NSArray *children = [[fm contentsOfDirectoryAtPath:dir error:nil] sortedArrayUsingSelector:@selector(compare:)];
    NSString *rel = [dir hasPrefix:home] ? [dir substringFromIndex:MIN(dir.length, home.length + 1)] : dir;
    BOOL conventional = [dbDirs containsObject:rel];
    for (NSString *name in children.reverseObjectEnumerator) {
      NSString *path = [dir stringByAppendingPathComponent:name];
      BOOL isDir = NO;
      if (![fm fileExistsAtPath:path isDirectory:&isDir]) continue;
      if (isDir) {
        if (depth < kMaxScanDepth && ![skipped containsObject:name]) [stack addObject:@[path, @(depth + 1)]];
        continue;
      }
      if ([DbInspectorEngine isSideFile:name]) continue;
      unsigned long long size = [[fm attributesOfItemAtPath:path error:nil] fileSize];
      if ([DbInspectorEngine hasSqliteHeader:path] || (conventional && size > 0) || (size >= 512 && [DbInspectorEngine hasDbExtension:name] && conventional)) {
        [found addObject:path];
      }
    }
  }

  NSMutableArray *result = [NSMutableArray array];
  for (NSString *path in [found sortedArrayUsingSelector:@selector(compare:)]) {
    NSString *dbId = [path substringFromIndex:home.length + 1];
    self.knownFiles[dbId] = path;
    NSDictionary *attrs = [fm attributesOfItemAtPath:path error:nil];
    unsigned long long size = attrs.fileSize;
    [result addObject:@{
      @"id": dbId,
      @"name": path.lastPathComponent,
      @"dir": [dbId stringByDeletingLastPathComponent],
      @"size": @(size),
      @"walSize": @([self sideSize:path suffix:@"-wal"]),
      @"journalSize": @([self sideSize:path suffix:@"-journal"]),
      @"modified": @((long long)(attrs.fileModificationDate.timeIntervalSince1970 * 1000)),
      @"encrypted": @((BOOL)(size > 0 && ![DbInspectorEngine hasSqliteHeader:path])),
      @"empty": @((BOOL)(size == 0))
    }];
  }
  return result;
}

- (unsigned long long)sideSize:(NSString *)path suffix:(NSString *)suffix {
  return [[[NSFileManager defaultManager] attributesOfItemAtPath:[path stringByAppendingString:suffix] error:nil] fileSize];
}

- (NSString *)resolve:(NSString *)dbId {
  NSString *path = self.knownFiles[dbId];
  if (!path) {
    [self listDatabases];
    path = self.knownFiles[dbId];
  }
  if (!path) DbiFail([NSString stringWithFormat:@"Unknown database: %@", dbId]);
  return path;
}

- (sqlite3 *)db:(NSString *)dbId {
  NSValue *existing = self.connections[dbId];
  if (existing) return existing.pointerValue;
  NSString *path = [self resolve:dbId];
  unsigned long long size = [[[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil] fileSize];
  if (size > 0 && ![DbInspectorEngine hasSqliteHeader:path]) {
    DbiFail(@"This database is encrypted (no plaintext SQLite header). Encrypted databases are not supported.");
  }
  sqlite3 *db = NULL;
  if (sqlite3_open_v2(path.fileSystemRepresentation, &db, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
    NSString *msg = db ? @(sqlite3_errmsg(db)) : @"Cannot open database";
    if (db) sqlite3_close(db);
    DbiFail(msg);
  }
  self.connections[dbId] = [NSValue valueWithPointer:db];
  return db;
}

- (void)closeAll {
  for (NSValue *v in self.connections.allValues) sqlite3_close_v2(v.pointerValue);
  [self.connections removeAllObjects];
}

- (void)interrupt {
  sqlite3 *db = atomic_load(&_running);
  if (db) sqlite3_interrupt(db);
}

#pragma mark - Low-level helpers

- (sqlite3_stmt *)prepare:(sqlite3 *)db sql:(NSString *)sql args:(NSArray *)args {
  sqlite3_stmt *stmt = NULL;
  if (sqlite3_prepare_v2(db, sql.UTF8String, -1, &stmt, NULL) != SQLITE_OK) {
    NSString *msg = @(sqlite3_errmsg(db));
    sqlite3_finalize(stmt);
    DbiFail(msg);
  }
  for (NSUInteger i = 0; i < args.count; i++) {
    id a = args[i];
    if ([a isKindOfClass:[NSNumber class]]) sqlite3_bind_int64(stmt, (int)i + 1, [a longLongValue]);
    else sqlite3_bind_text(stmt, (int)i + 1, [[a description] UTF8String], -1, SQLITE_TRANSIENT);
  }
  return stmt;
}

- (void)stepFailed:(sqlite3 *)db stmt:(sqlite3_stmt *)stmt rc:(int)rc {
  NSString *msg = rc == SQLITE_INTERRUPT ? @"Query cancelled." : @(sqlite3_errmsg(db));
  sqlite3_finalize(stmt);
  DbiFail(msg);
}

static NSString *DbiText(sqlite3_stmt *stmt, int i) {
  const unsigned char *t = sqlite3_column_text(stmt, i);
  int n = sqlite3_column_bytes(stmt, i);
  if (!t) return @"";
  NSString *s = [[NSString alloc] initWithBytes:t length:n encoding:NSUTF8StringEncoding];
  return s ?: [[NSString alloc] initWithBytes:t length:n encoding:NSISOLatin1StringEncoding];
}

static id DbiNumber(sqlite3_stmt *stmt, int i) {
  if (sqlite3_column_type(stmt, i) == SQLITE_INTEGER) {
    sqlite3_int64 v = sqlite3_column_int64(stmt, i);
    // Beyond 2^53 a JS number would silently lose precision.
    return llabs(v) > 9007199254740991LL ? [NSString stringWithFormat:@"%lld", v] : @(v);
  }
  double d = sqlite3_column_double(stmt, i);
  return isnan(d) || isinf(d) ? [NSString stringWithFormat:@"%f", d] : @(d);
}

/** Small metadata queries only (pragmas, sqlite_master). */
- (NSArray<NSMutableDictionary *> *)rows:(sqlite3 *)db sql:(NSString *)sql args:(NSArray *)args {
  sqlite3_stmt *stmt = [self prepare:db sql:sql args:args];
  NSMutableArray *out = [NSMutableArray array];
  int n = sqlite3_column_count(stmt);
  int rc;
  while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
    NSMutableDictionary *row = [NSMutableDictionary dictionary];
    for (int i = 0; i < n; i++) {
      NSString *name = @(sqlite3_column_name(stmt, i));
      switch (sqlite3_column_type(stmt, i)) {
        case SQLITE_NULL: row[name] = [NSNull null]; break;
        case SQLITE_INTEGER: case SQLITE_FLOAT: row[name] = DbiNumber(stmt, i); break;
        case SQLITE_BLOB: row[name] = @"<blob>"; break;
        default: row[name] = DbiText(stmt, i);
      }
    }
    [out addObject:row];
  }
  if (rc != SQLITE_DONE) [self stepFailed:db stmt:stmt rc:rc];
  sqlite3_finalize(stmt);
  return out;
}

- (long long)scalar:(sqlite3 *)db sql:(NSString *)sql args:(NSArray *)args {
  sqlite3_stmt *stmt = [self prepare:db sql:sql args:args];
  int rc = sqlite3_step(stmt);
  if (rc != SQLITE_ROW && rc != SQLITE_DONE) [self stepFailed:db stmt:stmt rc:rc];
  long long v = rc == SQLITE_ROW ? sqlite3_column_int64(stmt, 0) : 0;
  sqlite3_finalize(stmt);
  return v;
}

- (NSDictionary *)firstRow:(sqlite3 *)db sql:(NSString *)sql args:(NSArray *)args {
  return [self rows:db sql:sql args:args].firstObject;
}

+ (NSString *)sniffMime:(const unsigned char *)b length:(int)n {
  if (!b || n < 4) return nil;
  if (b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return @"image/jpeg";
  if (b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return @"image/png";
  if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return @"image/gif";
  if (b[0] == 'B' && b[1] == 'M') return @"image/bmp";
  if (n >= 12 && memcmp(b, "RIFF", 4) == 0 && memcmp(b + 8, "WEBP", 4) == 0) return @"image/webp";
  if (n >= 12 && memcmp(b + 4, "ftyp", 4) == 0) return (memcmp(b + 8, "hei", 3) == 0 || memcmp(b + 8, "mif", 3) == 0) ? @"image/heic" : @"video/mp4";
  if (memcmp(b, "%PDF", 4) == 0) return @"application/pdf";
  if (b[0] == 'P' && b[1] == 'K' && b[2] == 3 && b[3] == 4) return @"application/zip";
  if (b[0] == 0x1F && b[1] == 0x8B) return @"application/gzip";
  if (memcmp(b, "SQLi", 4) == 0) return @"application/x-sqlite3";
  return nil;
}

+ (NSString *)hex:(const unsigned char *)b length:(int)n max:(int)max {
  NSMutableString *s = [NSMutableString string];
  for (int i = 0; i < MIN(n, max); i++) [s appendFormat:@"%02x", b[i]];
  return s;
}

/** Same wire format as Android: null | number | string | {"$t":"text"|"blob",...}. */
- (id)encodeCell:(sqlite3_stmt *)stmt index:(int)i lengthIndex:(int)li preview:(int)preview {
  switch (sqlite3_column_type(stmt, i)) {
    case SQLITE_NULL: return [NSNull null];
    case SQLITE_INTEGER: case SQLITE_FLOAT: return DbiNumber(stmt, i);
    case SQLITE_BLOB: {
      const unsigned char *b = sqlite3_column_blob(stmt, i);
      int n = sqlite3_column_bytes(stmt, i);
      long long len = li >= 0 ? sqlite3_column_int64(stmt, li) : n;
      NSMutableDictionary *o = [@{@"$t": @"blob", @"len": @(len), @"hex": [DbInspectorEngine hex:b length:n max:16]} mutableCopy];
      NSString *mime = [DbInspectorEngine sniffMime:b length:n];
      o[@"mime"] = mime ?: [NSNull null];
      return o;
    }
    default: {
      NSString *s = DbiText(stmt, i);
      long long len = li >= 0 ? sqlite3_column_int64(stmt, li) : (long long)s.length;
      if (li < 0 && s.length > (NSUInteger)preview) s = [s substringToIndex:[s rangeOfComposedCharacterSequenceAtIndex:preview].location];
      if (len > (long long)s.length) return @{@"$t": @"text", @"v": s, @"len": @(len)};
      return s;
    }
  }
}

#pragma mark - Schema

+ (BOOL)isSystemTable:(NSString *)name {
  NSString *u = name.uppercaseString;
  return [u hasPrefix:@"SQLITE_"] || [u isEqualToString:@"ANDROID_METADATA"] || [u hasPrefix:@"OSSYS_"] || [u hasPrefix:@"BACKUP_OSSYS_"];
}

/** OutSystems keeps a map of logical entity names -> physical tables in OSSYS_ENTITY. */
- (NSDictionary<NSString *, NSDictionary *> *)outSystemsEntities:(sqlite3 *)db {
  NSMutableDictionary *map = [NSMutableDictionary dictionary];
  @try {
    if ([self scalar:db sql:@"SELECT count(*) FROM sqlite_master WHERE type='table' AND name='OSSYS_ENTITY'" args:nil] == 0) return map;
    for (NSDictionary *r in [self rows:db sql:@"SELECT Name AS name, Physical_Table_name AS physical, Extra_Info AS extra FROM OSSYS_ENTITY" args:nil]) {
      NSString *physical = [r[@"physical"] isKindOfClass:[NSString class]] ? r[@"physical"] : nil;
      if (physical.length) map[physical.uppercaseString] = r;
    }
  } @catch (NSException *e) {
    // Not an OutSystems database, or an unexpected OSSYS_ENTITY shape.
  }
  return map;
}

- (NSDictionary *)overview:(NSString *)dbId {
  sqlite3 *db = [self db:dbId];
  NSDictionary *entities = [self outSystemsEntities:db];
  NSArray *objects = [self rows:db sql:@"SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name COLLATE NOCASE" args:nil];
  NSMutableDictionary<NSString *, NSNumber *> *indexCounts = [NSMutableDictionary dictionary];
  int indexCount = 0, triggerCount = 0;
  for (NSDictionary *o in objects) {
    if ([o[@"type"] isEqual:@"index"]) {
      indexCount++;
      NSString *t = o[@"tbl_name"];
      indexCounts[t] = @(indexCounts[t].intValue + 1);
    } else if ([o[@"type"] isEqual:@"trigger"]) {
      triggerCount++;
    }
  }
  NSMutableArray *tables = [NSMutableArray array];
  for (NSDictionary *o in objects) {
    NSString *type = o[@"type"];
    if (![type isEqual:@"table"] && ![type isEqual:@"view"]) continue;
    NSString *name = o[@"name"];
    NSString *sql = [o[@"sql"] isKindOfClass:[NSString class]] ? [o[@"sql"] uppercaseString] : @"";
    BOOL virtual = [sql hasPrefix:@"CREATE VIRTUAL TABLE"];
    NSMutableDictionary *t = [@{
      @"name": name, @"type": type, @"virtual": @(virtual),
      @"withoutRowid": @([sql containsString:@"WITHOUT ROWID"]),
      @"system": @([DbInspectorEngine isSystemTable:name]),
      @"indexes": indexCounts[name] ?: @0
    } mutableCopy];
    NSDictionary *entity = entities[name.uppercaseString];
    if (entity) t[@"logicalName"] = entity[@"name"];
    if ([type isEqual:@"table"] && !virtual) {
      @try {
        t[@"rows"] = @([self scalar:db sql:[@"SELECT count(*) FROM " stringByAppendingString:DbiQ(name)] args:nil]);
      } @catch (NSException *e) {
        t[@"rows"] = [NSNull null];
      }
    }
    [tables addObject:t];
  }
  return @{@"tables": tables, @"indexCount": @(indexCount), @"triggerCount": @(triggerCount), @"outsystems": @((BOOL)(entities.count > 0))};
}

- (NSDictionary *)tableSchema:(NSString *)dbId table:(NSString *)table {
  sqlite3 *db = [self db:dbId];
  NSDictionary *master = [self firstRow:db sql:@"SELECT type, sql FROM sqlite_master WHERE name = ?" args:@[table]];
  if (!master) DbiFail([@"Unknown table: " stringByAppendingString:table]);
  NSArray *columns;
  @try {
    columns = [self rows:db sql:[NSString stringWithFormat:@"PRAGMA table_xinfo(%@)", DbiQ(table)] args:nil];
  } @catch (NSException *e) {
    columns = [self rows:db sql:[NSString stringWithFormat:@"PRAGMA table_info(%@)", DbiQ(table)] args:nil];
  }
  NSMutableArray *indexes = [NSMutableArray array];
  for (NSMutableDictionary *idx in [self rows:db sql:[NSString stringWithFormat:@"PRAGMA index_list(%@)", DbiQ(table)] args:nil]) {
    NSMutableArray *cols = [NSMutableArray array];
    for (NSDictionary *c in [self rows:db sql:[NSString stringWithFormat:@"PRAGMA index_info(%@)", DbiQ(idx[@"name"])] args:nil]) {
      [cols addObject:[c[@"name"] isKindOfClass:[NSString class]] ? c[@"name"] : @"<expr>"];
    }
    NSDictionary *s = [self firstRow:db sql:@"SELECT sql FROM sqlite_master WHERE type='index' AND name = ?" args:@[idx[@"name"]]];
    idx[@"columns"] = cols;
    idx[@"sql"] = s[@"sql"] ?: [NSNull null];
    [indexes addObject:idx];
  }
  NSString *sql = [master[@"sql"] isKindOfClass:[NSString class]] ? master[@"sql"] : @"";
  NSString *type = master[@"type"];
  NSMutableDictionary *result = [@{
    @"name": table, @"type": type, @"sql": sql,
    @"rowid": @([type isEqual:@"table"] && ![sql.uppercaseString containsString:@"WITHOUT ROWID"]),
    @"columns": columns, @"indexes": indexes,
    @"foreignKeys": [self rows:db sql:[NSString stringWithFormat:@"PRAGMA foreign_key_list(%@)", DbiQ(table)] args:nil],
    @"triggers": [self rows:db sql:@"SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?" args:@[table]]
  } mutableCopy];
  NSDictionary *entity = [self outSystemsEntities:db][table.uppercaseString];
  if (entity) {
    result[@"logicalName"] = entity[@"name"];
    NSString *extra = [entity[@"extra"] isKindOfClass:[NSString class]] ? entity[@"extra"] : nil;
    NSData *data = [extra dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if ([parsed isKindOfClass:[NSDictionary class]] && [parsed[@"attrs"] isKindOfClass:[NSDictionary class]]) result[@"outsystemsAttrs"] = parsed[@"attrs"];
  }
  return result;
}

#pragma mark - Data

- (NSDictionary *)tableRows:(NSString *)dbId args:(NSDictionary *)args {
  sqlite3 *db = [self db:dbId];
  NSString *table = args[@"table"];
  if (![table isKindOfClass:[NSString class]]) DbiFail(@"Missing table");
  int offset = MAX(0, [args[@"offset"] intValue]);
  int limit = MIN(500, MAX(1, args[@"limit"] ? [args[@"limit"] intValue] : 50));
  NSString *sortColumn = [args[@"sortColumn"] isKindOfClass:[NSString class]] ? args[@"sortColumn"] : @"";
  BOOL desc = [[args[@"sortDir"] description].lowercaseString isEqual:@"desc"];
  NSString *search = [args[@"search"] isKindOfClass:[NSString class]] ? [args[@"search"] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet] : @"";

  NSDictionary *master = [self firstRow:db sql:@"SELECT type, sql FROM sqlite_master WHERE name = ?" args:@[table]];
  if (!master) DbiFail([@"Unknown table: " stringByAppendingString:table]);
  NSString *msql = [master[@"sql"] isKindOfClass:[NSString class]] ? master[@"sql"] : @"";
  BOOL hasRowid = [master[@"type"] isEqual:@"table"] && ![msql.uppercaseString containsString:@"WITHOUT ROWID"];

  NSMutableArray<NSString *> *names = [NSMutableArray array];
  NSMutableArray<NSString *> *searchable = [NSMutableArray array];
  for (NSDictionary *c in [self rows:db sql:[NSString stringWithFormat:@"PRAGMA table_info(%@)", DbiQ(table)] args:nil]) {
    [names addObject:c[@"name"]];
    NSString *ctype = [c[@"type"] isKindOfClass:[NSString class]] ? c[@"type"] : @"";
    if (![ctype.uppercaseString containsString:@"BLOB"]) [searchable addObject:c[@"name"]];
  }

  // Two projected columns per real column: a display value that never carries a full blob
  // or a huge string, plus its real length.
  NSMutableString *select = [NSMutableString stringWithString:hasRowid ? @"SELECT rowid" : @"SELECT NULL"];
  for (NSString *n in names) {
    NSString *c = DbiQ(n);
    [select appendFormat:@", CASE WHEN typeof(%1$@)='text' AND length(%1$@)>%2$d THEN substr(%1$@,1,%2$d) WHEN typeof(%1$@)='blob' THEN substr(%1$@,1,16) ELSE %1$@ END, length(%1$@)", c, kGridTextPreview];
  }
  NSString *from = [@" FROM " stringByAppendingString:DbiQ(table)];
  NSString *where = @"";
  NSArray *whereArgs = @[];
  if (search.length && searchable.count) {
    NSMutableArray *parts = [NSMutableArray array];
    for (NSString *n in searchable) [parts addObject:[DbiQ(n) stringByAppendingString:@" LIKE ?1"]];
    where = [NSString stringWithFormat:@" WHERE (%@)", [parts componentsJoinedByString:@" OR "]];
    whereArgs = @[[NSString stringWithFormat:@"%%%@%%", search]];
  }
  NSString *order = sortColumn.length && [names containsObject:sortColumn]
      ? [NSString stringWithFormat:@" ORDER BY %@ %@", DbiQ(sortColumn), desc ? @"DESC" : @"ASC"] : @"";

  long long total = [self scalar:db sql:[NSString stringWithFormat:@"SELECT count(*)%@%@", from, where] args:whereArgs];
  NSString *sql = [NSString stringWithFormat:@"%@%@%@%@ LIMIT %d OFFSET %d", select, from, where, order, limit, offset];
  sqlite3_stmt *stmt = [self prepare:db sql:sql args:whereArgs];
  NSMutableArray *rows = [NSMutableArray array];
  NSMutableArray *rowids = [NSMutableArray array];
  int rc;
  while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
    [rowids addObject:hasRowid ? @(sqlite3_column_int64(stmt, 0)) : [NSNull null]];
    NSMutableArray *row = [NSMutableArray arrayWithCapacity:names.count];
    for (int i = 0; i < (int)names.count; i++) [row addObject:[self encodeCell:stmt index:1 + i * 2 lengthIndex:2 + i * 2 preview:kGridTextPreview]];
    [rows addObject:row];
  }
  if (rc != SQLITE_DONE) [self stepFailed:db stmt:stmt rc:rc];
  sqlite3_finalize(stmt);
  return @{@"columns": names, @"rowids": hasRowid ? rowids : [NSNull null], @"rows": rows,
           @"total": @(total), @"offset": @(offset), @"limit": @(limit)};
}

- (NSDictionary *)cell:(NSString *)dbId args:(NSDictionary *)args {
  sqlite3 *db = [self db:dbId];
  NSString *c = DbiQ([args[@"column"] description]);
  NSString *sql = [NSString stringWithFormat:@"SELECT typeof(%1$@), length(%1$@), CASE WHEN typeof(%1$@)='text' THEN substr(%1$@,1,%2$d) WHEN typeof(%1$@)='blob' THEN substr(%1$@,1,%3$d) ELSE %1$@ END FROM %4$@ WHERE rowid = ?",
                   c, kCellTextMax, kCellBlobMax, DbiQ([args[@"table"] description])];
  sqlite3_stmt *stmt = [self prepare:db sql:sql args:@[@([args[@"rowid"] longLongValue])]];
  int rc = sqlite3_step(stmt);
  if (rc == SQLITE_DONE) { sqlite3_finalize(stmt); DbiFail(@"Row not found"); }
  if (rc != SQLITE_ROW) [self stepFailed:db stmt:stmt rc:rc];
  NSString *type = DbiText(stmt, 0);
  long long len = sqlite3_column_int64(stmt, 1);
  NSMutableDictionary *out = [@{@"type": type, @"len": @(len)} mutableCopy];
  switch (sqlite3_column_type(stmt, 2)) {
    case SQLITE_BLOB: {
      const unsigned char *b = sqlite3_column_blob(stmt, 2);
      int n = sqlite3_column_bytes(stmt, 2);
      NSData *data = [NSData dataWithBytes:b length:n];
      out[@"base64"] = [data base64EncodedStringWithOptions:0];
      out[@"mime"] = [DbInspectorEngine sniffMime:b length:n] ?: [NSNull null];
      out[@"truncated"] = @((BOOL)(n < len));
      break;
    }
    case SQLITE_TEXT: {
      NSString *s = DbiText(stmt, 2);
      out[@"text"] = s;
      out[@"truncated"] = @((BOOL)((long long)s.length < len));
      break;
    }
    case SQLITE_NULL: out[@"value"] = [NSNull null]; break;
    default: out[@"value"] = DbiNumber(stmt, 2);
  }
  sqlite3_finalize(stmt);
  return out;
}

- (NSDictionary *)columnStats:(NSString *)dbId args:(NSDictionary *)args {
  sqlite3 *db = [self db:dbId];
  NSString *t = DbiQ([args[@"table"] description]);
  NSString *c = DbiQ([args[@"column"] description]);
  NSArray *types = [self rows:db sql:[NSString stringWithFormat:@"SELECT typeof(%@) AS type, count(*) AS count FROM %@ GROUP BY 1 ORDER BY 2 DESC", c, t] args:nil];
  long long blobs = 0;
  for (NSDictionary *r in types) if ([r[@"type"] isEqual:@"blob"]) blobs = [r[@"count"] longLongValue];
  NSString *nonBlob = [NSString stringWithFormat:@"CASE WHEN typeof(%1$@)='text' THEN substr(%1$@,1,200) WHEN typeof(%1$@)<>'blob' THEN %1$@ END", c];
  NSString *sql = [NSString stringWithFormat:@"SELECT count(*) AS total, count(%1$@) AS nonNull, min(%2$@) AS min, max(%2$@) AS max, "
                   "avg(CASE WHEN typeof(%1$@) IN ('integer','real') THEN %1$@ END) AS avg, "
                   "min(length(%1$@)) AS minLength, max(length(%1$@)) AS maxLength, sum(length(%1$@)) AS totalLength FROM %3$@", c, nonBlob, t];
  NSMutableDictionary *stats = [[self firstRow:db sql:sql args:nil] mutableCopy] ?: [NSMutableDictionary dictionary];
  stats[@"types"] = types;
  // Grouping on a blob column would read every blob; skip distinct/top values there.
  if (blobs == 0) {
    stats[@"distinct"] = @([self scalar:db sql:[NSString stringWithFormat:@"SELECT count(DISTINCT %@) FROM %@", c, t] args:nil]);
    stats[@"top"] = [self rows:db sql:[NSString stringWithFormat:@"SELECT %@ AS value, count(*) AS count FROM %@ GROUP BY %@ ORDER BY 2 DESC LIMIT 10", nonBlob, t, c] args:nil];
  } else {
    stats[@"distinct"] = [NSNull null];
    stats[@"top"] = @[];
  }
  return stats;
}

- (NSDictionary *)query:(NSString *)dbId args:(NSDictionary *)args {
  sqlite3 *db = [self db:dbId];
  NSString *sql = [[args[@"sql"] description] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  while ([sql hasSuffix:@";"]) sql = [[sql substringToIndex:sql.length - 1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  int maxRows = MIN(10000, MAX(1, args[@"maxRows"] ? [args[@"maxRows"] intValue] : 1000));

  CFAbsoluteTime start = CFAbsoluteTimeGetCurrent();
  atomic_store(&_running, db);
  @try {
    sqlite3_stmt *stmt = [self prepare:db sql:sql args:nil];
    int n = sqlite3_column_count(stmt);
    NSMutableArray *cols = [NSMutableArray arrayWithCapacity:n];
    for (int i = 0; i < n; i++) [cols addObject:@(sqlite3_column_name(stmt, i) ?: "?")];
    NSMutableArray *rows = [NSMutableArray array];
    BOOL hasMore = NO;
    int rc;
    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
      if ((int)rows.count >= maxRows) { hasMore = YES; break; }
      NSMutableArray *row = [NSMutableArray arrayWithCapacity:n];
      for (int i = 0; i < n; i++) [row addObject:[self encodeCell:stmt index:i lengthIndex:-1 preview:kQueryTextPreview]];
      [rows addObject:row];
    }
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) [self stepFailed:db stmt:stmt rc:rc];
    sqlite3_finalize(stmt);
    return @{@"columns": cols, @"rows": rows, @"hasMore": @(hasMore), @"timeMs": @((CFAbsoluteTimeGetCurrent() - start) * 1000.0)};
  } @finally {
    atomic_store(&_running, NULL);
  }
}

#pragma mark - Database-level info

- (NSDictionary *)dbInfo:(NSString *)dbId {
  sqlite3 *db = [self db:dbId];
  NSString *path = [self resolve:dbId];
  NSMutableDictionary *pragmas = [NSMutableDictionary dictionary];
  for (NSString *p in @[@"page_size", @"page_count", @"freelist_count", @"journal_mode", @"user_version", @"application_id", @"encoding", @"auto_vacuum", @"schema_version"]) {
    @try {
      NSDictionary *r = [self firstRow:db sql:[@"PRAGMA " stringByAppendingString:p] args:nil];
      pragmas[p] = r.allValues.firstObject ?: [NSNull null];
    } @catch (NSException *e) {
      pragmas[p] = [NSNull null];
    }
  }
  NSMutableDictionary *counts = [NSMutableDictionary dictionary];
  for (NSDictionary *r in [self rows:db sql:@"SELECT type, count(*) AS n FROM sqlite_master GROUP BY type" args:nil]) counts[r[@"type"]] = r[@"n"];
  NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
  return @{
    @"path": path,
    @"size": @(attrs.fileSize),
    @"walSize": @([self sideSize:path suffix:@"-wal"]),
    @"shmSize": @([self sideSize:path suffix:@"-shm"]),
    @"journalSize": @([self sideSize:path suffix:@"-journal"]),
    @"modified": @((long long)(attrs.fileModificationDate.timeIntervalSince1970 * 1000)),
    @"sqliteVersion": @(sqlite3_libversion()),
    @"pragmas": pragmas,
    @"objects": counts
  };
}

- (NSDictionary *)tableSizes:(NSString *)dbId {
  sqlite3 *db = [self db:dbId];
  NSMutableDictionary *sizes = [NSMutableDictionary dictionary];
  @try {
    for (NSDictionary *r in [self rows:db sql:@"SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name" args:nil]) sizes[r[@"name"]] = r[@"bytes"];
    return @{@"method": @"dbstat", @"sizes": sizes};
  } @catch (NSException *e) {
    // dbstat isn't compiled into every SQLite build.
  }
  for (NSDictionary *t in [self rows:db sql:@"SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE 'CREATE VIRTUAL%'" args:nil]) {
    @try {
      NSMutableString *expr = [NSMutableString stringWithString:@"0"];
      for (NSDictionary *c in [self rows:db sql:[NSString stringWithFormat:@"PRAGMA table_info(%@)", DbiQ(t[@"name"])] args:nil]) {
        // length() on a blob reads only the record header, not the blob pages.
        [expr appendFormat:@"+ifnull(length(%@),0)", DbiQ(c[@"name"])];
      }
      sizes[t[@"name"]] = @([self scalar:db sql:[NSString stringWithFormat:@"SELECT ifnull(sum(%@),0) FROM %@", expr, DbiQ(t[@"name"])] args:nil]);
    } @catch (NSException *e) { }
  }
  return @{@"method": @"estimate", @"sizes": sizes};
}

- (NSArray *)integrityCheck:(NSString *)dbId {
  NSMutableArray *out = [NSMutableArray array];
  for (NSDictionary *r in [self rows:[self db:dbId] sql:@"PRAGMA quick_check(50)" args:nil]) [out addObject:r.allValues.firstObject ?: @""];
  return out;
}

- (NSURL *)snapshot:(NSString *)dbId {
  sqlite3 *db = [self db:dbId];
  NSString *src = [self resolve:dbId];
  NSString *dir = [NSTemporaryDirectory() stringByAppendingPathComponent:@"db-inspector-export"];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *name = src.lastPathComponent;
  if (![name.pathExtension isEqual:@"db"]) name = [name stringByAppendingString:@".db"];
  NSString *dst = [dir stringByAppendingPathComponent:name];
  [[NSFileManager defaultManager] removeItemAtPath:dst error:nil];
  // VACUUM INTO works on a read-only connection and folds in pending WAL content.
  sqlite3_stmt *stmt = [self prepare:db sql:@"VACUUM INTO ?" args:@[dst]];
  int rc = sqlite3_step(stmt);
  if (rc != SQLITE_DONE) [self stepFailed:db stmt:stmt rc:rc];
  sqlite3_finalize(stmt);
  return [NSURL fileURLWithPath:dst];
}

@end
