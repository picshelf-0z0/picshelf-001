#import "OrtPrecisionBridge.h"
#import <onnxruntime/onnxruntime_c_api.h>
#import <math.h>
#import <stdint.h>

static NSString * const kPicShelfOrtErrorDomain = @"com.picshelf.ort.precision";

static const OrtApi *PicShelfGetOrtApi(NSError **error) {
    const OrtApiBase *base = OrtGetApiBase();
    if (!base) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-1
                                     userInfo:@{NSLocalizedDescriptionKey: @"ONNX Runtime API base unavailable"}];
        }
        return NULL;
    }
    const OrtApi *api = base->GetApi(ORT_API_VERSION);
    if (!api) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-2
                                     userInfo:@{NSLocalizedDescriptionKey: @"ONNX Runtime API version mismatch"}];
        }
        return NULL;
    }
    return api;
}

static BOOL PicShelfCheckOrtStatus(const OrtApi *api, OrtStatus *status, NSError **error) {
    if (!status) {
        return YES;
    }
    const char *msg = api->GetErrorMessage(status);
    NSString *desc = msg ? [NSString stringWithUTF8String:msg] : @"ONNX Runtime error";
    api->ReleaseStatus(status);
    if (error) {
        *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                     code:-3
                                 userInfo:@{NSLocalizedDescriptionKey: desc ?: @"ONNX Runtime error"}];
    }
    return NO;
}

static OrtEnv *PicShelfSharedOrtEnv(const OrtApi *api, NSError **error) {
    static OrtEnv *sEnv = NULL;
    static dispatch_once_t onceToken;
    __block NSError *initError = nil;
    dispatch_once(&onceToken, ^{
        OrtEnv *env = NULL;
        OrtStatus *st = api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "PicShelfPrecision", &env);
        if (st) {
            PicShelfCheckOrtStatus(api, st, &initError);
        } else {
            sEnv = env;
        }
    });
    if (!sEnv && error) {
        *error = initError ?: [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                                  code:-4
                                              userInfo:@{NSLocalizedDescriptionKey: @"Failed to initialize ONNX Runtime environment"}];
    }
    return sEnv;
}

@implementation PicShelfOrtSession {
    const OrtApi *_api;
    OrtSession *_session;
    OrtRunOptions *_activeRunOptions;
    NSLock *_runLock;
}

- (nullable instancetype)initWithModelPath:(NSString *)modelPath
                                numThreads:(int)numThreads
                                     error:(NSError * _Nullable * _Nullable)error {
    self = [super init];
    if (!self) return nil;

    _runLock = [[NSLock alloc] init];
    _api = PicShelfGetOrtApi(error);
    if (!_api) return nil;

    OrtEnv *env = PicShelfSharedOrtEnv(_api, error);
    if (!env) return nil;

    OrtSessionOptions *opts = NULL;
    if (!PicShelfCheckOrtStatus(_api, _api->CreateSessionOptions(&opts), error)) {
        return nil;
    }

    int clampedThreads = numThreads < 1 ? 1 : (numThreads > 4 ? 4 : numThreads);
    BOOL ok = PicShelfCheckOrtStatus(_api, _api->SetSessionGraphOptimizationLevel(opts, ORT_ENABLE_ALL), error)
           && PicShelfCheckOrtStatus(_api, _api->SetSessionExecutionMode(opts, ORT_SEQUENTIAL), error)
           && PicShelfCheckOrtStatus(_api, _api->SetIntraOpNumThreads(opts, clampedThreads), error)
           && PicShelfCheckOrtStatus(_api, _api->SetInterOpNumThreads(opts, 1), error)
           && PicShelfCheckOrtStatus(_api, _api->DisableCpuMemArena(opts), error)
           && PicShelfCheckOrtStatus(_api, _api->DisableMemPattern(opts), error);

    if (ok) {
        const char *cPath = [modelPath fileSystemRepresentation];
        ok = PicShelfCheckOrtStatus(_api, _api->CreateSession(env, cPath, opts, &_session), error);
    }

    _api->ReleaseSessionOptions(opts);
    if (!ok || !_session) {
        return nil;
    }
    return self;
}

- (void)terminateActiveRun {
    [_runLock lock];
    if (_activeRunOptions && _api) {
        OrtStatus *st = _api->RunOptionsSetTerminate(_activeRunOptions);
        if (st) {
            _api->ReleaseStatus(st);
        }
    }
    [_runLock unlock];
}

- (void)close {
    [self terminateActiveRun];
    if (_session && _api) {
        _api->ReleaseSession(_session);
        _session = NULL;
    }
}

- (void)dealloc {
    [self close];
}

