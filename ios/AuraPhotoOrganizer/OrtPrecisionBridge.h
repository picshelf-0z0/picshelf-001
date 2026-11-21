#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Lightweight Objective-C wrapper over Microsoft's official ONNX Runtime C API
/// (`onnxruntime.xcframework`) for PicShelf Backdrop Precision inference.
/// Matches Android's `BackdropPrecisionSegmenter.kt` options 1:1.
@interface PicShelfOrtSession : NSObject

/// Creates an ONNX Runtime session for `modelPath` with `OPT_ALL`, sequential execution,
/// `numThreads` intra-op threads (1..4), inter-op threads = 1, and CPU arena/memory pattern
/// disabled so working memory is returned to iOS immediately after every cutout.
- (nullable instancetype)initWithModelPath:(NSString *)modelPath
                                numThreads:(int)numThreads
                                     error:(NSError * _Nullable * _Nullable)error;

/// Runs a single `[1, 3, size, size]` Float32 CHW tensor and returns a `[size * size]`
/// UInt8 alpha matte (`0..255`). Thread-safe with `terminateActiveRun`.
- (nullable NSData *)runFloatCHWInput:(NSData *)inputData
                            inputName:(NSString *)inputName
                           outputName:(NSString *)outputName
                                 size:(int)size
                                error:(NSError * _Nullable * _Nullable)error;

/// Runs Picsart AI Research MI-GAN `migan_pipeline_v2.onnx`:
/// - `rgbCHW`: UINT8 `[1, 3, height, width]` RGB planar bytes
/// - `maskCHW`: UINT8 `[1, 1, height, width]` (`255` = keep, `0` = remove)
/// Returns UINT8 `[1, 3, height, width]` RGB planar bytes.
- (nullable NSData *)runMiganInpaintRGB:(NSData *)rgbCHW
                                   mask:(NSData *)maskCHW
                                  width:(int)width
                                 height:(int)height
                              imageName:(NSString *)imageName
                               maskName:(NSString *)maskName
                             outputName:(NSString *)outputName
                                  error:(NSError * _Nullable * _Nullable)error;

/// Signals any in-flight `runFloatCHWInput:` call to abort promptly (matching Android's
/// `OrtSession.RunOptions.setTerminate(true)`).
- (void)terminateActiveRun;

/// Releases the underlying `OrtSession` immediately.
- (void)close;

@end

NS_ASSUME_NONNULL_END
