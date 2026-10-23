// Read-only display geometry. No application, window, automation, capture or
// accessibility APIs are used; NSScreen values are expressed in logical points.
#import <AppKit/AppKit.h>
#include <math.h>
#include <stdio.h>

static id Rectangle(NSRect rect, CGFloat primaryTop) {
    if (NSIsEmptyRect(rect) || !isfinite(rect.origin.x) || !isfinite(rect.origin.y) ||
        !isfinite(rect.size.width) || !isfinite(rect.size.height)) return [NSNull null];
    // AppKit's global origin is bottom-left; Electron's is primary top-left.
    // Keep global x and flip every display against the same primary-screen top.
    return @{ @"x": @(rect.origin.x), @"y": @(primaryTop - NSMaxY(rect)),
              @"width": @(rect.size.width), @"height": @(rect.size.height) };
}

int main(int argc, const char *argv[]) {
    (void)argv;
    if (argc != 1) { fputs("menu-bar takes no arguments\n", stderr); return 64; }
    @autoreleasepool {
        @try {
            NSArray<NSScreen *> *screens = NSScreen.screens;
            if (screens.count == 0) { fputs("display geometry unavailable\n", stderr); return 69; }
            CGFloat primaryTop = NSMaxY(screens[0].frame);
            NSMutableArray *result = [NSMutableArray arrayWithCapacity:screens.count];
            for (NSScreen *screen in screens) {
                id frame = Rectangle(screen.frame, primaryTop);
                if (frame == [NSNull null]) { fputs("invalid display geometry\n", stderr); return 69; }
                id left = [NSNull null], right = [NSNull null];
                if (@available(macOS 12.0, *)) {
                    left = Rectangle(screen.auxiliaryTopLeftArea, primaryTop);
                    right = Rectangle(screen.auxiliaryTopRightArea, primaryTop);
                }
                [result addObject:@{ @"frame": frame, @"left": left, @"right": right }];
            }
            NSError *error = nil;
            NSData *json = [NSJSONSerialization dataWithJSONObject:@{ @"screens": result }
                                                          options:NSJSONWritingSortedKeys error:&error];
            if (!json || error) { fputs("cannot encode display geometry\n", stderr); return 70; }
            if (fwrite(json.bytes, 1, json.length, stdout) != json.length || fputc('\n', stdout) == EOF) return 74;
            return 0;
        } @catch (__unused NSException *exception) {
            fputs("display geometry unavailable\n", stderr);
            return 69;
        }
    }
}
