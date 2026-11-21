import Foundation
import UIKit
import WebKit
import ImageIO
import CryptoKit
import Network

/// On-device Backdrop "Precision" cutout for iOS (InSPyReNet SwinB 640x640 on ONNX Runtime).
/// Exact parity with Android's BackdropPrecisionSegmenter.kt:
/// - The ~112 MB model is NOT bundled in the IPA; only manifest.json is shipped.
/// - First use prompts and downloads the 12 verified parts from GitHub Releases with HTTP Range resume
///   and per-part + full-file SHA-256 verification.
/// - Zero startup cost: nothing loads until Precision is actually run, and the session releases after 120s idle.
final class PicShelfBackdropPrecisionManager {
    static let shared = PicShelfBackdropPrecisionManager()

    weak var webView: WKWebView?

    private struct Part {
        let name: String
        let bytes: Int64
        let sha256: String
    }

    private struct Manifest {
        let version: Int
        let baseUrl: String
        let parts: [Part]
        let bytes: Int64
        let sha256: String
        let size: Int
        let mean: [Float]
        let std: [Float]
        let input: String
        let output: String
    }

    private enum PrecisionError: Error {
        case storageFull(Int64)
        case corrupt
        case stopped
        case network(String)
        case runtime(String)
    }

    private static let storeDirName = "backdrop_precision"
    private static let readyMarkerName = "ready"
    private static let assembledModelName = "model.onnx"
    private static let partialSuffix = ".partial"
    private static let storageMargin: Int64 = 32 * 1024 * 1024
    private static let idleReleaseSeconds: TimeInterval = 120
    private static let minTotalMemory: UInt64 = 3_500 * 1024 * 1024

