#import "DbInspectorViewController.h"
#import "DbInspectorEngine.h"
#import <WebKit/WebKit.h>
#import <sys/utsname.h>

static NSString *const kHandlerName = @"dbInspector";
static NSString *const kDefaultsPrefix = @"hfps_db_inspector.";

/** Breaks the WKUserContentController -> handler retain cycle. */
@interface DbiWeakHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) id<WKScriptMessageHandler> target;
@end

@implementation DbiWeakHandler
- (void)userContentController:(WKUserContentController *)c didReceiveScriptMessage:(WKScriptMessage *)m {
  [self.target userContentController:c didReceiveScriptMessage:m];
}
@end

@interface DbInspectorViewController () <WKScriptMessageHandler, UIDocumentPickerDelegate>
@property (nonatomic, strong) NSDictionary *options;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) DbInspectorEngine *engine;
@property (nonatomic, strong) dispatch_queue_t worker;
@property (nonatomic, assign) BOOL darkPage;
@property (nonatomic, strong) NSNumber *pendingPickCallId;
@end

@implementation DbInspectorViewController

- (instancetype)initWithOptions:(NSDictionary *)options {
  if ((self = [super initWithNibName:nil bundle:nil])) {
    _options = options ?: @{};
    _engine = [DbInspectorEngine new];
    _worker = dispatch_queue_create("com.hfps.dbinspector.worker", DISPATCH_QUEUE_SERIAL);
    self.modalPresentationCapturesStatusBarAppearance = YES;
  }
  return self;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.whiteColor;

  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  DbiWeakHandler *handler = [DbiWeakHandler new];
  handler.target = self;
  [config.userContentController addScriptMessageHandler:handler name:kHandlerName];

  self.webView = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
  self.webView.opaque = NO;
  self.webView.backgroundColor = UIColor.clearColor;
  self.webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
  self.webView.translatesAutoresizingMaskIntoConstraints = NO;
#ifdef DEBUG
  if (@available(iOS 16.4, *)) self.webView.inspectable = YES;
#endif
  [self.view addSubview:self.webView];
  // Top/left/right follow the safe area; the page itself pads for the home indicator.
  UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.webView.topAnchor constraintEqualToAnchor:safe.topAnchor],
    [self.webView.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor],
    [self.webView.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor],
    [self.webView.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor]
  ]];

  NSURL *url = [DbInspectorViewController pageUrl];
  if (url) {
    [self.webView loadFileURL:url allowingReadAccessToURL:url.URLByDeletingLastPathComponent];
  } else {
    [self.webView loadHTMLString:@"<p style='font:16px -apple-system;padding:24px'>db-inspector.html is missing from the app bundle.</p>" baseURL:nil];
  }
}

/**
 * The page ships as a <resource-file>: Cordova/CocoaPods copy it into the main bundle, while
 * Swift Package Manager (Capacitor) wraps plugin resources in a nested *.bundle.
 */
+ (NSURL *)pageUrl {
  NSURL *direct = [NSBundle.mainBundle URLForResource:@"db-inspector" withExtension:@"html"];
  if (direct) return direct;
  for (NSURL *bundleUrl in [NSBundle.mainBundle URLsForResourcesWithExtension:@"bundle" subdirectory:nil]) {
    NSURL *nested = [[NSBundle bundleWithURL:bundleUrl] URLForResource:@"db-inspector" withExtension:@"html"];
    if (nested) return nested;
  }
  return nil;
}

- (UIStatusBarStyle)preferredStatusBarStyle {
  if (@available(iOS 13.0, *)) return self.darkPage ? UIStatusBarStyleLightContent : UIStatusBarStyleDarkContent;
  return self.darkPage ? UIStatusBarStyleLightContent : UIStatusBarStyleDefault;
}

- (void)dealloc {
  [_webView.configuration.userContentController removeScriptMessageHandlerForName:kHandlerName];
  DbInspectorEngine *engine = _engine;
  [engine interrupt];
  dispatch_async(_worker, ^{ [engine closeAll]; });
}

#pragma mark - Bridge

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  NSDictionary *body = [message.body isKindOfClass:[NSDictionary class]] ? message.body : nil;
  if (!body) return;
  NSNumber *callId = body[@"callId"];
  NSString *action = body[@"action"];
  NSDictionary *args = [body[@"args"] isKindOfClass:[NSDictionary class]] ? body[@"args"] : @{};

  // Must bypass the serial worker, which is busy with the query being cancelled.
  if ([action isEqualToString:@"interrupt"]) {
    [self.engine interrupt];
    [self resolve:callId data:@YES];
    return;
  }
  __weak DbInspectorViewController *weakSelf = self;
  dispatch_async(self.worker, ^{
    DbInspectorViewController *strongSelf = weakSelf;
    if (!strongSelf) return;
    @try {
      [strongSelf handle:action args:args callId:callId];
    } @catch (NSException *e) {
      [strongSelf reject:callId message:e.reason ?: e.name];
    }
  });
}

