import UIKit
import WebKit
import UniformTypeIdentifiers
import Compression
import ImageIO
import AVFoundation
import PDFKit

// MARK: - Durable On-Disk Media Store for iOS (Photos, Videos, Audio, PDF, TAR, ZIP)

final class PicShelfMediaStore {
    static let shared = PicShelfMediaStore()

    let sourcesDir: URL
    let thumbsDir: URL
    private let ioLock = NSLock()
    private var activeImports: Set<String> = []

    private init() {
        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first!
        let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory

        sourcesDir = appSupport.appendingPathComponent("PicShelfSources", isDirectory: true)
        thumbsDir = caches.appendingPathComponent("PicShelfThumbs", isDirectory: true)

        try? fm.createDirectory(at: sourcesDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: thumbsDir, withIntermediateDirectories: true)

        // Prevent iCloud backup bloat on large local media caches
        var srcValues = URLResourceValues()
        srcValues.isExcludedFromBackup = true
        var mutableSrc = sourcesDir
        try? mutableSrc.setResourceValues(srcValues)
    }

    func sanitizeExtension(_ ext: String) -> String {
        let clean = ext.lowercased().filter { $0.isLetter || $0.isNumber }
        return clean.isEmpty ? "bin" : String(clean.prefix(12))
    }

    func sourceURL(for sourceId: String) -> URL? {
        let safeId = (sourceId as NSString).lastPathComponent
        guard !safeId.isEmpty, safeId == sourceId, !safeId.contains("..") else { return nil }
        return sourcesDir.appendingPathComponent(safeId)
    }

    func allSourceIds() -> [String] {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(atPath: sourcesDir.path) else { return [] }
        return items.filter { !$0.hasPrefix(".") }
    }

    func markImporting(_ sourceId: String) {
        ioLock.lock()
        activeImports.insert(sourceId)
        ioLock.unlock()
    }

    func unmarkImporting(_ sourceId: String) {
        ioLock.lock()
        activeImports.remove(sourceId)
        ioLock.unlock()
    }

