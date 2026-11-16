#import "DbInspectorPlugin.h"
#import "DbInspectorEngine.h"
#import "DbInspectorViewController.h"

@implementation DbInspectorPlugin

- (void)open:(CDVInvokedUrlCommand *)command {
  NSDictionary *options = [command.arguments.firstObject isKindOfClass:[NSDictionary class]] ? command.arguments.firstObject : @{};
  dispatch_async(dispatch_get_main_queue(), ^{
    DbInspectorViewController *vc = [[DbInspectorViewController alloc] initWithOptions:options];
    vc.modalPresentationStyle = UIModalPresentationFullScreen;
    [self.viewController presentViewController:vc animated:YES completion:nil];
    [self.commandDelegate sendPluginResult:[CDVPluginResult resultWithStatus:CDVCommandStatus_OK] callbackId:command.callbackId];
  });
}

- (void)listDatabases:(CDVInvokedUrlCommand *)command {
  [self.commandDelegate runInBackground:^{
    CDVPluginResult *result;
    @try {
      result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsArray:[[DbInspectorEngine new] listDatabases]];
    } @catch (NSException *e) {
      result = [CDVPluginResult resultWithStatus:CDVCommandStatus_ERROR messageAsString:e.reason ?: @"Failed to list databases"];
    }
    [self.commandDelegate sendPluginResult:result callbackId:command.callbackId];
  }];
}

- (void)runQueries:(CDVInvokedUrlCommand *)command {
  id request = command.arguments.firstObject;
  [self.commandDelegate runInBackground:^{
    DbInspectorEngine *engine = [DbInspectorEngine new];
    CDVPluginResult *result;
    @try {
      if (![request isKindOfClass:[NSDictionary class]]) {
        result = [CDVPluginResult resultWithStatus:CDVCommandStatus_ERROR messageAsString:@"Missing options"];
      } else {
        result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsDictionary:[engine runQueries:request]];
      }
    } @catch (NSException *e) {
      result = [CDVPluginResult resultWithStatus:CDVCommandStatus_ERROR messageAsString:e.reason ?: @"Failed to run queries"];
    } @finally {
      [engine closeAll];
    }
    [self.commandDelegate sendPluginResult:result callbackId:command.callbackId];
  }];
}

@end