- (void)handle:(NSString *)action args:(NSDictionary *)args callId:(NSNumber *)callId {
  NSString *db = [args[@"db"] isKindOfClass:[NSString class]] ? args[@"db"] : @"";
  DbInspectorEngine *e = self.engine;
  if ([action isEqual:@"context"]) [self resolve:callId data:[self context]];
  else if ([action isEqual:@"listDatabases"]) [self resolve:callId data:[e listDatabases]];
  else if ([action isEqual:@"overview"]) [self resolve:callId data:[e overview:db]];
  else if ([action isEqual:@"tableSchema"]) [self resolve:callId data:[e tableSchema:db table:[args[@"table"] description]]];
  else if ([action isEqual:@"tableRows"]) [self resolve:callId data:[e tableRows:db args:args]];
  else if ([action isEqual:@"cell"]) [self resolve:callId data:[e cell:db args:args]];
  else if ([action isEqual:@"columnStats"]) [self resolve:callId data:[e columnStats:db args:args]];
  else if ([action isEqual:@"query"]) [self resolve:callId data:[e query:db args:args]];
  else if ([action isEqual:@"dbInfo"]) [self resolve:callId data:[e dbInfo:db]];
  else if ([action isEqual:@"tableSizes"]) [self resolve:callId data:[e tableSizes:db]];
  else if ([action isEqual:@"integrityCheck"]) [self resolve:callId data:[e integrityCheck:db]];
  else if ([action isEqual:@"storageGet"]) {
    NSString *v = [NSUserDefaults.standardUserDefaults stringForKey:[kDefaultsPrefix stringByAppendingString:[args[@"key"] description]]];
    [self resolve:callId data:v ?: [NSNull null]];
  } else if ([action isEqual:@"storageSet"]) {
    NSString *key = [kDefaultsPrefix stringByAppendingString:[args[@"key"] description]];
    id value = args[@"value"];
    if ([value isKindOfClass:[NSString class]]) [NSUserDefaults.standardUserDefaults setObject:value forKey:key];
    else [NSUserDefaults.standardUserDefaults removeObjectForKey:key];
    [self resolve:callId data:@YES];
  } else if ([action isEqual:@"saveFile"]) {
    NSString *content = [args[@"content"] isKindOfClass:[NSString class]] ? args[@"content"] : @"";
    NSData *data = [args[@"base64"] boolValue] ? [[NSData alloc] initWithBase64EncodedString:content options:NSDataBase64DecodingIgnoreUnknownCharacters]
                                             : [content dataUsingEncoding:NSUTF8StringEncoding];
    NSString *name = [[args[@"name"] description] stringByReplacingOccurrencesOfString:@"/" withString:@"_"] ?: @"export.txt";
    NSString *dir = [NSTemporaryDirectory() stringByAppendingPathComponent:@"db-inspector-export"];
    [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *path = [dir stringByAppendingPathComponent:name];
    if (![data writeToFile:path atomically:YES]) @throw [NSException exceptionWithName:@"DbInspectorError" reason:@"Could not write export file" userInfo:nil];
    [self share:[NSURL fileURLWithPath:path] callId:callId];
  } else if ([action isEqual:@"exportDatabase"]) {
    [self share:[e snapshot:db] callId:callId];
  } else if ([action isEqual:@"pickFile"]) {
    dispatch_async(dispatch_get_main_queue(), ^{ [self presentPicker:callId]; });
  } else if ([action isEqual:@"setTheme"]) {
    BOOL dark = [args[@"dark"] boolValue];
    UIColor *color = [DbInspectorViewController colorFromHex:[args[@"color"] description]] ?: (dark ? UIColor.blackColor : UIColor.whiteColor);
    dispatch_async(dispatch_get_main_queue(), ^{
      self.darkPage = dark;
      self.view.backgroundColor = color;
      [self setNeedsStatusBarAppearanceUpdate];
    });
    [self resolve:callId data:@YES];
  } else if ([action isEqual:@"close"]) {
    dispatch_async(dispatch_get_main_queue(), ^{ [self dismissViewControllerAnimated:YES completion:nil]; });
    [self resolve:callId data:@YES];
  } else {
    [self reject:callId message:[@"Unknown action: " stringByAppendingString:action ?: @""]];
  }
}

- (NSDictionary *)context {
  struct utsname info;
  uname(&info);
  NSDictionary *plist = NSBundle.mainBundle.infoDictionary;
  __block NSString *osVersion;
  dispatch_sync(dispatch_get_main_queue(), ^{ osVersion = UIDevice.currentDevice.systemVersion; });
  return @{
    @"platform": @"ios",
    @"osVersion": osVersion ?: @"",
    @"device": @(info.machine),
    @"appId": NSBundle.mainBundle.bundleIdentifier ?: @"",
    @"appVersion": plist[@"CFBundleShortVersionString"] ?: @"",
    @"options": self.options
  };
}

+ (UIColor *)colorFromHex:(NSString *)hex {
  if (![hex hasPrefix:@"#"] || hex.length != 7) return nil;
  unsigned int rgb = 0;
  [[NSScanner scannerWithString:[hex substringFromIndex:1]] scanHexInt:&rgb];
  return [UIColor colorWithRed:((rgb >> 16) & 0xFF) / 255.0 green:((rgb >> 8) & 0xFF) / 255.0 blue:(rgb & 0xFF) / 255.0 alpha:1];
}

- (void)resolve:(NSNumber *)callId data:(id)data {
  [self deliver:callId envelope:@{@"ok": @YES, @"data": data ?: [NSNull null]}];
}

- (void)reject:(NSNumber *)callId message:(NSString *)message {
  [self deliver:callId envelope:@{@"ok": @NO, @"error": message ?: @"Unknown error"}];
}

- (void)deliver:(NSNumber *)callId envelope:(NSDictionary *)envelope {
  NSError *err = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:envelope options:0 error:&err];
  if (!json) json = [NSJSONSerialization dataWithJSONObject:@{@"ok": @NO, @"error": err.localizedDescription ?: @"Serialization failed"} options:0 error:nil];
  // Wrap in an array to get a correctly escaped JS string literal, then strip the brackets.
  NSString *raw = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
  NSData *wrapped = [NSJSONSerialization dataWithJSONObject:@[raw] options:0 error:nil];
  NSString *literal = [[NSString alloc] initWithData:wrapped encoding:NSUTF8StringEncoding];
  literal = [literal substringWithRange:NSMakeRange(1, literal.length - 2)];
  NSString *js = [NSString stringWithFormat:@"window.__dbiResolve(%@,%@)", callId, literal];
  dispatch_async(dispatch_get_main_queue(), ^{ [self.webView evaluateJavaScript:js completionHandler:nil]; });
}