    func retainSources(_ keepIds: Set<String>) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            let fm = FileManager.default
            guard let files = try? fm.contentsOfDirectory(atPath: self.sourcesDir.path) else { return }
            self.ioLock.lock()
            let protected = self.activeImports
            self.ioLock.unlock()
            for name in files {
                if !keepIds.contains(name) && !protected.contains(name) {
                    try? fm.removeItem(at: self.sourcesDir.appendingPathComponent(name))
                }
            }
        }
    }

    func storeFileByCopying(from tempURL: URL, ext: String) -> (sourceId: String, fileURL: URL, size: Int64)? {
        let safeExt = sanitizeExtension(ext)
        let sourceId = "\(UUID().uuidString.lowercased()).\(safeExt)"
        let dstURL = sourcesDir.appendingPathComponent(sourceId)
        markImporting(sourceId)
        do {
            if FileManager.default.fileExists(atPath: dstURL.path) {
                try FileManager.default.removeItem(at: dstURL)
            }
            try FileManager.default.copyItem(at: tempURL, to: dstURL)
            let attrs = try FileManager.default.attributesOfItem(atPath: dstURL.path)
            let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
            return (sourceId, dstURL, size)
        } catch {
            unmarkImporting(sourceId)
            return nil
        }
    }

    func storeData(_ data: Data, ext: String) -> (sourceId: String, fileURL: URL, size: Int64)? {
        let safeExt = sanitizeExtension(ext)
        let sourceId = "\(UUID().uuidString.lowercased()).\(safeExt)"
        let dstURL = sourcesDir.appendingPathComponent(sourceId)
        markImporting(sourceId)
        do {
            try data.write(to: dstURL, options: .atomic)
            return (sourceId, dstURL, Int64(data.count))
        } catch {
            unmarkImporting(sourceId)
            return nil
        }
    }

    // MARK: - Raw DEFLATE & GZIP Decompression (Apple Compression framework)

    func inflateRawDeflate(_ compressed: Data, expectedSize: Int = 0) -> Data? {
        guard !compressed.isEmpty else { return Data() }
        let streamPtr = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { streamPtr.deallocate() }

        let status = compression_stream_init(streamPtr, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)
        guard status != COMPRESSION_STATUS_ERROR else { return nil }
        defer { compression_stream_destroy(streamPtr) }

        let chunkSize = 65536
        let dstBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
        defer { dstBuffer.deallocate() }

        var output = Data()
        if expectedSize > 0 && expectedSize < 128 * 1024 * 1024 {
            output.reserveCapacity(expectedSize)
        }

        return compressed.withUnsafeBytes { (rawBuf: UnsafeRawBufferPointer) -> Data? in
            guard let srcBase = rawBuf.bindMemory(to: UInt8.self).baseAddress else { return nil }
            streamPtr.pointee.src_ptr = srcBase
            streamPtr.pointee.src_size = compressed.count

            while true {
                streamPtr.pointee.dst_ptr = dstBuffer
                streamPtr.pointee.dst_size = chunkSize
                let res = compression_stream_process(streamPtr, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                let produced = chunkSize - streamPtr.pointee.dst_size
                if produced > 0 {
                    output.append(dstBuffer, count: produced)
                }
                if res == COMPRESSION_STATUS_END {
                    return output
                } else if res == COMPRESSION_STATUS_ERROR {
                    return nil
                } else if produced == 0 && streamPtr.pointee.src_size == 0 {
                    return output
                }
            }
        }
    }

    func decompressGzipFile(from srcURL: URL, to dstURL: URL) -> Int64? {
        guard let inHandle = try? FileHandle(forReadingFrom: srcURL) else { return nil }
        defer { try? inHandle.close() }

        // Parse RFC 1952 GZIP header
        guard let hdr = try? inHandle.read(upToCount: 10), hdr.count == 10 else { return nil }
        guard hdr[0] == 0x1f && hdr[1] == 0x8b && hdr[2] == 0x08 else { return nil }
        let flags = hdr[3]

        func readExact(_ n: Int) -> Data? {
            guard let d = try? inHandle.read(upToCount: n), d.count == n else { return nil }
            return d
        }
        func skipZeroTerminated() -> Bool {
            while let b = try? inHandle.read(upToCount: 1), b.count == 1 {
                if b[0] == 0 { return true }
            }
            return false
        }

        if (flags & 0x04) != 0 { // FEXTRA
            guard let xlenData = readExact(2) else { return nil }
            let xlen = Int(xlenData[0]) | (Int(xlenData[1]) << 8)
            guard readExact(xlen) != nil else { return nil }
        }
        if (flags & 0x08) != 0 { // FNAME
            guard skipZeroTerminated() else { return nil }
        }
        if (flags & 0x10) != 0 { // FCOMMENT
            guard skipZeroTerminated() else { return nil }
        }
        if (flags & 0x02) != 0 { // FHCRC
            guard readExact(2) != nil else { return nil }
        }

        FileManager.default.createFile(atPath: dstURL.path, contents: nil)
        guard let outHandle = try? FileHandle(forWritingTo: dstURL) else { return nil }
        defer { try? outHandle.close() }

        let streamPtr = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { streamPtr.deallocate() }
        guard compression_stream_init(streamPtr, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) != COMPRESSION_STATUS_ERROR else {
            return nil
        }
        defer { compression_stream_destroy(streamPtr) }

        let bufSize = 65536
        let dstBuf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
        defer { dstBuf.deallocate() }

        var totalWritten: Int64 = 0
        while true {
            guard let inChunk = try? inHandle.read(upToCount: bufSize) else { break }
            let isEOF = inChunk.isEmpty
            let processResult: compression_status = inChunk.withUnsafeBytes { rawBuf in
                if let ptr = rawBuf.bindMemory(to: UInt8.self).baseAddress {
                    streamPtr.pointee.src_ptr = ptr
                    streamPtr.pointee.src_size = inChunk.count
                } else {
                    streamPtr.pointee.src_size = 0
                }
                var lastStatus = COMPRESSION_STATUS_OK
                while true {
                    streamPtr.pointee.dst_ptr = dstBuf
                    streamPtr.pointee.dst_size = bufSize
                    let flag = isEOF ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
                    lastStatus = compression_stream_process(streamPtr, flag)
                    let produced = bufSize - streamPtr.pointee.dst_size
                    if produced > 0 {
                        let outData = Data(bytesNoCopy: dstBuf, count: produced, deallocator: .none)
                        outHandle.write(outData)
                        totalWritten += Int64(produced)
                    }
                    if lastStatus == COMPRESSION_STATUS_END || lastStatus == COMPRESSION_STATUS_ERROR {
                        break
                    }
                    if streamPtr.pointee.src_size == 0 && produced < bufSize {
                        break
                    }
                }
                return lastStatus
            }
            if processResult == COMPRESSION_STATUS_END {
                return totalWritten
            }
            if processResult == COMPRESSION_STATUS_ERROR || isEOF {
                return totalWritten > 0 ? totalWritten : nil
            }
        }
        return totalWritten > 0 ? totalWritten : nil
    }

    // MARK: - Entry Locator & Reader (for TAR & ZIP entries)

    func resolveZipDataOffset(fileHandle: FileHandle, localOffset: UInt64) -> UInt64? {
        do {
            try fileHandle.seek(toOffset: localOffset)
            guard let hdr = try fileHandle.read(upToCount: 30), hdr.count == 30 else { return nil }
            let sig = UInt32(hdr[0]) | (UInt32(hdr[1]) << 8) | (UInt32(hdr[2]) << 16) | (UInt32(hdr[3]) << 24)
            guard sig == 0x04034b50 else { return nil }
            let fnLen = UInt64(UInt16(hdr[26]) | (UInt16(hdr[27]) << 8))
            let extraLen = UInt64(UInt16(hdr[28]) | (UInt16(hdr[29]) << 8))
            return localOffset + 30 + fnLen + extraLen
        } catch {
            return nil
        }
    }

    func extractEntryToData(sourceId: String, kind: String, offset: UInt64, size: UInt64, method: Int, maxBytes: UInt64 = 128 * 1024 * 1024) -> Data? {
        guard let url = sourceURL(for: sourceId),
              let fh = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? fh.close() }

        let readSize = min(size, maxBytes)
        if kind == "tar" {
            do {
                try fh.seek(toOffset: offset)
                return try fh.read(upToCount: Int(readSize))
            } catch {
                return nil
            }
        } else if kind == "zip" {
            guard let dataStart = resolveZipDataOffset(fileHandle: fh, localOffset: offset) else { return nil }
            do {
                try fh.seek(toOffset: dataStart)
                guard let raw = try fh.read(upToCount: Int(readSize)) else { return nil }
                if method == 0 {
                    return raw
                } else if method == 8 {
                    return inflateRawDeflate(raw)
                }
            } catch {
                return nil
            }
        }
        return nil
    }

    func extractEntryToTempFile(sourceId: String, kind: String, offset: UInt64, size: UInt64, method: Int, ext: String) -> (url: URL, isTemporary: Bool)? {
        guard let srcURL = sourceURL(for: sourceId) else { return nil }
        // Fast zero-copy path for whole standalone files stored as tar offset=0
        if kind == "tar" && offset == 0 {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: srcURL.path),
               let fileSize = (attrs[.size] as? NSNumber)?.uint64Value,
               fileSize == size {
                return (srcURL, false)
            }
        }
        let safeExt = sanitizeExtension(ext)
        let tmpURL = FileManager.default.temporaryDirectory.appendingPathComponent("ps_slice_\(UUID().uuidString).\(safeExt)")
        if kind == "zip" && method == 8 {
            guard let data = extractEntryToData(sourceId: sourceId, kind: kind, offset: offset, size: size, method: method, maxBytes: 512 * 1024 * 1024) else {
                return nil
            }
            do {
                try data.write(to: tmpURL)
                return (tmpURL, true)
            } catch {
                return nil
            }
        }
        // Stream slice directly to temp file in 256KB chunks (zero RAM spike)
        guard let inHandle = try? FileHandle(forReadingFrom: srcURL) else { return nil }
        defer { try? inHandle.close() }
        var startOffset = offset
        if kind == "zip" {
            guard let resolved = resolveZipDataOffset(fileHandle: inHandle, localOffset: offset) else { return nil }
            startOffset = resolved
        }
        FileManager.default.createFile(atPath: tmpURL.path, contents: nil)
        guard let outHandle = try? FileHandle(forWritingTo: tmpURL) else { return nil }
        defer { try? outHandle.close() }
        do {
            try inHandle.seek(toOffset: startOffset)
            var remaining = size
            while remaining > 0 {
                let toRead = Int(min(remaining, 262144))
                guard let chunk = try inHandle.read(upToCount: toRead), !chunk.isEmpty else { break }
                outHandle.write(chunk)
                remaining -= UInt64(chunk.count)
            }
            return (tmpURL, true)
        } catch {
            try? FileManager.default.removeItem(at: tmpURL)
            return nil
        }
    }

    // MARK: - Media Format Classification & Metadata Helpers

    static func mediaCategory(for filename: String) -> String? {
        let ext = (filename as NSString).pathExtension.lowercased()
        switch ext {
        case "jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff", "dng", "pdf":
            return "image"
        case "mp4", "mov", "m4v", "webm", "mkv", "3gp", "avi", "flv", "wmv", "ts":
            return "video"
        case "mp3", "wav", "m4a", "aac", "ogg", "flac", "wma", "opus", "mid", "midi":
            return "audio"
        default:
            return nil
        }
    }

    static func mimeType(for filename: String) -> String {
        let ext = (filename as NSString).pathExtension.lowercased()
        switch ext {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "bmp": return "image/bmp"
        case "avif": return "image/avif"
        case "heic": return "image/heic"
        case "heif": return "image/heif"
        case "pdf": return "application/pdf"
        case "mp4": return "video/mp4"
        case "mov": return "video/quicktime"
        case "m4v": return "video/x-m4v"
        case "webm": return "video/webm"
        case "mkv": return "video/x-matroska"
        case "3gp": return "video/3gpp"
        case "avi": return "video/x-msvideo"
        case "flv": return "video/x-flv"
        case "wmv": return "video/x-ms-wmv"
        case "ts": return "video/mp2t"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "m4a": return "audio/mp4"
        case "aac": return "audio/aac"
        case "ogg": return "audio/ogg"
        case "flac": return "audio/flac"
        case "wma": return "audio/x-ms-wma"
        case "opus": return "audio/opus"
        default: return "application/octet-stream"
        }
    }

    static func extractImageMetadata(from source: CGImageSource, includeGps: Bool) -> (location: [String: Any]?, createdAt: Double?, cameraModel: String?) {
        guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            return (nil, nil, nil)
        }
        var dateTakenMs: Double? = nil
        var cameraModel: String? = nil
        var locDict: [String: Any]? = nil

        if let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any],
           let dateStr = (exif[kCGImagePropertyExifDateTimeOriginal] as? String) ?? (exif[kCGImagePropertyExifDateTimeDigitized] as? String) {
            let fmt = DateFormatter()
            fmt.locale = Locale(identifier: "en_US_POSIX")
            fmt.dateFormat = "yyyy:MM:dd HH:mm:ss"
            if let date = fmt.date(from: dateStr) {
                dateTakenMs = date.timeIntervalSince1970 * 1000.0
            }
        }
        if let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            let make = (tiff[kCGImagePropertyTIFFMake] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let model = (tiff[kCGImagePropertyTIFFModel] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !model.isEmpty {
                cameraModel = (!make.isEmpty && !model.lowercased().hasPrefix(make.lowercased())) ? "\(make) \(model)" : model
            } else if !make.isEmpty {
                cameraModel = make
            }
        }
        if includeGps, let gps = props[kCGImagePropertyGPSDictionary] as? [CFString: Any],
           let latVal = gps[kCGImagePropertyGPSLatitude] as? Double,
           let latRef = gps[kCGImagePropertyGPSLatitudeRef] as? String,
           let lonVal = gps[kCGImagePropertyGPSLongitude] as? Double,
           let lonRef = gps[kCGImagePropertyGPSLongitudeRef] as? String {
            let lat = (latRef.uppercased() == "S") ? -abs(latVal) : abs(latVal)
            let lon = (lonRef.uppercased() == "W") ? -abs(lonVal) : abs(lonVal)
            if abs(lat) <= 90 && abs(lon) <= 180 {
                let displayCoords = String(format: "%.4f° %@, %.4f° %@", abs(lat), lat >= 0 ? "N" : "S", abs(lon), lon >= 0 ? "E" : "W")
                locDict = [
                    "latitude": lat,
                    "longitude": lon,
                    "displayCoords": displayCoords,
                    "place": "",
                    "city": "",
                    "country": ""
                ]
            }
        }
        return (locDict, dateTakenMs, cameraModel)
    }

    static func extractVideoMetadata(from fileURL: URL, includeGps: Bool) -> (duration: Double, location: [String: Any]?, createdAt: Double?, cameraModel: String?) {
        let asset = AVURLAsset(url: fileURL)
        let durSec = CMTimeGetSeconds(asset.duration)
        let duration = (durSec.isFinite && durSec > 0) ? durSec : 0

        var createdAt: Double? = nil
        var cameraModel: String? = nil
        var locDict: [String: Any]? = nil

        if let creationDate = asset.creationDate?.dateValue {
            createdAt = creationDate.timeIntervalSince1970 * 1000.0
        }

        let commonMeta = asset.commonMetadata
        var make = ""
        var model = ""
        for item in commonMeta {
            if item.commonKey == .commonKeyMake, let s = item.stringValue {
                make = s.trimmingCharacters(in: .whitespacesAndNewlines)
            } else if item.commonKey == .commonKeyModel, let s = item.stringValue {
                model = s.trimmingCharacters(in: .whitespacesAndNewlines)
            } else if includeGps && item.commonKey == .commonKeyLocation, let iso = item.stringValue {
                // ISO 6709 string e.g. "+43.6532-079.3832+076.0/"
                if let parsed = parseISO6709(iso) {
                    let displayCoords = String(format: "%.4f° %@, %.4f° %@", abs(parsed.lat), parsed.lat >= 0 ? "N" : "S", abs(parsed.lon), parsed.lon >= 0 ? "E" : "W")
                    locDict = [
                        "latitude": parsed.lat,
                        "longitude": parsed.lon,
                        "displayCoords": displayCoords,
                        "place": "",
                        "city": "",
                        "country": ""
                    ]
                }
            }
        }
        if !model.isEmpty {
            cameraModel = (!make.isEmpty && !model.lowercased().hasPrefix(make.lowercased())) ? "\(make) \(model)" : model
        } else if !make.isEmpty {
            cameraModel = make
        }
        return (duration, locDict, createdAt, cameraModel)
    }

    static func parseISO6709(_ str: String) -> (lat: Double, lon: Double)? {
        let pattern = #"([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: str, range: NSRange(str.startIndex..., in: str)),
              let r1 = Range(match.range(at: 1), in: str),
              let r2 = Range(match.range(at: 2), in: str),
              let lat = Double(str[r1]),
              let lon = Double(str[r2]),
              abs(lat) <= 90, abs(lon) <= 180 else { return nil }
        return (lat, lon)
    }

    static func renderPDFPage1JPEG(from pdfURL: URL, maxWidth: CGFloat = 1200) -> Data? {
        guard let doc = PDFDocument(url: pdfURL), let page = doc.page(at: 0) else { return nil }
        let bounds = page.bounds(for: .mediaBox)
        guard bounds.width > 0 && bounds.height > 0 else { return nil }
        let scale = min(maxWidth / bounds.width, 2.0)
        let targetSize = CGSize(width: max(200, round(bounds.width * scale)), height: max(200, round(bounds.height * scale)))
        let renderer = UIGraphicsImageRenderer(size: targetSize)
        let img = renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: targetSize))
            ctx.cgContext.translateBy(x: 0, y: targetSize.height)
            ctx.cgContext.scaleBy(x: targetSize.width / bounds.width, y: -targetSize.height / bounds.height)
            page.draw(with: .mediaBox, to: ctx.cgContext)
        }
        return img.jpegData(compressionQuality: 0.88)
    }

    static func generateVideoFrame(from videoURL: URL, timeSeconds: Double?, maxDimension: CGFloat = 540) -> (jpeg: Data, width: Int, height: Int, duration: Double)? {
        let asset = AVURLAsset(url: videoURL)
        let durSec = CMTimeGetSeconds(asset.duration)
        let duration = (durSec.isFinite && durSec > 0) ? durSec : 0

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxDimension, height: maxDimension)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)

        let seekSec: Double
        if let explicit = timeSeconds, explicit.isFinite && explicit >= 0 {
            seekSec = duration > 0 ? min(explicit, max(0, duration - 0.05)) : explicit
        } else {
            seekSec = duration > 0 ? min(0.5, duration / 2.0) : 0.0
        }
        let targetTime = CMTime(seconds: seekSec, preferredTimescale: 600)

        var cgImage = try? generator.copyCGImage(at: targetTime, actualTime: nil)
        if cgImage == nil && seekSec > 0 {
            cgImage = try? generator.copyCGImage(at: .zero, actualTime: nil)
        }
        guard let frame = cgImage else { return nil }
        let uiImage = UIImage(cgImage: frame)
        guard let jpeg = uiImage.jpegData(compressionQuality: 0.82) else { return nil }
        return (jpeg, frame.width, frame.height, duration)
    }

    static func generateImageThumbnailJPEG(from data: Data, maxPixelSize: Int = 512) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
        ]
        guard let cgThumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cgThumb).jpegData(compressionQuality: 0.85)
    }

    static func generateImageThumbnailJPEG(from url: URL, maxPixelSize: Int = 512) -> Data? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
        ]
        guard let cgThumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cgThumb).jpegData(compressionQuality: 0.85)
    }
}

