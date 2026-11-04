#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block` and returns the Objective-C exception it raised, or nil. Swift cannot catch an NSException:
/// AVAudioPlayerNode.play() raises one when its engine is stopped or the node is not connected, which aborts the
/// app (TF 331 CRASH-1). Call sites log the exception and go on.
FOUNDATION_EXPORT NSException * _Nullable GenitaCatchObjC(NS_NOESCAPE void (^block)(void));

NS_ASSUME_NONNULL_END