#pragma mark - Files

- (void)share:(NSURL *)fileUrl callId:(NSNumber *)callId {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:@[fileUrl] applicationActivities:nil];
    sheet.popoverPresentationController.sourceView = self.view;
    sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(self.view.bounds), CGRectGetMidY(self.view.bounds), 1, 1);
    __weak DbInspectorViewController *weakSelf = self;
    sheet.completionWithItemsHandler = ^(UIActivityType type, BOOL completed, NSArray *items, NSError *error) {
      if (error) [weakSelf reject:callId message:error.localizedDescription];
      else [weakSelf resolve:callId data:completed ? @{@"saved": @YES} : @{@"cancelled": @YES}];
    };
    [self presentViewController:sheet animated:YES completion:nil];
  });
}

- (void)presentPicker:(NSNumber *)callId {
  self.pendingPickCallId = callId;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc]
      initWithDocumentTypes:@[@"public.json", @"public.plain-text", @"public.data"] inMode:UIDocumentPickerModeImport];
#pragma clang diagnostic pop
  picker.delegate = self;
  [self presentViewController:picker animated:YES completion:nil];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  NSNumber *callId = self.pendingPickCallId;
  self.pendingPickCallId = nil;
  NSURL *url = urls.firstObject;
  if (!callId || !url) return;
  BOOL scoped = [url startAccessingSecurityScopedResource];
  NSData *data = [NSData dataWithContentsOfURL:url];
  if (scoped) [url stopAccessingSecurityScopedResource];
  if (!data) { [self reject:callId message:@"Could not read the selected file"]; return; }
  if (data.length > 10 * 1024 * 1024) { [self reject:callId message:@"File is larger than 10 MB"]; return; }
  NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
  [self resolve:callId data:@{@"name": url.lastPathComponent ?: @"", @"text": text}];
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
  NSNumber *callId = self.pendingPickCallId;
  self.pendingPickCallId = nil;
  if (callId) [self resolve:callId data:@{@"cancelled": @YES}];
}

@end
