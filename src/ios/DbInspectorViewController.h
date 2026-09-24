#import <UIKit/UIKit.h>

/** Full-screen host for the bundled db-inspector.html page (see the Android activity for the bridge protocol). */
@interface DbInspectorViewController : UIViewController

- (instancetype)initWithOptions:(NSDictionary *)options;

@end
