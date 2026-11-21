import Foundation
import UIKit
import WebKit
import ImageIO
import CryptoKit

/// On-device AI Object Removal for iOS using Picsart AI Research's MI-GAN 512 ONNX pipeline
/// (`migan_pipeline_v2.onnx`, ~28 MB, MIT) on Microsoft ONNX Runtime (`PicShelfOrtSession`).
/// Exact 1:1 parity with Android's `ObjectRemoverEngine.kt`.
final class PicShelfObjectRemoverManager {
    static let shared = PicShelfObjectRemoverManager()

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
        let maxDim: Int
        let imageInput: String
        let maskInput: String
        let output: String
    }

    private enum RemoveError: Error {
        case storageFull(Int64)
        case corrupt
        case stopped
        case network(String)
        case runtime(String)
    }

    private static let storeDirName = "object_remove"
    private static let readyMarkerName = "ready"
    private static let assembledModelName = "model.onnx"
    private static let partialSuffix = ".partial"
    private static let storageMargin: Int64 = 24 * 1024 * 1024
    private static let idleReleaseSeconds: TimeInterval = 120

    private let stateLock = NSLock()
    private let workerQueue = DispatchQueue(label: "com.picshelf.ios.object.remove", qos: .userInitiated)
    private let downloadQueue = DispatchQueue(label: "com.picshelf.ios.object.remove.dl", qos: .utility)

    private var downloading = false
    private var stopDownloadRequested = false
    private var downloadedBytes: Int64 = 0
    private var downloadError: String? = nil
    private var lastProgressAt: TimeInterval = 0
    private var activeDownloadTask: URLSessionDataTask? = nil

    private var activeRequestId: String? = nil
    private var idleReleaseWork: DispatchWorkItem? = nil
    private var ortSession: PicShelfOrtSession? = nil

    private lazy var manifest: Manifest? = Self.readManifest()

    private init() {}

    func isAvailable() -> Bool {
        return manifest != nil
    }

    func modelStatusJson() -> String {
        let spec = manifest
        let ready = spec != nil && isModelReady(spec!)
        stateLock.lock()
        let isDl = downloading
        let dlBytes = downloadedBytes
        let dlErr = downloadError
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

        var obj: [String: Any] = ["state": state, "downloaded": done, "total": total]
        obj["error"] = dlErr ?? NSNull()
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let str = String(data: data, encoding: .utf8) else {
            return "{\"state\":\"missing\",\"downloaded\":0,\"total\":0,\"error\":null}"
        }
        return str
    }

    private func notifyDownload(force: Bool = false) {
        let now = CACurrentMediaTime()
        stateLock.lock()
        if !force && (now - lastProgressAt) < 0.2 {
            stateLock.unlock()
            return
        }
        lastProgressAt = now
        stateLock.unlock()

        let json = modelStatusJson()
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(
                "window.PicShelfCreativeStudio && window.PicShelfCreativeStudio.onRemoveModelStatus && window.PicShelfCreativeStudio.onRemoveModelStatus(\(json));",
                completionHandler: nil
            )
        }
    }

    private func storeRootDir() -> URL {
        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent(Self.storeDirName, isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        var mut = dir
        try? mut.setResourceValues(rv)
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
        let marker = modelDir(spec).appendingPathComponent(Self.readyMarkerName)
        guard let txt = try? String(contentsOf: marker, encoding: .utf8),
              txt.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == spec.sha256 else {
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
            if fileSize(at: doneURL) == part.bytes { sum += part.bytes }
            else { sum += min(fileSize(at: dir.appendingPathComponent(part.name + Self.partialSuffix)), part.bytes) }
        }
        return sum
    }

    private func availableDiskBytes(at dir: URL) -> Int64 {
        if let vals = try? dir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let cap = vals.volumeAvailableCapacityForImportantUsage { return cap }
        return Int64.max / 2
    }

    private func sha256Hex(of fileURL: URL) -> String? {
        guard let fh = try? FileHandle(forReadingFrom: fileURL) else { return nil }
        defer { try? fh.close() }
        var hasher = SHA256()
        while true {
            var eof = false
            autoreleasepool {
                if let chunk = try? fh.read(upToCount: 262144), !chunk.isEmpty { hasher.update(data: chunk) }
                else { eof = true }
            }
            if eof { break }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    func startDownload() {
        guard let spec = manifest else { return }
        if isModelReady(spec) { notifyDownload(force: true); return }
        stateLock.lock()
        if downloading { stateLock.unlock(); return }
        downloading = true
        stopDownloadRequested = false
        downloadError = nil
        stateLock.unlock()

        notifyDownload(force: true)
        downloadQueue.async { [weak self] in self?.runDownload(spec) }
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
        let s = stopDownloadRequested
        stateLock.unlock()
        return s
    }

    private func runDownload(_ spec: Manifest) {
        let fm = FileManager.default
        let dir = modelDir(spec)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        defer {
            stateLock.lock()
            downloading = false
            stopDownloadRequested = false
            activeDownloadTask = nil
            stateLock.unlock()
            notifyDownload(force: true)
        }

        do {
            let initial = storedBytes(spec)
            stateLock.lock(); downloadedBytes = initial; stateLock.unlock()
            let needed = max(0, spec.bytes - initial) + spec.bytes + Self.storageMargin
            if availableDiskBytes(at: dir) < needed { throw RemoveError.storageFull(needed) }

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

            let tmpAssembled = dir.appendingPathComponent(Self.assembledModelName + Self.partialSuffix)
            try? fm.removeItem(at: tmpAssembled)
            fm.createFile(atPath: tmpAssembled.path, contents: nil)
            guard let outFH = try? FileHandle(forWritingTo: tmpAssembled) else {
                throw RemoveError.storageFull(spec.bytes)
            }
            var fullHasher = SHA256()
            var totalWritten: Int64 = 0
            for part in spec.parts {
                if isStopRequested() {
                    try? outFH.close(); try? fm.removeItem(at: tmpAssembled); throw RemoveError.stopped
                }
                guard let inFH = try? FileHandle(forReadingFrom: dir.appendingPathComponent(part.name)) else {
                    try? outFH.close(); try? fm.removeItem(at: tmpAssembled); throw RemoveError.corrupt
                }
                defer { try? inFH.close() }
                while true {
                    var eof = false
                    autoreleasepool {
                        if let chunk = try? inFH.read(upToCount: 262144), !chunk.isEmpty {
                            outFH.write(chunk)
                            fullHasher.update(data: chunk)
                            totalWritten += Int64(chunk.count)
                        } else { eof = true }
                    }
                    if eof { break }
                }
            }
            try? outFH.synchronize(); try? outFH.close()

            let finalHash = fullHasher.finalize().map { String(format: "%02x", $0) }.joined()
            guard totalWritten == spec.bytes && finalHash.lowercased() == spec.sha256 else {
                try? fm.removeItem(at: tmpAssembled)
                for p in spec.parts { try? fm.removeItem(at: dir.appendingPathComponent(p.name)) }
                throw RemoveError.corrupt
            }

            let finalURL = assembledModelURL(spec)
            try? fm.removeItem(at: finalURL)
            try fm.moveItem(at: tmpAssembled, to: finalURL)
            try spec.sha256.write(to: dir.appendingPathComponent(Self.readyMarkerName), atomically: true, encoding: .utf8)

            for p in spec.parts {
                try? fm.removeItem(at: dir.appendingPathComponent(p.name))
                try? fm.removeItem(at: dir.appendingPathComponent(p.name + Self.partialSuffix))
            }

            stateLock.lock(); downloadedBytes = spec.bytes; downloadError = nil; stateLock.unlock()
        } catch RemoveError.stopped {
            stateLock.lock(); downloadError = nil; stateLock.unlock()
        } catch RemoveError.storageFull(let needed) {
            stateLock.lock(); downloadError = "storage:\(needed)"; stateLock.unlock()
        } catch RemoveError.corrupt {
            stateLock.lock(); downloadError = "corrupt"; stateLock.unlock()
        } catch {
            stateLock.lock(); downloadError = "network"; stateLock.unlock()
        }
    }

    private func downloadPart(spec: Manifest, part: Part, dir: URL, completedBefore: Int64) throws {
        let fm = FileManager.default
        let partialURL = dir.appendingPathComponent(part.name + Self.partialSuffix)
        let doneURL = dir.appendingPathComponent(part.name)

        for _ in 0..<2 {
            if isStopRequested() { throw RemoveError.stopped }
            if fileSize(at: partialURL) > part.bytes { try? fm.removeItem(at: partialURL) }
            if fileSize(at: partialURL) < part.bytes {
                try fetchPart(urlString: spec.baseUrl + part.name, partialURL: partialURL, part: part, completedBefore: completedBefore)
            }
            if fileSize(at: partialURL) == part.bytes,
               let actual = sha256Hex(of: partialURL),
               actual.lowercased() == part.sha256 {
                try? fm.removeItem(at: doneURL)
                try fm.moveItem(at: partialURL, to: doneURL)
                return
            }
            try? fm.removeItem(at: partialURL)
            stateLock.lock(); downloadedBytes = completedBefore; stateLock.unlock()
        }
        throw RemoveError.corrupt
    }

    private final class StreamDelegate: NSObject, URLSessionDataDelegate {
        let partialURL: URL
        let expectedBytes: Int64
        let completedBefore: Int64
        let isStopped: () -> Bool
        let onProgress: (Int64) -> Void
        let sem = DispatchSemaphore(value: 0)
        var fh: FileHandle? = nil
        var written: Int64 = 0
        var err: Error? = nil

        init(partialURL: URL, existing: Int64, expectedBytes: Int64, completedBefore: Int64,
             isStopped: @escaping () -> Bool, onProgress: @escaping (Int64) -> Void) {
            self.partialURL = partialURL; self.written = existing; self.expectedBytes = expectedBytes
            self.completedBefore = completedBefore; self.isStopped = isStopped; self.onProgress = onProgress
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            if request.url?.scheme?.lowercased() != "https" {
                err = RemoveError.network("insecure redirect"); completionHandler(nil); return
            }
            completionHandler(request)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            guard let http = response as? HTTPURLResponse, http.url?.scheme?.lowercased() == "https" else {
                err = RemoveError.network("invalid response"); completionHandler(.cancel); return
            }
            if http.statusCode == 416 { completionHandler(.cancel); return }
            let append = (http.statusCode == 206 && written > 0)
            if !append && http.statusCode != 200 {
                err = RemoveError.network("HTTP \(http.statusCode)"); completionHandler(.cancel); return
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
            guard let handle = try? FileHandle(forWritingTo: partialURL) else {
                err = RemoveError.network("file open failed"); completionHandler(.cancel); return
            }
            if append { _ = try? handle.seekToEnd() }
            self.fh = handle
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            if isStopped() { err = RemoveError.stopped; dataTask.cancel(); return }
            if written + Int64(data.count) > expectedBytes { err = RemoveError.corrupt; dataTask.cancel(); return }
            fh?.write(data)
            written += Int64(data.count)
            onProgress(completedBefore + written)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            try? fh?.synchronize(); try? fh?.close(); fh = nil
            if err == nil, let e = error {
                let ns = e as NSError
                err = (isStopped() || ns.code == NSURLErrorCancelled) ? (isStopped() ? RemoveError.stopped : nil) : RemoveError.network(e.localizedDescription)
            }
            sem.signal()
        }
    }

    private func fetchPart(urlString: String, partialURL: URL, part: Part, completedBefore: Int64) throws {
        guard urlString.hasPrefix("https://"), let url = URL(string: urlString) else {
            throw RemoveError.network("invalid url")
        }
        let existing = fileSize(at: partialURL)
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        req.setValue("PicShelf-iOS", forHTTPHeaderField: "User-Agent")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        if existing > 0 { req.setValue("bytes=\(existing)-", forHTTPHeaderField: "Range") }

        let del = StreamDelegate(
            partialURL: partialURL, existing: existing, expectedBytes: part.bytes, completedBefore: completedBefore,
            isStopped: { [weak self] in self?.isStopRequested() ?? true },
            onProgress: { [weak self] done in
                guard let self = self else { return }
                self.stateLock.lock(); self.downloadedBytes = done; self.stateLock.unlock()
                self.notifyDownload(force: false)
            }
        )
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 600
        let session = URLSession(configuration: cfg, delegate: del, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        let task = session.dataTask(with: req)
        stateLock.lock(); activeDownloadTask = task; stateLock.unlock()
        task.resume()
        del.sem.wait()
        stateLock.lock(); if activeDownloadTask === task { activeDownloadTask = nil }; stateLock.unlock()
        if let e = del.err { throw e }
    }

    // MARK: - Inpainting Inference

    func inpaint(requestId: String, imageBase64: String, maskBase64: String) {
        stateLock.lock()
        activeRequestId = requestId
        let cur = ortSession
        stateLock.unlock()
        cur?.terminateActiveRun()

        workerQueue.async { [weak self] in
            self?.processInpaint(requestId: requestId, imageBase64: imageBase64, maskBase64: maskBase64)
        }
    }

    func cancel(requestId: String) {
        stateLock.lock()
        var s: PicShelfOrtSession? = nil
        if activeRequestId == requestId {
            activeRequestId = nil
            s = ortSession
        }
        stateLock.unlock()
        s?.terminateActiveRun()
    }

    private func isCurrent(_ id: String) -> Bool {
        stateLock.lock(); let ok = (activeRequestId == id); stateLock.unlock(); return ok
    }

    private func scheduleIdleRelease() {
        idleReleaseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.stateLock.lock()
            let old = self.ortSession
            self.ortSession = nil
            self.stateLock.unlock()
            old?.close()
        }
        idleReleaseWork = work
        workerQueue.asyncAfter(deadline: .now() + Self.idleReleaseSeconds, execute: work)
    }

    private func sendResult(requestId: String, payload: [String: Any]) {
        var obj = payload
        obj["id"] = requestId
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(
                "window.PicShelfCreativeStudio && window.PicShelfCreativeStudio.onRemoveResult && window.PicShelfCreativeStudio.onRemoveResult(\(json));",
                completionHandler: nil
            )
        }
    }

    private func decodeCGImage(_ b64: String) -> CGImage? {
        let pure = b64.range(of: "base64,").map { String(b64[$0.upperBound...]) } ?? b64
        guard let data = Data(base64Encoded: pure, options: .ignoreUnknownCharacters),
              let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
    }

    private func renderRGBA(_ cg: CGImage, w: Int, h: Int, highQuality: Bool) -> [UInt8]? {
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        let cs = CGColorSpaceCreateDeviceRGB()
        let info = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        guard let ctx = CGContext(data: &rgba, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs, bitmapInfo: info) else {
            return nil
        }
        ctx.interpolationQuality = highQuality ? .high : .none
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        return rgba
    }

    private func processInpaint(requestId: String, imageBase64: String, maskBase64: String) {
        idleReleaseWork?.cancel()
        let started = CACurrentMediaTime()
        var loadMs: Int64 = 0
        var inferMs: Int64 = 0
        defer { scheduleIdleRelease() }

        do {
            guard isCurrent(requestId) else { return }
            guard let spec = manifest else { throw RemoveError.runtime("AI eraser unavailable") }
            guard isModelReady(spec) else { throw RemoveError.runtime("AI eraser model not downloaded") }

            let session: PicShelfOrtSession
            if let existing = ortSession {
                session = existing
            } else {
                let t0 = CACurrentMediaTime()
                let threads = Int32(min(4, max(1, ProcessInfo.processInfo.activeProcessorCount)))
                let created = try PicShelfOrtSession(modelPath: assembledModelURL(spec).path, numThreads: threads)
                stateLock.lock(); ortSession = created; stateLock.unlock()
                session = created
                loadMs = Int64((CACurrentMediaTime() - t0) * 1000)
            }

            guard isCurrent(requestId) else { return }
            guard let imgCG = decodeCGImage(imageBase64), let maskCG = decodeCGImage(maskBase64) else {
                throw RemoveError.runtime("Could not decode input image or mask")
            }

            let scale = min(1.0, Double(spec.maxDim) / Double(max(imgCG.width, imgCG.height)))
            let w = max(64, Int((Double(imgCG.width) * scale).rounded()))
            let h = max(64, Int((Double(imgCG.height) * scale).rounded()))
            guard let imgRGBA = renderRGBA(imgCG, w: w, h: h, highQuality: true),
                  let maskRGBA = renderRGBA(maskCG, w: w, h: h, highQuality: false) else {
                throw RemoveError.runtime("Could not prepare input buffers")
            }

            let count = w * h
            var rgbCHW = Data(count: count * 3)
            var maskCHW = Data(count: count)
            rgbCHW.withUnsafeMutableBytes { dstRaw in
                let dst = dstRaw.bindMemory(to: UInt8.self)
                for i in 0..<count {
                    let o = i * 4
                    dst[i] = imgRGBA[o]
                    dst[count + i] = imgRGBA[o + 1]
                    dst[count * 2 + i] = imgRGBA[o + 2]
                }
            }
            maskCHW.withUnsafeMutableBytes { dstRaw in
                let dst = dstRaw.bindMemory(to: UInt8.self)
                for i in 0..<count {
                    let o = i * 4
                    let isHole = maskRGBA[o + 3] > 20 || maskRGBA[o] > 128
                    dst[i] = isHole ? 0 : 255
                }
            }

            guard isCurrent(requestId) else { return }
            let tInf = CACurrentMediaTime()
            let outCHW = try session.runMiganInpaintRGB(
                rgbCHW, mask: maskCHW,
                width: Int32(w), height: Int32(h),
                imageName: spec.imageInput, maskName: spec.maskInput, outputName: spec.output
            )
            inferMs = Int64((CACurrentMediaTime() - tInf) * 1000)
            guard isCurrent(requestId) else { return }

            var outRGBA = [UInt8](repeating: 255, count: count * 4)
            outCHW.withUnsafeBytes { srcRaw in
                let src = srcRaw.bindMemory(to: UInt8.self)
                for i in 0..<count {
                    let o = i * 4
                    outRGBA[o] = src[i]
                    outRGBA[o + 1] = src[count + i]
                    outRGBA[o + 2] = src[count * 2 + i]
                    outRGBA[o + 3] = 255
                }
            }
            let cs = CGColorSpaceCreateDeviceRGB()
            let info = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
            guard let ctx = CGContext(data: &outRGBA, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs, bitmapInfo: info),
                  let outCG = ctx.makeImage(),
                  let jpeg = UIImage(cgImage: outCG).jpegData(compressionQuality: 0.96) else {
                throw RemoveError.runtime("Could not encode AI eraser result")
            }

            let dataUrl = "data:image/jpeg;base64," + jpeg.base64EncodedString()
            sendResult(requestId: requestId, payload: [
                "dataUrl": dataUrl,
                "width": w,
                "height": h,
                "timing": [
                    "loadMs": loadMs,
                    "inferenceMs": inferMs,
                    "totalMs": Int64((CACurrentMediaTime() - started) * 1000)
                ]
            ])
        } catch {
            guard isCurrent(requestId) else { return }
            sendResult(requestId: requestId, payload: [
                "error": error.localizedDescription,
                "timing": [
                    "loadMs": loadMs,
                    "inferenceMs": inferMs,
                    "totalMs": Int64((CACurrentMediaTime() - started) * 1000)
                ]
            ])
        }
    }

    private static func readManifest() -> Manifest? {
        let candidates: [URL?] = [
            Bundle.main.url(forResource: "manifest", withExtension: "json", subdirectory: "web/models/object_remove"),
            Bundle.main.url(forResource: "manifest", withExtension: "json", subdirectory: "models/object_remove"),
            Bundle.main.resourceURL?.appendingPathComponent("web/models/object_remove/manifest.json")
        ]
        guard let url = candidates.compactMap({ $0 }).first(where: { FileManager.default.fileExists(atPath: $0.path) }),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = (json["version"] as? NSNumber)?.intValue,
              let baseUrl = json["baseUrl"] as? String, baseUrl.hasPrefix("https://"),
              let totalBytes = (json["bytes"] as? NSNumber)?.int64Value, totalBytes > 0,
              let sha256 = json["sha256"] as? String, sha256.count == 64,
              let partsArr = json["parts"] as? [[String: Any]], !partsArr.isEmpty,
              let inputs = json["inputs"] as? [String: Any],
              let imgName = inputs["image"] as? String,
              let maskName = inputs["mask"] as? String,
              let outputName = json["output"] as? String else { return nil }

        let maxDim = min(1600, max(256, (json["maxDim"] as? NSNumber)?.intValue ?? 1080))
        var parts: [Part] = []
        var sum: Int64 = 0
        for p in partsArr {
            guard let name = p["name"] as? String, !name.isEmpty, !name.contains("/"),
                  let b = (p["bytes"] as? NSNumber)?.int64Value, b > 0,
                  let h = (p["sha256"] as? String)?.lowercased(), h.count == 64 else { return nil }
            parts.append(Part(name: name, bytes: b, sha256: h))
            sum += b
        }
        guard sum == totalBytes else { return nil }
        return Manifest(version: version, baseUrl: baseUrl, parts: parts, bytes: totalBytes,
                        sha256: sha256.lowercased(), maxDim: maxDim,
                        imageInput: imgName, maskInput: maskName, output: outputName)
    }
}