// MARK: - Safe WKURLSchemeTask Stop-Guarded Dispatcher

class SafeSchemeHandlerBase: NSObject, WKURLSchemeHandler {
    private let stateLock = NSLock()
    private var stoppedTasks = Set<ObjectIdentifier>()
    let workQueue: DispatchQueue

    init(label: String) {
        self.workQueue = DispatchQueue(label: label, qos: .userInitiated, attributes: .concurrent)
        super.init()
    }

    func markActive(_ task: WKURLSchemeTask) {
        stateLock.lock()
        stoppedTasks.remove(ObjectIdentifier(task))
        stateLock.unlock()
    }

    func isStopped(_ task: WKURLSchemeTask) -> Bool {
        stateLock.lock()
        let stopped = stoppedTasks.contains(ObjectIdentifier(task))
        stateLock.unlock()
        return stopped
    }

    func safeSendResponse(_ task: WKURLSchemeTask, response: URLResponse) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        if stoppedTasks.contains(ObjectIdentifier(task)) { return false }
        task.didReceive(response)
        return true
    }

    func safeSendData(_ task: WKURLSchemeTask, data: Data) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        if stoppedTasks.contains(ObjectIdentifier(task)) { return false }
        task.didReceive(data)
        return true
    }

    func safeFinish(_ task: WKURLSchemeTask) {
        stateLock.lock()
        defer { stateLock.unlock() }
        let id = ObjectIdentifier(task)
        if stoppedTasks.contains(id) { return }
        stoppedTasks.insert(id)
        task.didFinish()
    }

    func safeFail(_ task: WKURLSchemeTask, error: Error) {
        stateLock.lock()
        defer { stateLock.unlock() }
        let id = ObjectIdentifier(task)
        if stoppedTasks.contains(id) { return }
        stoppedTasks.insert(id)
        task.didFailWithError(error)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {}

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stateLock.lock()
        stoppedTasks.insert(ObjectIdentifier(urlSchemeTask))
        stateLock.unlock()
    }
}

