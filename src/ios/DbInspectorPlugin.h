#import <Cordova/CDVPlugin.h>

@interface DbInspectorPlugin : CDVPlugin

- (void)open:(CDVInvokedUrlCommand *)command;
- (void)listDatabases:(CDVInvokedUrlCommand *)command;
- (void)runQueries:(CDVInvokedUrlCommand *)command;

@end