- (nullable NSData *)runFloatCHWInput:(NSData *)inputData
                            inputName:(NSString *)inputName
                           outputName:(NSString *)outputName
                                 size:(int)size
                                error:(NSError * _Nullable * _Nullable)error {
    if (!_session || !_api) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-5
                                     userInfo:@{NSLocalizedDescriptionKey: @"Precision session closed"}];
        }
        return nil;
    }

    const size_t expectedPixels = (size_t)size * (size_t)size;
    const size_t expectedInputBytes = expectedPixels * 3 * sizeof(float);
    if (inputData.length < expectedInputBytes) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-6
                                     userInfo:@{NSLocalizedDescriptionKey: @"Invalid precision input tensor size"}];
        }
        return nil;
    }

    OrtMemoryInfo *memInfo = NULL;
    OrtValue *inputTensor = NULL;
    OrtValue *outputTensor = NULL;
    OrtRunOptions *runOpts = NULL;
    OrtTensorTypeAndShapeInfo *shapeInfo = NULL;
    NSMutableData *matte = nil;
    NSData *resultMatte = nil;

    if (!PicShelfCheckOrtStatus(_api, _api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memInfo), error)) {
        goto cleanup;
    }

    int64_t shape[4] = {1, 3, (int64_t)size, (int64_t)size};
    if (!PicShelfCheckOrtStatus(_api,
            _api->CreateTensorWithDataAsOrtValue(memInfo,
                                                 (void *)inputData.bytes,
                                                 expectedInputBytes,
                                                 shape,
                                                 4,
                                                 ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,
                                                 &inputTensor),
            error)) {
        goto cleanup;
    }

    if (!PicShelfCheckOrtStatus(_api, _api->CreateRunOptions(&runOpts), error)) {
        goto cleanup;
    }

    [_runLock lock];
    _activeRunOptions = runOpts;
    [_runLock unlock];

    const char *inNames[1] = {[inputName UTF8String]};
    const char *outNames[1] = {[outputName UTF8String]};
    const OrtValue *inVals[1] = {inputTensor};

    OrtStatus *runStatus = _api->Run(_session, runOpts, inNames, inVals, 1, outNames, 1, &outputTensor);

    [_runLock lock];
    if (_activeRunOptions == runOpts) {
        _activeRunOptions = NULL;
    }
    [_runLock unlock];

    if (!PicShelfCheckOrtStatus(_api, runStatus, error)) {
        goto cleanup;
    }
    if (!outputTensor) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-7
                                     userInfo:@{NSLocalizedDescriptionKey: @"Precision model returned no mask"}];
        }
        goto cleanup;
    }

    if (!PicShelfCheckOrtStatus(_api, _api->GetTensorTypeAndShape(outputTensor, &shapeInfo), error)) {
        goto cleanup;
    }
    size_t elemCount = 0;
    if (!PicShelfCheckOrtStatus(_api, _api->GetTensorShapeElementCount(shapeInfo, &elemCount), error)) {
        goto cleanup;
    }
    if (elemCount != expectedPixels) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-8
                                     userInfo:@{NSLocalizedDescriptionKey: @"Unexpected precision mask size"}];
        }
        goto cleanup;
    }

    float *outFloats = NULL;
    if (!PicShelfCheckOrtStatus(_api, _api->GetTensorMutableData(outputTensor, (void **)&outFloats), error) || !outFloats) {
        goto cleanup;
    }

    matte = [NSMutableData dataWithLength:expectedPixels];
    if (!matte) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-9
                                     userInfo:@{NSLocalizedDescriptionKey: @"Out of memory allocating precision mask"}];
        }
        goto cleanup;
    }
    uint8_t *dst = (uint8_t *)matte.mutableBytes;
    for (size_t i = 0; i < expectedPixels; i++) {
        float v = outFloats[i];
        if (v < 0.0f) v = 0.0f;
        else if (v > 1.0f) v = 1.0f;
        dst[i] = (uint8_t)lroundf(v * 255.0f);
    }
    resultMatte = matte;

cleanup:
    if (shapeInfo) _api->ReleaseTensorTypeAndShapeInfo(shapeInfo);
    if (outputTensor) _api->ReleaseValue(outputTensor);
    if (runOpts) _api->ReleaseRunOptions(runOpts);
    if (inputTensor) _api->ReleaseValue(inputTensor);
    if (memInfo) _api->ReleaseMemoryInfo(memInfo);
    return resultMatte;
}