// MARK: - Originals Scheme Handler (picshelf-originals://local/<token>/<kind>/<offset>/<size>/<method>)

final class PicShelfOriginalsSchemeHandler: SafeSchemeHandlerBase {
    init() {
        super.init(label: "com.picshelf.ios.originals")
    }

    override func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        markActive(urlSchemeTask)
        guard let url = urlSchemeTask.request.url else {
            safeFail(urlSchemeTask, error: URLError(.badURL))
            return
        }
        let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range")

        workQueue.async { [weak self] in
            guard let self = self, !self.isStopped(urlSchemeTask) else { return }
            self.handleOriginalsRequest(url: url, rangeHeader: rangeHeader, task: urlSchemeTask)
        }
    }

    private func handleOriginalsRequest(url: URL, rangeHeader: String?, task: WKURLSchemeTask) {
        let parts = url.pathComponents.filter { $0 != "/" }
        // Expected: [token, kind, offset, size, method]
        guard parts.count >= 5,
              let token = parts[0].removingPercentEncoding,
              let offset = UInt64(parts[2]),
              let size = UInt64(parts[3]),
              let method = Int(parts[4]),
              let fileURL = PicShelfMediaStore.shared.sourceURL(for: token),
              FileManager.default.fileExists(atPath: fileURL.path) else {
            safeFail(task, error: URLError(.fileDoesNotExist))
            return
        }
        let kind = parts[1].lowercased()
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let mime = comps?.queryItems?.first(where: { $0.name == "type" })?.value ?? PicShelfMediaStore.mimeType(for: token)

        // ZIP DEFLATE (method == 8): inflate full entry then serve requested range
        if kind == "zip" && method == 8 {
            guard let inflated = PicShelfMediaStore.shared.extractEntryToData(sourceId: token, kind: "zip", offset: offset, size: size, method: 8, maxBytes: 256 * 1024 * 1024) else {
                safeFail(task, error: URLError(.cannotDecodeRawData))
                return
            }
            serveInMemoryData(inflated, url: url, mime: mime, rangeHeader: rangeHeader, task: task)
            return
        }

        // Streaming FileHandle path for TAR slices and ZIP STORED (method == 0)
        guard let fh = try? FileHandle(forReadingFrom: fileURL) else {
            safeFail(task, error: URLError(.cannotOpenFile))
            return
        }
        defer { try? fh.close() }

        var dataStart = offset
        if kind == "zip" {
            guard let resolved = PicShelfMediaStore.shared.resolveZipDataOffset(fileHandle: fh, localOffset: offset) else {
                safeFail(task, error: URLError(.cannotDecodeRawData))
                return
            }
            dataStart = resolved
        }

        let totalLength = size
        var reqStart: UInt64 = 0
        var reqEnd: UInt64 = totalLength > 0 ? totalLength - 1 : 0
        var isRange = false

        if let rangeHeader = rangeHeader, let parsed = parseByteRange(rangeHeader, totalLength: totalLength) {
            reqStart = parsed.start
            reqEnd = parsed.end
            isRange = true
        }

        let contentLength = totalLength > 0 ? (reqEnd - reqStart + 1) : 0
        var headers: [String: String] = [
            "Content-Type": mime,
            "Content-Length": "\(contentLength)",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "private, max-age=3600"
        ]
        if isRange {
            headers["Content-Range"] = "bytes \(reqStart)-\(reqEnd)/\(totalLength)"
        }

        guard let response = HTTPURLResponse(url: url, statusCode: isRange ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            safeFail(task, error: URLError(.cannotParseResponse))
            return
        }
        guard safeSendResponse(task, response: response) else { return }

        if contentLength == 0 {
            safeFinish(task)
            return
        }

        do {
            try fh.seek(toOffset: dataStart + reqStart)
            var remaining = contentLength
            let chunkBytes: UInt64 = 262144
            while remaining > 0 {
                if isStopped(task) { return }
                let toRead = Int(min(remaining, chunkBytes))
                guard let chunk = try fh.read(upToCount: toRead), !chunk.isEmpty else { break }
                if !safeSendData(task, data: chunk) { return }
                remaining -= UInt64(chunk.count)
            }
            safeFinish(task)
        } catch {
            safeFail(task, error: error)
        }
    }

    private func serveInMemoryData(_ data: Data, url: URL, mime: String, rangeHeader: String?, task: WKURLSchemeTask) {
        let total = UInt64(data.count)
        var start: UInt64 = 0
        var end: UInt64 = total > 0 ? total - 1 : 0
        var isRange = false
        if let rh = rangeHeader, let parsed = parseByteRange(rh, totalLength: total) {
            start = parsed.start
            end = parsed.end
            isRange = true
        }
        let slice = total > 0 ? data.subdata(in: Int(start)..<Int(end + 1)) : Data()
        var headers: [String: String] = [
            "Content-Type": mime,
            "Content-Length": "\(slice.count)",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "private, max-age=3600"
        ]
        if isRange {
            headers["Content-Range"] = "bytes \(start)-\(end)/\(total)"
        }
        guard let response = HTTPURLResponse(url: url, statusCode: isRange ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            safeFail(task, error: URLError(.cannotParseResponse))
            return
        }
        guard safeSendResponse(task, response: response) else { return }
        if !slice.isEmpty {
            guard safeSendData(task, data: slice) else { return }
        }
        safeFinish(task)
    }

    private func parseByteRange(_ header: String, totalLength: UInt64) -> (start: UInt64, end: UInt64)? {
        guard totalLength > 0 else { return nil }
        let trimmed = header.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("bytes=") else { return nil }
        let spec = String(trimmed.dropFirst(6)).split(separator: ",").first.map(String.init) ?? ""
        let bounds = spec.split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2 else { return nil }
        let startStr = String(bounds[0]).trimmingCharacters(in: .whitespaces)
        let endStr = String(bounds[1]).trimmingCharacters(in: .whitespaces)
        if startStr.isEmpty {
            guard let suffix = UInt64(endStr), suffix > 0 else { return nil }
            let start = suffix >= totalLength ? 0 : (totalLength - suffix)
            return (start, totalLength - 1)
        }
        guard let start = UInt64(startStr), start < totalLength else { return nil }
        let end: UInt64
        if endStr.isEmpty {
            end = totalLength - 1
        } else if let parsedEnd = UInt64(endStr) {
            end = min(parsedEnd, totalLength - 1)
        } else {
            return nil
        }
        guard end >= start else { return nil }
        return (start, end)
    }
}

