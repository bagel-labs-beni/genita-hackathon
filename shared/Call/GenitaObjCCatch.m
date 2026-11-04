#import "GenitaObjCCatch.h"

NSException * _Nullable GenitaCatchObjC(NS_NOESCAPE void (^block)(void)) {
    @try {
        block();
        return nil;
    } @catch (NSException *exception) {
        return exception;
    }
}