- (nullable NSData *)runMiganInpaintRGB:(NSData *)rgbCHW
                                   mask:(NSData *)maskCHW
                                  width:(int)width
                                 height:(int)height
                              imageName:(NSString *)imageName
                               maskName:(NSString *)maskName
                             outputName:(NSString *)outputName
                                  error:(NSError * _Nullable * _Nullable)error {
    if (!_session || !_api) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-15
                                     userInfo:@{NSLocalizedDescriptionKey: @"AI eraser session closed"}];
        }
        return nil;
    }

    const size_t pixels = (size_t)width * (size_t)height;
    const size_t rgbBytes = pixels * 3;
    if (rgbCHW.length < rgbBytes || maskCHW.length < pixels) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-16
                                     userInfo:@{NSLocalizedDescriptionKey: @"Invalid AI eraser tensor size"}];
        }
        return nil;
    }

    OrtMemoryInfo *memInfo = NULL;
    OrtValue *imgTensor = NULL;
    OrtValue *maskTensor = NULL;
    OrtValue *outTensor = NULL;
    OrtRunOptions *runOpts = NULL;
    OrtTensorTypeAndShapeInfo *shapeInfo = NULL;
    NSData *resultRGB = nil;

    if (!PicShelfCheckOrtStatus(_api, _api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memInfo), error)) {
        goto cleanup_migan;
    }

    int64_t imgShape[4] = {1, 3, (int64_t)height, (int64_t)width};
    int64_t maskShape[4] = {1, 1, (int64_t)height, (int64_t)width};
    if (!PicShelfCheckOrtStatus(_api,
            _api->CreateTensorWithDataAsOrtValue(memInfo,
                                                 (void *)rgbCHW.bytes,
                                                 rgbBytes,
                                                 imgShape,
                                                 4,
                                                 ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8,
                                                 &imgTensor),
            error)) {
        goto cleanup_migan;
    }
    if (!PicShelfCheckOrtStatus(_api,
            _api->CreateTensorWithDataAsOrtValue(memInfo,
                                                 (void *)maskCHW.bytes,
                                                 pixels,
                                                 maskShape,
                                                 4,
                                                 ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8,
                                                 &maskTensor),
            error)) {
        goto cleanup_migan;
    }

    if (!PicShelfCheckOrtStatus(_api, _api->CreateRunOptions(&runOpts), error)) {
        goto cleanup_migan;
    }

    [_runLock lock];
    _activeRunOptions = runOpts;
    [_runLock unlock];

    const char *inNames[2] = {[imageName UTF8String], [maskName UTF8String]};
    const OrtValue *inVals[2] = {imgTensor, maskTensor};
    const char *outNames[1] = {[outputName UTF8String]};

    OrtStatus *runStatus = _api->Run(_session, runOpts, inNames, inVals, 2, outNames, 1, &outTensor);

    [_runLock lock];
    if (_activeRunOptions == runOpts) {
        _activeRunOptions = NULL;
    }
    [_runLock unlock];

    if (!PicShelfCheckOrtStatus(_api, runStatus, error)) {
        goto cleanup_migan;
    }
    if (!outTensor) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-17
                                     userInfo:@{NSLocalizedDescriptionKey: @"AI eraser returned no output"}];
        }
        goto cleanup_migan;
    }

    if (!PicShelfCheckOrtStatus(_api, _api->GetTensorTypeAndShape(outTensor, &shapeInfo), error)) {
        goto cleanup_migan;
    }
    size_t elemCount = 0;
    if (!PicShelfCheckOrtStatus(_api, _api->GetTensorShapeElementCount(shapeInfo, &elemCount), error)) {
        goto cleanup_migan;
    }
    if (elemCount < rgbBytes) {
        if (error) {
            *error = [NSError errorWithDomain:kPicShelfOrtErrorDomain
                                         code:-18
                                     userInfo:@{NSLocalizedDescriptionKey: @"Unexpected AI eraser output size"}];
        }
        goto cleanup_migan;
    }

    uint8_t *outBytes = NULL;
    if (!PicShelfCheckOrtStatus(_api, _api->GetTensorMutableData(outTensor, (void **)&outBytes), error) || !outBytes) {
        goto cleanup_migan;
    }
    resultRGB = [NSData dataWithBytes:outBytes length:rgbBytes];

cleanup_migan:
    if (shapeInfo) _api->ReleaseTensorTypeAndShapeInfo(shapeInfo);
    if (outTensor) _api->ReleaseValue(outTensor);
    if (runOpts) _api->ReleaseRunOptions(runOpts);
    if (maskTensor) _api->ReleaseValue(maskTensor);
    if (imgTensor) _api->ReleaseValue(imgTensor);
    if (memInfo) _api->ReleaseMemoryInfo(memInfo);
    return resultRGB;
}

@end