// MARK: - Thumbnails, Video Posters, Resize Frames & Metadata Scheme Handler (picshelf-thumbnails://local/...)

final class PicShelfThumbnailsSchemeHandler: SafeSchemeHandlerBase {
    init() {
        super.init(label: "com.picshelf.ios.thumbnails")
    }

    override func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        markActive(urlSchemeTask)
        guard let url = urlSchemeTask.request.url else {
            safeFail(urlSchemeTask, error: URLError(.badURL))
            return
        }

        workQueue.async { [weak self] in
            guard let self = self, !self.isStopped(urlSchemeTask) else { return }
            self.handleRequest(url: url, task: urlSchemeTask)
        }
    }

    private func sendBinary(_ data: Data, mime: String, url: URL, task: WKURLSchemeTask) {
        let headers: [String: String] = [
            "Content-Type": mime,
            "Content-Length": "\(data.count)",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400"
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            safeFail(task, error: URLError(.cannotParseResponse))
            return
        }
        guard safeSendResponse(task, response: response) else { return }
        guard safeSendData(task, data: data) else { return }
        safeFinish(task)
    }

    private func sendJSON(_ obj: [String: Any], url: URL, task: WKURLSchemeTask) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
            safeFail(task, error: URLError(.cannotParseResponse))
            return
        }
        sendBinary(data, mime: "application/json", url: url, task: task)
    }

    private func handleRequest(url: URL, task: WKURLSchemeTask) {
        let parts = url.pathComponents.filter { $0 != "/" }
        // Expected: [token, mode, offset, size, method]
        guard parts.count >= 5,
              let token = parts[0].removingPercentEncoding,
              let offset = UInt64(parts[2]),
              let size = UInt64(parts[3]),
              let method = Int(parts[4]),
              let srcURL = PicShelfMediaStore.shared.sourceURL(for: token),
              FileManager.default.fileExists(atPath: srcURL.path) else {
            safeFail(task, error: URLError(.fileDoesNotExist))
            return
        }

        let mode = parts[1].lowercased()
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)

        // 1. Video poster + duration JSON
        if mode == "video-tar" || mode == "video-zip" {
            let kind = mode == "video-zip" ? "zip" : "tar"
            let ext = (token as NSString).pathExtension.isEmpty ? "mp4" : (token as NSString).pathExtension
            guard let extracted = PicShelfMediaStore.shared.extractEntryToTempFile(sourceId: token, kind: kind, offset: offset, size: size, method: method, ext: ext) else {
                safeFail(task, error: URLError(.cannotDecodeRawData))
                return
            }
            defer { if extracted.isTemporary { try? FileManager.default.removeItem(at: extracted.url) } }
            if let frame = PicShelfMediaStore.generateVideoFrame(from: extracted.url, timeSeconds: nil, maxDimension: 540) {
                let poster = "data:image/jpeg;base64," + frame.jpeg.base64EncodedString()
                sendJSON(["poster": poster, "duration": frame.duration, "width": frame.width, "height": frame.height], url: url, task: task)
            } else {
                let meta = PicShelfMediaStore.extractVideoMetadata(from: extracted.url, includeGps: false)
                sendJSON(["duration": meta.duration], url: url, task: task)
            }
            return
        }

        // 2. Video resize/crop single frame JSON at ?timeUs=...
        if mode == "resize-frame-tar" || mode == "resize-frame-zip" {
            let kind = mode == "resize-frame-zip" ? "zip" : "tar"
            let ext = (token as NSString).pathExtension.isEmpty ? "mp4" : (token as NSString).pathExtension
            let timeUsStr = comps?.queryItems?.first(where: { $0.name == "timeUs" })?.value ?? "0"
            let timeSec = (Double(timeUsStr) ?? 0) / 1_000_000.0
            guard let extracted = PicShelfMediaStore.shared.extractEntryToTempFile(sourceId: token, kind: kind, offset: offset, size: size, method: method, ext: ext) else {
                safeFail(task, error: URLError(.cannotDecodeRawData))
                return
            }
            defer { if extracted.isTemporary { try? FileManager.default.removeItem(at: extracted.url) } }
            if let frame = PicShelfMediaStore.generateVideoFrame(from: extracted.url, timeSeconds: timeSec, maxDimension: 1280) {
                let poster = "data:image/jpeg;base64," + frame.jpeg.base64EncodedString()
                sendJSON(["poster": poster, "width": frame.width, "height": frame.height], url: url, task: task)
            } else {
                safeFail(task, error: URLError(.cannotDecodeRawData))
            }
            return
        }

        // 3. Metadata JSON (EXIF / GPS / Creation Date / Camera Model)
        if mode == "metadata-tar" || mode == "metadata-zip" {
            let kind = mode == "metadata-zip" ? "zip" : "tar"
            let mime = comps?.queryItems?.first(where: { $0.name == "type" })?.value ?? ""
            if mime.hasPrefix("video/") || PicShelfMediaStore.mediaCategory(for: token) == "video" {
                let ext = (token as NSString).pathExtension.isEmpty ? "mp4" : (token as NSString).pathExtension
                if let extracted = PicShelfMediaStore.shared.extractEntryToTempFile(sourceId: token, kind: kind, offset: offset, size: size, method: method, ext: ext) {
                    defer { if extracted.isTemporary { try? FileManager.default.removeItem(at: extracted.url) } }
                    let vmeta = PicShelfMediaStore.extractVideoMetadata(from: extracted.url, includeGps: true)
                    var res: [String: Any] = ["status": "ok"]
                    if let loc = vmeta.location { res["location"] = loc }
                    if let c = vmeta.createdAt { res["createdAt"] = c }
                    if let m = vmeta.cameraModel { res["cameraModel"] = m }
                    sendJSON(res, url: url, task: task)
                    return
                }
            } else {
                if let data = PicShelfMediaStore.shared.extractEntryToData(sourceId: token, kind: kind, offset: offset, size: size, method: method, maxBytes: 4 * 1024 * 1024),
                   let src = CGImageSourceCreateWithData(data as CFData, nil) {
                    let imeta = PicShelfMediaStore.extractImageMetadata(from: src, includeGps: true)
                    var res: [String: Any] = ["status": "ok"]
                    if let loc = imeta.location { res["location"] = loc }
                    if let c = imeta.createdAt { res["createdAt"] = c }
                    if let m = imeta.cameraModel { res["cameraModel"] = m }
                    sendJSON(res, url: url, task: task)
                    return
                }
            }
            sendJSON(["status": "unsupported"], url: url, task: task)
            return
        }

        // 4. Image / PDF card thumbnail (cached JPEG max 512px)
        let kind = (mode == "zip") ? "zip" : "tar"
        let cacheName = "\(token)_\(kind)_\(offset)_\(size).jpg".replacingOccurrences(of: "/", with: "_")
        let cacheURL = PicShelfMediaStore.shared.thumbsDir.appendingPathComponent(cacheName)
        if let cached = try? Data(contentsOf: cacheURL), !cached.isEmpty {
            sendBinary(cached, mime: "image/jpeg", url: url, task: task)
            return
        }

        // Standalone image fast path (zero full-file copy)
        if kind == "tar" && offset == 0,
           let attrs = try? FileManager.default.attributesOfItem(atPath: srcURL.path),
           let fileSize = (attrs[.size] as? NSNumber)?.uint64Value,
           fileSize == size {
            if srcURL.pathExtension.lowercased() == "pdf" {
                if let pdfJpeg = PicShelfMediaStore.renderPDFPage1JPEG(from: srcURL, maxWidth: 600) {
                    try? pdfJpeg.write(to: cacheURL)
                    sendBinary(pdfJpeg, mime: "image/jpeg", url: url, task: task)
                    return
                }
            } else if let thumb = PicShelfMediaStore.generateImageThumbnailJPEG(from: srcURL, maxPixelSize: 512) {
                try? thumb.write(to: cacheURL)
                sendBinary(thumb, mime: "image/jpeg", url: url, task: task)
                return
            }
        }

        // Archive slice thumbnail
        guard let data = PicShelfMediaStore.shared.extractEntryToData(sourceId: token, kind: kind, offset: offset, size: size, method: method, maxBytes: 48 * 1024 * 1024) else {
            safeFail(task, error: URLError(.cannotDecodeRawData))
            return
        }
        // Check PDF magic bytes (%PDF)
        if data.count >= 4 && data[0] == 0x25 && data[1] == 0x50 && data[2] == 0x44 && data[3] == 0x46 {
            let tmpPdf = FileManager.default.temporaryDirectory.appendingPathComponent("ps_pdf_\(UUID().uuidString).pdf")
            try? data.write(to: tmpPdf)
            defer { try? FileManager.default.removeItem(at: tmpPdf) }
            if let pdfJpeg = PicShelfMediaStore.renderPDFPage1JPEG(from: tmpPdf, maxWidth: 600) {
                try? pdfJpeg.write(to: cacheURL)
                sendBinary(pdfJpeg, mime: "image/jpeg", url: url, task: task)
                return
            }
        }
        if let thumb = PicShelfMediaStore.generateImageThumbnailJPEG(from: data, maxPixelSize: 512) {
            try? thumb.write(to: cacheURL)
            sendBinary(thumb, mime: "image/jpeg", url: url, task: task)
        } else {
            // Fallback: send raw bytes if ImageIO couldn't thumbnail (e.g. small SVG/WebP)
            sendBinary(data, mime: "image/jpeg", url: url, task: task)
        }
    }
}

