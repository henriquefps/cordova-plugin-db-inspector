#import <Cordova/CDVPlugin.h>

@interface DbInspectorPlugin : CDVPlugin

- (void)open:(CDVInvokedUrlCommand *)command;
- (void)listDatabases:(CDVInvokedUrlCommand *)command;

@end