    private let stateLock = NSLock()
    private let workerQueue = DispatchQueue(label: "com.picshelf.ios.backdrop.precision", qos: .userInitiated)
    private let downloadQueue = DispatchQueue(label: "com.picshelf.ios.backdrop.precision.download", qos: .utility)
    private let pathMonitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "com.picshelf.ios.backdrop.precision.net", qos: .utility)

    private var isExpensiveNetwork: Bool = false
    private var downloading: Bool = false
    private var stopDownloadRequested: Bool = false
    private var downloadedBytes: Int64 = 0
    private var downloadError: String? = nil
    private var lastProgressAt: TimeInterval = 0
    private var activeDownloadTask: URLSessionDataTask? = nil

    private var activeRequestId: String? = nil
    private var idleReleaseWork: DispatchWorkItem? = nil

    private var ortSession: PicShelfOrtSession? = nil

    private lazy var manifest: Manifest? = Self.readManifest()

    private init() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            self.stateLock.lock()
            self.isExpensiveNetwork = path.isExpensive || path.isConstrained
            self.stateLock.unlock()
        }
        pathMonitor.start(queue: monitorQueue)
    }

    // MARK: - Availability & Status

    func isAvailable() -> Bool {
        return availabilityReason() == nil
    }

    private func availabilityReason() -> String? {
        if ProcessInfo.processInfo.physicalMemory < Self.minTotalMemory {
            return "low memory device"
        }
        if manifest == nil {
            return "model unavailable"
        }
        return nil
    }

    func modelStatusJson() -> String {
        let obj = statusDict()
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let str = String(data: data, encoding: .utf8) else {
            return "{\"state\":\"missing\",\"downloaded\":0,\"total\":0,\"metered\":false,\"error\":null}"
        }
        return str
    }

    private func statusDict() -> [String: Any] {
        let spec = manifest
        let ready = spec != nil && isModelReady(spec!)
        stateLock.lock()
        let isDl = downloading
        let dlBytes = downloadedBytes
        let dlErr = downloadError
        let metered = isExpensiveNetwork
        stateLock.unlock()

        let state: String
        if ready { state = "ready" }
        else if isDl { state = "downloading" }
        else if dlErr != nil { state = "error" }
        else { state = "missing" }

        let total = spec?.bytes ?? 0
        let done: Int64
        if ready { done = total }
        else if isDl { done = dlBytes }
        else if let s = spec { done = storedBytes(s) }
        else { done = 0 }

        var dict: [String: Any] = [
            "state": state,
            "downloaded": done,
            "total": total,
            "metered": metered
        ]
        dict["error"] = dlErr ?? NSNull()
        return dict
    }

    private func notifyDownload(force: Bool = false) {
        let now = CACurrentMediaTime()
        stateLock.lock()
        if !force && (now - lastProgressAt) < 0.25 {
            stateLock.unlock()
            return
        }
        lastProgressAt = now
        stateLock.unlock()

        let json = modelStatusJson()
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(
                "window.PicShelfBackdropPrecision && window.PicShelfBackdropPrecision.onDownload(\(json));",
                completionHandler: nil
            )
        }
    }

    // MARK: - Storage Paths & Verification

    private func storeRootDir() -> URL {
        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent(Self.storeDirName, isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        var mutable = dir
        try? mutable.setResourceValues(rv)
        return dir
    }

    private func modelDir(_ spec: Manifest) -> URL {
        return storeRootDir().appendingPathComponent("v\(spec.version)", isDirectory: true)
    }

    private func assembledModelURL(_ spec: Manifest) -> URL {
        return modelDir(spec).appendingPathComponent(Self.assembledModelName)
    }

    private func fileSize(at url: URL) -> Int64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let sz = (attrs[.size] as? NSNumber)?.int64Value else { return 0 }
        return sz
    }

    private func isModelReady(_ spec: Manifest) -> Bool {
        let dir = modelDir(spec)
        let marker = dir.appendingPathComponent(Self.readyMarkerName)
        guard let markerText = try? String(contentsOf: marker, encoding: .utf8),
              markerText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == spec.sha256.lowercased() else {
            return false
        }
        return fileSize(at: assembledModelURL(spec)) == spec.bytes
    }

    private func storedBytes(_ spec: Manifest) -> Int64 {
        if isModelReady(spec) { return spec.bytes }
        let dir = modelDir(spec)
        var sum: Int64 = 0
        for part in spec.parts {
            let doneURL = dir.appendingPathComponent(part.name)
            if fileSize(at: doneURL) == part.bytes {
                sum += part.bytes
            } else {
                let partURL = dir.appendingPathComponent(part.name + Self.partialSuffix)
                sum += min(fileSize(at: partURL), part.bytes)
            }
        }
        return sum
    }

    private func availableDiskBytes(at dir: URL) -> Int64 {
        if let vals = try? dir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let cap = vals.volumeAvailableCapacityForImportantUsage {
            return cap
        }
        if let attrs = try? FileManager.default.attributesOfFileSystem(forPath: dir.path),
           let free = (attrs[.systemFreeSize] as? NSNumber)?.int64Value {
            return free
        }
        return Int64.max / 2
    }

    private func sha256Hex(of fileURL: URL) -> String? {
        guard let fh = try? FileHandle(forReadingFrom: fileURL) else { return nil }
        defer { try? fh.close() }
        var hasher = SHA256()
        while true {
            var eof = false
            autoreleasepool {
                if let chunk = try? fh.read(upToCount: 262144), !chunk.isEmpty {
                    hasher.update(data: chunk)
                } else {
                    eof = true
                }
            }
            if eof { break }
        }
        let digest = hasher.finalize()
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - On-Demand Resumable Download from GitHub Releases

    func startDownload() {
        guard let spec = manifest else { return }
        if isModelReady(spec) {
            notifyDownload(force: true)
            return
        }
        stateLock.lock()
        if downloading {
            stateLock.unlock()
            return
        }
        downloading = true
        stopDownloadRequested = false
        downloadError = nil
        stateLock.unlock()

        notifyDownload(force: true)
        downloadQueue.async { [weak self] in
            self?.runDownload(spec)
        }
    }

    func stopDownload() {
        stateLock.lock()
        if downloading {
            stopDownloadRequested = true
            activeDownloadTask?.cancel()
        }
        stateLock.unlock()
    }

    private func isStopRequested() -> Bool {
        stateLock.lock()
        let stopped = stopDownloadRequested
        stateLock.unlock()
        return stopped
    }

    private func runDownload(_ spec: Manifest) {
        let fm = FileManager.default
        let dir = modelDir(spec)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        let bgSem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "PicShelfPrecisionDownload") {
                if bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTaskId)
                    bgTaskId = .invalid
                }
            }
            bgSem.signal()
        }
        _ = bgSem.wait(timeout: .now() + 2)

        defer {
            stateLock.lock()
            downloading = false
            stopDownloadRequested = false
            activeDownloadTask = nil
            stateLock.unlock()
            DispatchQueue.main.async {
                if bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTaskId)
                    bgTaskId = .invalid
                }
            }
            notifyDownload(force: true)
        }

        do {
            let initialStored = storedBytes(spec)
            stateLock.lock()
            downloadedBytes = initialStored
            stateLock.unlock()

            // Require enough free space for remaining parts + assembled model.onnx + margin
            let remainingPartsBytes = max(0, spec.bytes - initialStored)
            let needed = remainingPartsBytes + spec.bytes + Self.storageMargin
            if availableDiskBytes(at: dir) < needed {
                throw PrecisionError.storageFull(needed)
            }

            var completedBefore: Int64 = 0
            for part in spec.parts {
                let doneURL = dir.appendingPathComponent(part.name)
                if fileSize(at: doneURL) == part.bytes {
                    completedBefore += part.bytes
                    continue
                }
                try downloadPart(spec: spec, part: part, dir: dir, completedBefore: completedBefore)
                completedBefore += part.bytes
            }

            // Stream-assemble all 12 verified parts into model.onnx, verify full-file SHA-256, and clean up parts
            let tmpAssembled = dir.appendingPathComponent(Self.assembledModelName + Self.partialSuffix)
            try? fm.removeItem(at: tmpAssembled)
            fm.createFile(atPath: tmpAssembled.path, contents: nil)
            guard let outFH = try? FileHandle(forWritingTo: tmpAssembled) else {
                throw PrecisionError.storageFull(spec.bytes)
            }
            var fullHasher = SHA256()
            var totalAssembled: Int64 = 0
            for part in spec.parts {
                if isStopRequested() {
                    try? outFH.close()
                    try? fm.removeItem(at: tmpAssembled)
                    throw PrecisionError.stopped
                }
                let pURL = dir.appendingPathComponent(part.name)
                guard let inFH = try? FileHandle(forReadingFrom: pURL) else {
                    try? outFH.close()
                    try? fm.removeItem(at: tmpAssembled)
                    throw PrecisionError.corrupt
                }
                defer { try? inFH.close() }
                while true {
                    var eof = false
                    autoreleasepool {
                        if let chunk = try? inFH.read(upToCount: 262144), !chunk.isEmpty {
                            outFH.write(chunk)
                            fullHasher.update(data: chunk)
                            totalAssembled += Int64(chunk.count)
                        } else {
                            eof = true
                        }
                    }
                    if eof { break }
                }
            }
            try? outFH.synchronize()
            try? outFH.close()

            let finalHash = fullHasher.finalize().map { String(format: "%02x", $0) }.joined()
            guard totalAssembled == spec.bytes && finalHash.lowercased() == spec.sha256.lowercased() else {
                try? fm.removeItem(at: tmpAssembled)
                for part in spec.parts {
                    try? fm.removeItem(at: dir.appendingPathComponent(part.name))
                }
                throw PrecisionError.corrupt
            }

            let finalModelURL = assembledModelURL(spec)
            try? fm.removeItem(at: finalModelURL)
            try fm.moveItem(at: tmpAssembled, to: finalModelURL)

            let markerURL = dir.appendingPathComponent(Self.readyMarkerName)
            try spec.sha256.write(to: markerURL, atomically: true, encoding: .utf8)

            // Free temporary part files now that model.onnx is verified and ready
            for part in spec.parts {
                try? fm.removeItem(at: dir.appendingPathComponent(part.name))
                try? fm.removeItem(at: dir.appendingPathComponent(part.name + Self.partialSuffix))
            }

            // Clean up any older model version directories
            let root = storeRootDir()
            if let siblings = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
                for s in siblings where s.lastPathComponent != dir.lastPathComponent {
                    try? fm.removeItem(at: s)
                }
            }

            stateLock.lock()
            downloadedBytes = spec.bytes
            downloadError = nil
            stateLock.unlock()
        } catch PrecisionError.stopped {
            stateLock.lock()
            downloadError = nil
            stateLock.unlock()
        } catch PrecisionError.storageFull(let needed) {
            stateLock.lock()
            downloadError = "storage:\(needed)"
            stateLock.unlock()
        } catch PrecisionError.corrupt {
            stateLock.lock()
            downloadError = "corrupt"
            stateLock.unlock()
        } catch {
            stateLock.lock()
            downloadError = "network"
            stateLock.unlock()
        }
    }

    private func downloadPart(spec: Manifest, part: Part, dir: URL, completedBefore: Int64) throws {
        let fm = FileManager.default
        let partialURL = dir.appendingPathComponent(part.name + Self.partialSuffix)
        let doneURL = dir.appendingPathComponent(part.name)

        for _ in 0..<2 {
            if isStopRequested() { throw PrecisionError.stopped }
            if fileSize(at: partialURL) > part.bytes {
                try? fm.removeItem(at: partialURL)
            }
            if fileSize(at: partialURL) < part.bytes {
                try fetchPart(urlString: spec.baseUrl + part.name, partialURL: partialURL, part: part, completedBefore: completedBefore)
            }
            if fileSize(at: partialURL) == part.bytes,
               let actualHash = sha256Hex(of: partialURL),
               actualHash.lowercased() == part.sha256.lowercased() {
                try? fm.removeItem(at: doneURL)
                try fm.moveItem(at: partialURL, to: doneURL)
                return
            }
            try? fm.removeItem(at: partialURL)
            stateLock.lock()
            downloadedBytes = completedBefore
            stateLock.unlock()
        }
        throw PrecisionError.corrupt
    }

    private final class StreamDownloadDelegate: NSObject, URLSessionDataDelegate {
        let partialURL: URL
        let expectedBytes: Int64
        let completedBefore: Int64
        let isStopped: () -> Bool
        let onProgress: (Int64) -> Void
        let sem = DispatchSemaphore(value: 0)

        var fileHandle: FileHandle? = nil
        var written: Int64 = 0
        var errorResult: Error? = nil

        init(partialURL: URL, existing: Int64, expectedBytes: Int64, completedBefore: Int64,
             isStopped: @escaping () -> Bool, onProgress: @escaping (Int64) -> Void) {
            self.partialURL = partialURL
            self.written = existing
            self.expectedBytes = expectedBytes
            self.completedBefore = completedBefore
            self.isStopped = isStopped
            self.onProgress = onProgress
        }

        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            // Never accept an insecure HTTP downgrade redirect (matching Android)
            if request.url?.scheme?.lowercased() != "https" {
                errorResult = PrecisionError.network("insecure redirect")
                completionHandler(nil)
                return
            }
            completionHandler(request)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                        didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            guard let http = response as? HTTPURLResponse else {
                errorResult = PrecisionError.network("invalid response")
                completionHandler(.cancel)
                return
            }
            if http.url?.scheme?.lowercased() != "https" {
                errorResult = PrecisionError.network("insecure host")
                completionHandler(.cancel)
                return
            }
            if http.statusCode == 416 {
                completionHandler(.cancel)
                return
            }
            let append: Bool
            if http.statusCode == 206 && written > 0 {
                append = true
            } else if http.statusCode == 200 {
                append = false
            } else {
                errorResult = PrecisionError.network("HTTP \(http.statusCode)")
                completionHandler(.cancel)
                return
            }

            let fm = FileManager.default
            if !append {
                try? fm.removeItem(at: partialURL)
                fm.createFile(atPath: partialURL.path, contents: nil)
                written = 0
            } else if !fm.fileExists(atPath: partialURL.path) {
                fm.createFile(atPath: partialURL.path, contents: nil)
                written = 0
            }

            guard let fh = try? FileHandle(forWritingTo: partialURL) else {
                errorResult = PrecisionError.network("file open failed")
                completionHandler(.cancel)
                return
            }
            if append {
                _ = try? fh.seekToEnd()
            }
            self.fileHandle = fh
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            if isStopped() {
                errorResult = PrecisionError.stopped
                dataTask.cancel()
                return
            }
            if written + Int64(data.count) > expectedBytes {
                errorResult = PrecisionError.corrupt
                dataTask.cancel()
                return
            }
            fileHandle?.write(data)
            written += Int64(data.count)
            onProgress(completedBefore + written)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            try? fileHandle?.synchronize()
            try? fileHandle?.close()
            fileHandle = nil
            if errorResult == nil, let err = error {
                let ns = err as NSError
                if isStopped() || ns.code == NSURLErrorCancelled {
                    errorResult = isStopped() ? PrecisionError.stopped : nil
                } else {
                    errorResult = PrecisionError.network(err.localizedDescription)
                }
            }
            sem.signal()
        }
    }

    private func fetchPart(urlString: String, partialURL: URL, part: Part, completedBefore: Int64) throws {
        guard urlString.hasPrefix("https://"), let url = URL(string: urlString) else {
            throw PrecisionError.network("invalid url")
        }
        let existing = fileSize(at: partialURL)
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        req.setValue("PicShelf-iOS", forHTTPHeaderField: "User-Agent")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        if existing > 0 {
            req.setValue("bytes=\(existing)-", forHTTPHeaderField: "Range")
        }

        let delegate = StreamDownloadDelegate(
            partialURL: partialURL,
            existing: existing,
            expectedBytes: part.bytes,
            completedBefore: completedBefore,
            isStopped: { [weak self] in self?.isStopRequested() ?? true },
            onProgress: { [weak self] totalDone in
                guard let self = self else { return }
                self.stateLock.lock()
                self.downloadedBytes = totalDone
                self.stateLock.unlock()
                self.notifyDownload(force: false)
            }
        )
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 600
        let session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        let task = session.dataTask(with: req)
        stateLock.lock()
        activeDownloadTask = task
        stateLock.unlock()

        task.resume()
        delegate.sem.wait()

        stateLock.lock()
        if activeDownloadTask === task { activeDownloadTask = nil }
        stateLock.unlock()

        if let err = delegate.errorResult {
            throw err
        }
    }

    // MARK: - On-Device Precision Cutout Inference

    func segment(requestId: String, imageBase64: String) {
        stateLock.lock()
        activeRequestId = requestId
        let currentSession = ortSession
        stateLock.unlock()

        // A newer photo replaces the one being processed; abort the old run promptly (matching Android).
        currentSession?.terminateActiveRun()

        workerQueue.async { [weak self] in
            self?.processSegment(requestId: requestId, imageBase64: imageBase64)
        }
    }

    func cancel(requestId: String) {
        stateLock.lock()
        var sessionToCancel: PicShelfOrtSession? = nil
        if activeRequestId == requestId {
            activeRequestId = nil
            sessionToCancel = ortSession
        }
        stateLock.unlock()
        sessionToCancel?.terminateActiveRun()
    }

    private func isCurrentRequest(_ requestId: String) -> Bool {
        stateLock.lock()
        let match = (activeRequestId == requestId)
        stateLock.unlock()
        return match
    }

    private func scheduleIdleRelease() {
        idleReleaseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.releaseSession()
        }
        idleReleaseWork = work
        workerQueue.asyncAfter(deadline: .now() + Self.idleReleaseSeconds, execute: work)
    }

    private func releaseSession() {
        stateLock.lock()
        let old = ortSession
        ortSession = nil
        stateLock.unlock()
        old?.close()
    }

    private func sendResult(requestId: String, payload: [String: Any]) {
        var obj = payload
        obj["id"] = requestId
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(
                "window.PicShelfBackdropPrecision && window.PicShelfBackdropPrecision.onNative(\(json));",
                completionHandler: nil
            )
        }
    }

    private func processSegment(requestId: String, imageBase64: String) {
        idleReleaseWork?.cancel()
        let started = CACurrentMediaTime()
        var loadMs: Int64 = 0
        var inferenceMs: Int64 = 0

        defer { scheduleIdleRelease() }

        func timingDict() -> [String: Any] {
            return [
                "loadMs": loadMs,
                "inferenceMs": inferenceMs,
                "totalMs": Int64((CACurrentMediaTime() - started) * 1000)
            ]
        }

        do {
            guard isCurrentRequest(requestId) else { return }
            if let reason = availabilityReason() {
                throw PrecisionError.runtime(reason)
            }
            guard let spec = manifest else {
                throw PrecisionError.runtime("model unavailable")
            }
            guard isModelReady(spec) else {
                throw PrecisionError.runtime("model not downloaded")
            }

            let session: PicShelfOrtSession
            if let existing = ortSession {
                session = existing
            } else {
                let loadStart = CACurrentMediaTime()
                let threads = Int32(min(4, max(1, ProcessInfo.processInfo.activeProcessorCount)))
                let created = try PicShelfOrtSession(
                    modelPath: assembledModelURL(spec).path,
                    numThreads: threads
                )
                stateLock.lock()
                ortSession = created
                stateLock.unlock()
                session = created
                loadMs = Int64((CACurrentMediaTime() - loadStart) * 1000)
            }

            guard isCurrentRequest(requestId) else { return }
            let inputData = try decodeInputCHW(imageBase64: imageBase64, spec: spec)
            guard isCurrentRequest(requestId) else { return }

            let inferStart = CACurrentMediaTime()
            let matte = try session.runFloatCHWInput(
                inputData as Data,
                inputName: spec.input,
                outputName: spec.output,
                size: Int32(spec.size)
            )
            inferenceMs = Int64((CACurrentMediaTime() - inferStart) * 1000)
            guard isCurrentRequest(requestId) else { return }

            sendResult(requestId: requestId, payload: [
                "mask": matte.base64EncodedString(),
                "size": spec.size,
                "timing": timingDict()
            ])
        } catch {
            guard isCurrentRequest(requestId) else { return }
            sendResult(requestId: requestId, payload: [
                "error": error.localizedDescription,
                "timing": timingDict()
            ])
        }
    }

    private func decodeInputCHW(imageBase64: String, spec: Manifest) throws -> NSMutableData {
        let pureB64: String
        if let range = imageBase64.range(of: "base64,") {
            pureB64 = String(imageBase64[range.upperBound...])
        } else {
            pureB64 = imageBase64
        }
        guard let imgData = Data(base64Encoded: pureB64, options: .ignoreUnknownCharacters),
              let src = CGImageSourceCreateWithData(imgData as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw PrecisionError.runtime("Precision input image could not be read")
        }

        let size = spec.size
        let count = size * size
        var rgba = [UInt8](repeating: 0, count: count * 4)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        guard let ctx = CGContext(
            data: &rgba,
            width: size,
            height: size,
            bitsPerComponent: 8,
            bytesPerRow: size * 4,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else {
            throw PrecisionError.runtime("Could not allocate precision input canvas")
        }
        ctx.interpolationQuality = .high
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: size, height: size))

        // CHW Float32 with ImageNet normalization (identical to Android & transparent-background)
        let byteCount = count * 3 * MemoryLayout<Float>.size
        guard let outData = NSMutableData(length: byteCount) else {
            throw PrecisionError.runtime("Out of memory preparing precision input")
        }
        let floatPtr = outData.mutableBytes.assumingMemoryBound(to: Float.self)
        let scale0 = 1.0 / (255.0 * spec.std[0]), off0 = spec.mean[0] / spec.std[0]
        let scale1 = 1.0 / (255.0 * spec.std[1]), off1 = spec.mean[1] / spec.std[1]
        let scale2 = 1.0 / (255.0 * spec.std[2]), off2 = spec.mean[2] / spec.std[2]

        let plane1 = count
        let plane2 = count * 2
        rgba.withUnsafeBufferPointer { px in
            guard let base = px.baseAddress else { return }
            for i in 0..<count {
                let o = i * 4
                floatPtr[i] = Float(base[o]) * scale0 - off0
                floatPtr[plane1 + i] = Float(base[o + 1]) * scale1 - off1
                floatPtr[plane2 + i] = Float(base[o + 2]) * scale2 - off2
            }
        }
        return outData
    }

    // MARK: - Manifest Reader

    private static func readManifest() -> Manifest? {
        let candidates: [URL?] = [
            Bundle.main.url(forResource: "manifest", withExtension: "json", subdirectory: "web/models/backdrop_precision"),
            Bundle.main.url(forResource: "manifest", withExtension: "json", subdirectory: "models/backdrop_precision"),
            Bundle.main.resourceURL?.appendingPathComponent("web/models/backdrop_precision/manifest.json")
        ]
        guard let url = candidates.compactMap({ $0 }).first(where: { FileManager.default.fileExists(atPath: $0.path) }),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = (json["version"] as? NSNumber)?.intValue,
              let baseUrl = json["baseUrl"] as? String, baseUrl.hasPrefix("https://"),
              let totalBytes = (json["bytes"] as? NSNumber)?.int64Value, totalBytes > 0,
              let sha256 = json["sha256"] as? String, sha256.count == 64,
              let partsArr = json["parts"] as? [[String: Any]], !partsArr.isEmpty,
              let inputObj = json["input"] as? [String: Any],
              let inputName = inputObj["name"] as? String,
              let size = (inputObj["size"] as? NSNumber)?.intValue, size >= 64 && size <= 2048,
              let meanArr = inputObj["mean"] as? [NSNumber], meanArr.count == 3,
              let stdArr = inputObj["std"] as? [NSNumber], stdArr.count == 3,
              let outputName = json["output"] as? String else {
            return nil
        }

        let mean = meanArr.map { $0.floatValue }
        let std = stdArr.map { $0.floatValue }
        guard std.allSatisfy({ $0 > 0 }) else { return nil }

        var parts: [Part] = []
        var sumBytes: Int64 = 0
        for p in partsArr {
            guard let name = p["name"] as? String, !name.isEmpty, !name.contains("/"), !name.hasPrefix("."),
                  let b = (p["bytes"] as? NSNumber)?.int64Value, b > 0,
                  let h = (p["sha256"] as? String)?.lowercased(), h.count == 64 else {
                return nil
            }
            parts.append(Part(name: name, bytes: b, sha256: h))
            sumBytes += b
        }
        guard sumBytes == totalBytes else { return nil }

        return Manifest(
            version: version,
            baseUrl: baseUrl,
            parts: parts,
            bytes: totalBytes,
            sha256: sha256.lowercased(),
            size: size,
            mean: mean,
            std: std,
            input: inputName,
            output: outputName
        )
    }
}