// MARK: - Offline AI Backdrop Scheme Handler (picshelf-backdrop://)

class BackdropSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let relativePath: String
        if path == "backdrop_worker.js" {
            relativePath = "backdrop_worker.js"
        } else {
            relativePath = "vendor/backdrop/" + path
        }

        let bundleRoot = Bundle.main.resourceURL
        let candidates: [URL?] = [
            bundleRoot?.appendingPathComponent("web").appendingPathComponent(relativePath),
            bundleRoot?.appendingPathComponent(relativePath)
        ]

        guard let fileURL = candidates.compactMap({ $0 }).first(where: { FileManager.default.fileExists(atPath: $0.path) }),
              let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let ext = fileURL.pathExtension.lowercased()
        let mimeType: String
        switch ext {
        case "js":
            mimeType = "application/javascript"
        case "wasm":
            mimeType = "application/wasm"
        case "json":
            mimeType = "application/json"
        default:
            mimeType = "application/octet-stream"
        }

        let headers: [String: String] = [
            "Content-Type": mimeType,
            "Content-Length": "\(data.count)",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=31536000, immutable"
        ]
        if let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) {
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } else {
            urlSchemeTask.didFailWithError(URLError(.cannotParseResponse))
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

// MARK: - Main ViewController

class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {

    private var webView: WKWebView!
    private let bridge = AuraBridge()
    private let backdropSchemeHandler = BackdropSchemeHandler()
    private let originalsSchemeHandler = PicShelfOriginalsSchemeHandler()
    private let thumbnailsSchemeHandler = PicShelfThumbnailsSchemeHandler()
    private var currentStatusBarStyle: UIStatusBarStyle = .lightContent

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return currentStatusBarStyle
    }

    override var prefersStatusBarHidden: Bool {
        return false
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 9/255, green: 13/255, blue: 22/255, alpha: 1)

        setupWebView()
        loadLocalApp()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        bridge.startSensors()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        bridge.stopSensors()
    }

    func updateAppearance(theme: String) {
        let isLight = (theme.lowercased() == "light")
        if isLight {
            if #available(iOS 13.0, *) {
                currentStatusBarStyle = .darkContent
                overrideUserInterfaceStyle = .light
            } else {
                currentStatusBarStyle = .default
            }
            let bg = UIColor(red: 251/255, green: 251/255, blue: 254/255, alpha: 1)
            view.backgroundColor = bg
            webView?.backgroundColor = bg
            webView?.scrollView.backgroundColor = bg
        } else {
            currentStatusBarStyle = .lightContent
            if #available(iOS 13.0, *) {
                overrideUserInterfaceStyle = .dark
            }
            let bg = UIColor(red: 9/255, green: 13/255, blue: 22/255, alpha: 1)
            view.backgroundColor = bg
            webView?.backgroundColor = bg
            webView?.scrollView.backgroundColor = bg
        }
        setNeedsStatusBarAppearanceUpdate()
    }

    func notifyAppActive() {
        bridge.startSensors()
        webView?.evaluateJavaScript(
            "if (window.state && window.state.biometricLock && window.state.isAppLocked) { if (window.showAppLock) window.showAppLock(); }",
            completionHandler: nil
        )
    }

    func notifyAppInactive() {
        bridge.stopSensors()
        webView?.evaluateJavaScript(
            "if (window.state && window.state.biometricLock) { window.state.isAppLocked = true; if (window.showAppLock) window.showAppLock(); }",
            completionHandler: nil
        )
    }

    // MARK: - Setup WebView

    private func setupWebView() {
        let contentController = WKUserContentController()

        // 1. Add native bridge message handler
        bridge.viewController = self
        contentController.add(bridge, name: "auraBridge")

        // 2. Snapshot existing durable source IDs for synchronous startup validation
        let existingIds = PicShelfMediaStore.shared.allSourceIds()
        let idsJsonData = (try? JSONSerialization.data(withJSONObject: existingIds, options: [])) ?? Data("[]".utf8)
        let idsJsonLiteral = String(data: idsJsonData, encoding: .utf8) ?? "[]"

        // 3. Inject compatibility shim for AndroidApp & iOS native bridge
        let bridgeShimScript = """
        (function() {
            window.isNativeIOS = true;
            window.__iosKnownSourceIds = new Set(\(idsJsonLiteral));

            const send = function(action, payload) {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.auraBridge) {
                    window.webkit.messageHandlers.auraBridge.postMessage(Object.assign({ action: action }, payload || {}));
                }
            };

            const nativeBridge = {
                openCamera: function() { send('openCamera'); },
                openGallery: function() { send('openGallery'); },
                openGalleryForAlbum: function(album) { send('openGalleryForAlbum', { album: album }); },
                validateArchiveSources: function(idsJson) {
                    try {
                        var arr = typeof idsJson === 'string' ? JSON.parse(idsJson) : (idsJson || []);
                        if (!Array.isArray(arr)) return true;
                        for (var i = 0; i < arr.length; i++) {
                            if (!window.__iosKnownSourceIds.has(String(arr[i]))) return false;
                        }
                        return true;
                    } catch (_) { return true; }
                },
                retainArchiveSources: function(idsJson) {
                    send('retainArchiveSources', { ids: typeof idsJson === 'string' ? idsJson : JSON.stringify(idsJson || []) });
                },
                authenticateBiometrics: function() { send('authenticateBiometrics', { mode: 'unlock' }); },
                authenticateForPasscodeReset: function() { send('authenticateBiometrics', { mode: 'reset' }); },
                getCurrentLocation: function(callbackId) { send('getCurrentLocation', { callbackId: callbackId }); },
                sharePhoto: function(dataUrl, title) { send('sharePhoto', { dataUrl: dataUrl, title: title }); },
                shareMultiplePhotos: function(photosJson, title) { send('shareMultiplePhotos', { photos: photosJson, title: title }); },
                downloadPhoto: function(dataUrl, name) { send('downloadPhoto', { dataUrl: dataUrl, name: name }); },
                executeDownloadBatch: function(batchJson) {
                    try {
                        var parsed = typeof batchJson === 'string' ? JSON.parse(batchJson) : (batchJson || {});
                        send('executeDownloadBatch', parsed);
                        return true;
                    } catch (_) { return false; }
                },
                downloadZip: function(dataUrl, name) { send('downloadZip', { dataUrl: dataUrl, name: name }); },
                setGpsMetadataEnabled: function(enabled) { send('setGpsMetadataEnabled', { enabled: !!enabled }); },
                requestMediaLocationAccess: function() { send('getCurrentLocation', { callbackId: '' }); },
                setStartupAppearance: function(theme) { send('setStartupAppearance', { theme: String(theme || 'dark') }); },
                setStartupLanguage: function(lang) {
                    try { localStorage.setItem('app_language', String(lang || 'en')); } catch(_) {}
                },
                onStartupReady: function() {},
                onStartupFailed: function() {},
                clearCache: function() {},
                setPushUpdatesEnabled: function(enabled) {
                    try { localStorage.setItem('ios_push_enabled', enabled ? 'true' : 'false'); } catch(_) {}
                },
                isPushUpdatesEnabled: function() {
                    try { return localStorage.getItem('ios_push_enabled') !== 'false'; } catch(_) { return true; }
                },
                submitFeedbackToFirebase: function(feedbackJson) {
                    try {
                        fetch('https://aura-photo-organizer-dummy-default-rtdb.firebaseio.com/feedback.json', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: feedbackJson
                        }).catch(function() {});
                    } catch(_) {}
                },
                isNative: function() { return true; }
            };

            // Mirror on both AndroidApp and iOSApp so web/app.js runs seamlessly
            window.AndroidApp = nativeBridge;
            window.iOSApp = nativeBridge;

            // Ensure native styling is applied
            document.documentElement.classList.add('native-app-mode');
            document.addEventListener('DOMContentLoaded', function() {
                document.documentElement.classList.add('native-app-mode');
                document.body.classList.add('native-app-mode');
            });
        })();
        """

        let userScript = WKUserScript(
            source: bridgeShimScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(userScript)

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.setURLSchemeHandler(backdropSchemeHandler, forURLScheme: "picshelf-backdrop")
        config.setURLSchemeHandler(originalsSchemeHandler, forURLScheme: "picshelf-originals")
        config.setURLSchemeHandler(thumbnailsSchemeHandler, forURLScheme: "picshelf-thumbnails")

        webView = WKWebView(frame: .zero, configuration: config)
        bridge.webView = webView
        webView.navigationDelegate = self
        webView.uiDelegate = self

        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 9/255, green: 13/255, blue: 22/255, alpha: 1)
        webView.scrollView.backgroundColor = UIColor(red: 9/255, green: 13/255, blue: 22/255, alpha: 1)
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        view.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    // MARK: - Load Local Web Bundle

    private func loadLocalApp() {
        if let webURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            let webDir = webURL.deletingLastPathComponent()
            webView.loadFileURL(webURL, allowingReadAccessTo: webDir)
        } else if let fallbackURL = Bundle.main.url(forResource: "index", withExtension: "html") {
            let baseDir = fallbackURL.deletingLastPathComponent()
            webView.loadFileURL(fallbackURL, allowingReadAccessTo: baseDir)
        } else {
            let errHtml = """
            <html>
            <body style='background:#090d16;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;text-align:center;'>
                <div>
                    <h2 style='color:#f43f5e;'>PicShelf</h2>
                    <p style='color:#a0a6b0;'>Bundle assets loaded. If web directory is missing, please ensure 'web' folder is added to Copy Bundle Resources in Xcode.</p>
                </div>
            </body>
            </html>
            """
            webView.loadHTMLString(errHtml, baseURL: nil)
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let safeTop = Int(view.safeAreaInsets.top > 0 ? view.safeAreaInsets.top : 47)
        let injectCss = """
        document.documentElement.classList.add('native-app-mode');
        document.body.classList.add('native-app-mode');
        document.documentElement.style.setProperty('--android-status-bar-height', '\(safeTop)px');
        """
        webView.evaluateJavaScript(injectCss, completionHandler: nil)
    }

    // MARK: - WKUIDelegate (Native Alert & Confirm Support)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: "PicShelf", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default, handler: { _ in completionHandler() }))
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: "PicShelf", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel, handler: { _ in completionHandler(false) }))
        alert.addAction(UIAlertAction(title: "Confirm", style: .default, handler: { _ in completionHandler(true) }))
        present(alert, animated: true)
    }
}
