#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Read-only SQLite introspection for every database file inside the app sandbox.
 * Mirrors src/android/DbInspectorEngine.java action-for-action; every method returns a
 * JSON-serializable object and raises an NSException with a user-facing reason on failure.
 * Not thread-safe except -interrupt: call everything else from one serial queue.
 */
@interface DbInspectorEngine : NSObject

- (NSArray *)listDatabases;
- (NSDictionary *)overview:(NSString *)dbId;
- (NSDictionary *)tableSchema:(NSString *)dbId table:(NSString *)table;
- (NSDictionary *)tableRows:(NSString *)dbId args:(NSDictionary *)args;
- (NSDictionary *)cell:(NSString *)dbId args:(NSDictionary *)args;
- (NSDictionary *)columnStats:(NSString *)dbId args:(NSDictionary *)args;
- (NSDictionary *)query:(NSString *)dbId args:(NSDictionary *)args;
- (NSDictionary *)dbInfo:(NSString *)dbId;
- (NSDictionary *)tableSizes:(NSString *)dbId;
- (NSArray *)integrityCheck:(NSString *)dbId;
/** Consistent single-file copy (WAL included) in the temp dir; the original is untouched. */
- (NSURL *)snapshot:(NSString *)dbId;
/** Safe to call from any thread: aborts the statement currently running, if any. */
- (void)interrupt;
- (void)closeAll;

@end

NS_ASSUME_NONNULL_END
