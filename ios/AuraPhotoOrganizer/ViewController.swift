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

// MARK: - Loopback HTTP/1.1 Range Streaming Media Server (Zero-Deadlock, Kernel TCP Backpressure for 24h+ Videos & 1M+ Libraries)

final class PicShelfLocalMediaServer {
    static let shared = PicShelfLocalMediaServer()

    private let stateLock = NSLock()
    private var listenFd: Int32 = -1
    private var isRunning = false
    private(set) var port: UInt16 = 0
    let secretPath: String = "ps-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()

    private let acceptQueue = DispatchQueue(label: "com.picshelf.ios.http.accept", qos: .userInitiated)
    private let clientQueue = DispatchQueue(label: "com.picshelf.ios.http.clients", qos: .userInitiated, attributes: .concurrent)

    var originalsOrigin: String? {
        guard port > 0 else { return nil }
        return "http://127.0.0.1:\(port)/\(secretPath)/originals/"
    }

    var thumbnailsOrigin: String? {
        guard port > 0 else { return nil }
        return "http://127.0.0.1:\(port)/\(secretPath)/thumbs/"
    }

    func start() {
        ensureRunning()
    }

    func ensureRunning() {
        stateLock.lock()
        if isRunning && listenFd >= 0 {
            var sockErr: Int32 = 0
            var errLen = socklen_t(MemoryLayout<Int32>.size)
            let ok = Darwin.getsockopt(listenFd, SOL_SOCKET, SO_ERROR, &sockErr, &errLen) == 0 && sockErr == 0
            if ok {
                stateLock.unlock()
                return
            }
            Darwin.close(listenFd)
            listenFd = -1
            isRunning = false
        }

        let desiredPort = self.port
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            stateLock.unlock()
            return
        }

        var one: Int32 = 1
        Darwin.setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        Darwin.setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = desiredPort.bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        var bindRes = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if bindRes != 0 && desiredPort != 0 {
            // Fallback to ephemeral port if previous port is temporarily in TIME_WAIT
            addr.sin_port = 0
            bindRes = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
        guard bindRes == 0, Darwin.listen(fd, 64) == 0 else {
            Darwin.close(fd)
            stateLock.unlock()
            return
        }

        var boundAddr = sockaddr_in()
        var boundLen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameRes = withUnsafeMutablePointer(to: &boundAddr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.getsockname(fd, $0, &boundLen)
            }
        }
        guard nameRes == 0 else {
            Darwin.close(fd)
            stateLock.unlock()
            return
        }

        self.port = UInt16(bigEndian: boundAddr.sin_port)
        self.listenFd = fd
        self.isRunning = true
        stateLock.unlock()

        acceptQueue.async { [weak self] in
            self?.acceptLoop(serverFd: fd)
        }
    }

    private func acceptLoop(serverFd: Int32) {
        while true {
            var clientAddr = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientFd = withUnsafeMutablePointer(to: &clientAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.accept(serverFd, $0, &clientLen)
                }
            }
            if clientFd < 0 {
                if errno == EINTR { continue }
                stateLock.lock()
                if self.listenFd == serverFd {
                    Darwin.close(serverFd)
                    self.listenFd = -1
                    self.isRunning = false
                }
                stateLock.unlock()
                break
            }
            clientQueue.async { [weak self] in
                self?.handleClient(clientFd)
            }
        }
    }

    private func handleClient(_ fd: Int32) {
        defer { Darwin.close(fd) }

        var one: Int32 = 1
        Darwin.setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var rcvTv = timeval(tv_sec: 10, tv_usec: 0)
        Darwin.setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &rcvTv, socklen_t(MemoryLayout<timeval>.size))
        var sndTv = timeval(tv_sec: 30, tv_usec: 0)
        Darwin.setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &sndTv, socklen_t(MemoryLayout<timeval>.size))

        // Read HTTP request headers up to 16 KB
        var reqData = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        let headerDelim = Data("\r\n\r\n".utf8)
        while reqData.count < 16384 {
            let n = Darwin.recv(fd, &buf, buf.count, 0)
            if n <= 0 { break }
            reqData.append(buf, count: n)
            if reqData.range(of: headerDelim) != nil { break }
        }
        guard !reqData.isEmpty, let headerStr = String(data: reqData, encoding: .utf8) else { return }

        let lines = headerStr.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return }
        let reqParts = requestLine.split(separator: " ")
        guard reqParts.count >= 2 else { return }

        let httpMethod = String(reqParts[0]).uppercased()
        let rawTarget = String(reqParts[1])

        var headersMap: [String: String] = [:]
        for line in lines.dropFirst() {
            if line.isEmpty { break }
            if let colon = line.firstIndex(of: ":") {
                let k = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                let v = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                headersMap[k] = v
            }
        }

        if httpMethod == "OPTIONS" {
            let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type\r\nAccess-Control-Max-Age: 86400\r\nConnection: close\r\n\r\n"
            _ = writeAll(fd, Data(resp.utf8))
            return
        }

        guard httpMethod == "GET" || httpMethod == "HEAD" else {
            sendSimpleError(fd, code: 405, reason: "Method Not Allowed")
            return
        }

        guard let fullURL = URL(string: "http://127.0.0.1\(rawTarget)") else {
            sendSimpleError(fd, code: 400, reason: "Bad Request")
            return
        }

        let comps = fullURL.pathComponents.filter { $0 != "/" }
        // Expected: [secretPath, "originals"|"thumbs", token, kind/mode, offset, size, method]
        guard comps.count >= 7, comps[0] == secretPath else {
            sendSimpleError(fd, code: 403, reason: "Forbidden")
            return
        }

        let route = comps[1]
        guard let token = comps[2].removingPercentEncoding,
              let offset = UInt64(comps[4]),
              let size = UInt64(comps[5]),
              let method = Int(comps[6]),
              let srcURL = PicShelfMediaStore.shared.sourceURL(for: token),
              FileManager.default.fileExists(atPath: srcURL.path) else {
            sendSimpleError(fd, code: 404, reason: "Not Found")
            return
        }

        let modeOrKind = comps[3].lowercased()
        let urlComps = URLComponents(url: fullURL, resolvingAgainstBaseURL: false)
        let isHead = (httpMethod == "HEAD")

        if route == "originals" {
            let mime = urlComps?.queryItems?.first(where: { $0.name == "type" })?.value ?? PicShelfMediaStore.mimeType(for: token)
            serveOriginal(fd: fd, fileURL: srcURL, token: token, kind: modeOrKind, offset: offset, size: size, method: method, mime: mime, rangeHeader: headersMap["range"], isHead: isHead)
        } else if route == "thumbs" {
            serveThumbnailOrMeta(fd: fd, fileURL: srcURL, token: token, mode: modeOrKind, offset: offset, size: size, method: method, urlComps: urlComps, isHead: isHead)
        } else {
            sendSimpleError(fd, code: 404, reason: "Not Found")
        }
    }

    private func serveOriginal(fd: Int32, fileURL: URL, token: String, kind: String, offset: UInt64, size: UInt64, method: Int, mime: String, rangeHeader: String?, isHead: Bool) {
        if kind == "zip" && method == 8 {
            guard let inflated = PicShelfMediaStore.shared.extractEntryToData(sourceId: token, kind: "zip", offset: offset, size: size, method: 8, maxBytes: 256 * 1024 * 1024) else {
                sendSimpleError(fd, code: 500, reason: "Decode Failed")
                return
            }
            serveInMemoryRange(fd: fd, data: inflated, mime: mime, rangeHeader: rangeHeader, isHead: isHead)
            return
        }

        guard let fh = try? FileHandle(forReadingFrom: fileURL) else {
            sendSimpleError(fd, code: 500, reason: "Open Failed")
            return
        }
        defer { try? fh.close() }

        var dataStart = offset
        if kind == "zip" {
            guard let resolved = PicShelfMediaStore.shared.resolveZipDataOffset(fileHandle: fh, localOffset: offset) else {
                sendSimpleError(fd, code: 500, reason: "Invalid ZIP")
                return
            }
            dataStart = resolved
        }

        let totalLength = size
        var reqStart: UInt64 = 0
        var reqEnd: UInt64 = totalLength > 0 ? totalLength - 1 : 0
        var isRange = false
        if let rh = rangeHeader {
            if let parsed = parseByteRange(rh, totalLength: totalLength) {
                reqStart = parsed.start
                reqEnd = parsed.end
                isRange = true
            } else {
                let err = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */\(totalLength)\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
                _ = writeAll(fd, Data(err.utf8))
                return
            }
        }

        let contentLength = totalLength > 0 ? (reqEnd - reqStart + 1) : 0
        var headerText = isRange ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n"
        headerText += "Content-Type: \(mime)\r\n"
        headerText += "Content-Length: \(contentLength)\r\n"
        headerText += "Accept-Ranges: bytes\r\n"
        if isRange {
            headerText += "Content-Range: bytes \(reqStart)-\(reqEnd)/\(totalLength)\r\n"
        }
        headerText += "Access-Control-Allow-Origin: *\r\n"
        headerText += "Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length\r\n"
        headerText += "Cache-Control: private, max-age=3600\r\n"
        headerText += "Connection: close\r\n\r\n"

        guard writeAll(fd, Data(headerText.utf8)) else { return }
        if isHead || contentLength == 0 { return }

        do {
            try fh.seek(toOffset: dataStart + reqStart)
            var remaining = contentLength
            let chunkBytes: UInt64 = 65536 // 64 KB chunks for instant cancel & constant low RAM even on 24h videos
            while remaining > 0 {
                let toRead = Int(min(remaining, chunkBytes))
                guard let chunk = try fh.read(upToCount: toRead), !chunk.isEmpty else { break }
                if !writeAll(fd, chunk) { return } // Client closed / seeked -> exit immediately
                remaining -= UInt64(chunk.count)
            }
        } catch {
            return
        }
    }

    private func serveInMemoryRange(fd: Int32, data: Data, mime: String, rangeHeader: String?, isHead: Bool) {
        let total = UInt64(data.count)
        var start: UInt64 = 0
        var end: UInt64 = total > 0 ? total - 1 : 0
        var isRange = false
        if let rh = rangeHeader, let parsed = parseByteRange(rh, totalLength: total) {
            start = parsed.start
            end = parsed.end
            isRange = true
        }
        let sliceLen = total > 0 ? (end - start + 1) : 0
        var headerText = isRange ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n"
        headerText += "Content-Type: \(mime)\r\n"
        headerText += "Content-Length: \(sliceLen)\r\n"
        headerText += "Accept-Ranges: bytes\r\n"
        if isRange {
            headerText += "Content-Range: bytes \(start)-\(end)/\(total)\r\n"
        }
        headerText += "Access-Control-Allow-Origin: *\r\n"
        headerText += "Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length\r\n"
        headerText += "Cache-Control: private, max-age=3600\r\n"
        headerText += "Connection: close\r\n\r\n"
        guard writeAll(fd, Data(headerText.utf8)) else { return }
        if isHead || sliceLen == 0 { return }
        let slice = data.subdata(in: Int(start)..<Int(end + 1))
        _ = writeAll(fd, slice)
    }

    private func serveThumbnailOrMeta(fd: Int32, fileURL: URL, token: String, mode: String, offset: UInt64, size: UInt64, method: Int, urlComps: URLComponents?, isHead: Bool) {
        func sendBytes(_ data: Data, mime: String) {
            let header = "HTTP/1.1 200 OK\r\nContent-Type: \(mime)\r\nContent-Length: \(data.count)\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: public, max-age=86400\r\nConnection: close\r\n\r\n"
            guard writeAll(fd, Data(header.utf8)) else { return }
            if !isHead && !data.isEmpty { _ = writeAll(fd, data) }
        }
        func sendJSON(_ obj: [String: Any]) {
            guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
                sendSimpleError(fd, code: 500, reason: "JSON Error")
                return
            }
            sendBytes(data, mime: "application/json")
        }

        if mode == "video-tar" || mode == "video-zip" {
            let kind = mode == "video-zip" ? "zip" : "tar"
            let ext = (token as NSString).pathExtension.isEmpty ? "mp4" : (token as NSString).pathExtension
            guard let extracted = PicShelfMediaStore.shared.extractEntryToTempFile(sourceId: token, kind: kind, offset: offset, size: size, method: method, ext: ext) else {
                sendSimpleError(fd, code: 404, reason: "Video Unavailable")
                return
            }
            defer { if extracted.isTemporary { try? FileManager.default.removeItem(at: extracted.url) } }
            if let frame = PicShelfMediaStore.generateVideoFrame(from: extracted.url, timeSeconds: nil, maxDimension: 540) {
                let poster = "data:image/jpeg;base64," + frame.jpeg.base64EncodedString()
                sendJSON(["poster": poster, "duration": frame.duration, "width": frame.width, "height": frame.height])
            } else {
                let meta = PicShelfMediaStore.extractVideoMetadata(from: extracted.url, includeGps: false)
                sendJSON(["duration": meta.duration])
            }
            return
        }

        if mode == "resize-frame-tar" || mode == "resize-frame-zip" {
            let kind = mode == "resize-frame-zip" ? "zip" : "tar"
            let ext = (token as NSString).pathExtension.isEmpty ? "mp4" : (token as NSString).pathExtension
            let timeUsStr = urlComps?.queryItems?.first(where: { $0.name == "timeUs" })?.value ?? "0"
            let timeSec = (Double(timeUsStr) ?? 0) / 1_000_000.0
            guard let extracted = PicShelfMediaStore.shared.extractEntryToTempFile(sourceId: token, kind: kind, offset: offset, size: size, method: method, ext: ext) else {
                sendSimpleError(fd, code: 404, reason: "Frame Unavailable")
                return
            }
            defer { if extracted.isTemporary { try? FileManager.default.removeItem(at: extracted.url) } }
            if let frame = PicShelfMediaStore.generateVideoFrame(from: extracted.url, timeSeconds: timeSec, maxDimension: 1280) {
                let poster = "data:image/jpeg;base64," + frame.jpeg.base64EncodedString()
                sendJSON(["poster": poster, "width": frame.width, "height": frame.height])
            } else {
                sendSimpleError(fd, code: 500, reason: "Frame Decode Failed")
            }
            return
        }

        if mode == "metadata-tar" || mode == "metadata-zip" {
            let kind = mode == "metadata-zip" ? "zip" : "tar"
            let mime = urlComps?.queryItems?.first(where: { $0.name == "type" })?.value ?? ""
            if mime.hasPrefix("video/") || PicShelfMediaStore.mediaCategory(for: token) == "video" {
                let ext = (token as NSString).pathExtension.isEmpty ? "mp4" : (token as NSString).pathExtension
                if let extracted = PicShelfMediaStore.shared.extractEntryToTempFile(sourceId: token, kind: kind, offset: offset, size: size, method: method, ext: ext) {
                    defer { if extracted.isTemporary { try? FileManager.default.removeItem(at: extracted.url) } }
                    let vmeta = PicShelfMediaStore.extractVideoMetadata(from: extracted.url, includeGps: true)
                    var res: [String: Any] = ["status": "ok"]
                    if let loc = vmeta.location { res["location"] = loc }
                    if let c = vmeta.createdAt { res["createdAt"] = c }
                    if let m = vmeta.cameraModel { res["cameraModel"] = m }
                    sendJSON(res)
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
                    sendJSON(res)
                    return
                }
            }
            sendJSON(["status": "unsupported"])
            return
        }

        // Image / PDF thumbnail (cached 512px JPEG)
        let kind = (mode == "zip") ? "zip" : "tar"
        let cacheName = "\(token)_\(kind)_\(offset)_\(size).jpg".replacingOccurrences(of: "/", with: "_")
        let cacheURL = PicShelfMediaStore.shared.thumbsDir.appendingPathComponent(cacheName)
        if let cached = try? Data(contentsOf: cacheURL), !cached.isEmpty {
            sendBytes(cached, mime: "image/jpeg")
            return
        }

        if kind == "tar" && offset == 0,
           let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
           let fileSize = (attrs[.size] as? NSNumber)?.uint64Value,
           fileSize == size {
            if fileURL.pathExtension.lowercased() == "pdf" {
                if let pdfJpeg = PicShelfMediaStore.renderPDFPage1JPEG(from: fileURL, maxWidth: 600) {
                    try? pdfJpeg.write(to: cacheURL)
                    sendBytes(pdfJpeg, mime: "image/jpeg")
                    return
                }
            } else if let thumb = PicShelfMediaStore.generateImageThumbnailJPEG(from: fileURL, maxPixelSize: 512) {
                try? thumb.write(to: cacheURL)
                sendBytes(thumb, mime: "image/jpeg")
                return
            }
        }

        guard let data = PicShelfMediaStore.shared.extractEntryToData(sourceId: token, kind: kind, offset: offset, size: size, method: method, maxBytes: 48 * 1024 * 1024) else {
            sendSimpleError(fd, code: 404, reason: "Thumb Unavailable")
            return
        }
        if data.count >= 4 && data[0] == 0x25 && data[1] == 0x50 && data[2] == 0x44 && data[3] == 0x46 {
            let tmpPdf = FileManager.default.temporaryDirectory.appendingPathComponent("ps_pdf_\(UUID().uuidString).pdf")
            try? data.write(to: tmpPdf)
            defer { try? FileManager.default.removeItem(at: tmpPdf) }
            if let pdfJpeg = PicShelfMediaStore.renderPDFPage1JPEG(from: tmpPdf, maxWidth: 600) {
                try? pdfJpeg.write(to: cacheURL)
                sendBytes(pdfJpeg, mime: "image/jpeg")
                return
            }
        }
        if let thumb = PicShelfMediaStore.generateImageThumbnailJPEG(from: data, maxPixelSize: 512) {
            try? thumb.write(to: cacheURL)
            sendBytes(thumb, mime: "image/jpeg")
        } else {
            sendBytes(data, mime: "image/jpeg")
        }
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

    private func sendSimpleError(_ fd: Int32, code: Int, reason: String) {
        let resp = "HTTP/1.1 \(code) \(reason)\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
        _ = writeAll(fd, Data(resp.utf8))
    }

    private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        if data.isEmpty { return true }
        return data.withUnsafeBytes { rawBuf -> Bool in
            guard let base = rawBuf.baseAddress else { return false }
            var sentTotal = 0
            let count = data.count
            while sentTotal < count {
                let n = Darwin.send(fd, base.advanced(by: sentTotal), count - sentTotal, 0)
                if n > 0 {
                    sentTotal += n
                } else if n < 0 && errno == EINTR {
                    continue
                } else {
                    return false
                }
            }
            return true
        }
    }
}

// MARK: - Safe WKURLSchemeTask Stop-Guarded Dispatcher (Main-Thread Safe, Zero Deadlock)

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

    private func runOnMainIfActive(_ task: WKURLSchemeTask, markDone: Bool = false, _ block: @escaping () -> Void) -> Bool {
        if Thread.isMainThread {
            if isStopped(task) { return false }
            if markDone {
                stateLock.lock()
                stoppedTasks.insert(ObjectIdentifier(task))
                stateLock.unlock()
            }
            block()
            return true
        }
        var executed = false
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            defer { sem.signal() }
            guard let self = self, !self.isStopped(task) else { return }
            if markDone {
                self.stateLock.lock()
                self.stoppedTasks.insert(ObjectIdentifier(task))
                self.stateLock.unlock()
            }
            block()
            executed = true
        }
        _ = sem.wait(timeout: .now() + 5)
        return executed
    }

    func safeSendResponse(_ task: WKURLSchemeTask, response: URLResponse) -> Bool {
        return runOnMainIfActive(task) { task.didReceive(response) }
    }

    func safeSendData(_ task: WKURLSchemeTask, data: Data) -> Bool {
        return runOnMainIfActive(task) { task.didReceive(data) }
    }

    func safeFinish(_ task: WKURLSchemeTask) {
        _ = runOnMainIfActive(task, markDone: true) { task.didFinish() }
    }

    func safeFail(_ task: WKURLSchemeTask, error: Error) {
        _ = runOnMainIfActive(task, markDone: true) { task.didFailWithError(error) }
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

// MARK: - Native Animated Startup Cover (Exact Parity with Android StartupCover / StartupMotionArtwork / StartupWordmark)

final class PicShelfStartupCoverView: UIView {

    private static let languageDefaultsKey = "picshelf_startup_language"
    private static let localizedWaitingMessages: [String: String] = [
        "en": "Getting your library ready…",
        "hi": "आपकी लाइब्रेरी तैयार की जा रही है…",
        "bn": "আপনার লাইব্রেরি প্রস্তুত করা হচ্ছে…",
        "te": "మీ లైబ్రరీని సిద్ధం చేస్తున్నాము…",
        "ta": "உங்கள் நூலகம் தயாராகிறது…",
        "mr": "तुमची लायब्ररी तयार होत आहे…",
        "gu": "તમારી લાઇબ્રેરી તૈયાર થઈ રહી છે…",
        "kn": "ನಿಮ್ಮ ಲೈಬ್ರರಿಯನ್ನು ಸಿದ್ಧಪಡಿಸಲಾಗುತ್ತಿದೆ…",
        "ml": "നിങ്ങളുടെ ലൈബ്രറി തയ്യാറാക്കുന്നു…",
        "pa": "ਤੁਹਾਡੀ ਲਾਇਬ੍ਰੇਰੀ ਤਿਆਰ ਕੀਤੀ ਜਾ ਰਹੀ ਹੈ…"
    ]

    static func saveLanguage(_ lang: String) {
        let code = lang.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if localizedWaitingMessages[code] != nil {
            UserDefaults.standard.set(code, forKey: languageDefaultsKey)
        }
    }

    static func waitingMessage(for lang: String? = nil) -> String {
        let code = (lang ?? UserDefaults.standard.string(forKey: languageDefaultsKey) ?? "en").lowercased()
        return localizedWaitingMessages[code] ?? localizedWaitingMessages["en"]!
    }

    // Wordmark handwriting timing matches Android StartupWordmark.kt (320ms start, 2400ms duration -> 2720ms complete)
    static let wordmarkCompleteMs: Double = 2720.0

    private struct SampledStroke {
        let points: [CGPoint]
        let cumulativeLengths: [CGFloat]
        let totalLength: CGFloat
    }

    private var displayLink: CADisplayLink?
    private var startMediaTime: CFTimeInterval = 0
    private var isAnimating: Bool = false
    private(set) var wordmarkCompleted: Bool = false
    var onWordmarkComplete: (() -> Void)?

    private let captionLabel: UILabel = {
        let lbl = UILabel()
        lbl.textAlignment = .center
        lbl.numberOfLines = 3
        lbl.textColor = UIColor(red: 241/255, green: 232/255, blue: 239/255, alpha: 1)
        lbl.alpha = 0
        lbl.isHidden = true
        return lbl
    }()

    // Pre-rasterized layers (identical to Android StartupMotionArtwork.kt)
    private var cachedBackdropSize: CGSize = .zero
    private var cachedBackdropImage: CGImage?
    private lazy var baseLayerImage: CGImage? = renderBaseLayer()
    private lazy var edgeLayerImage: CGImage? = renderEdgeLayer()
    private lazy var glassLayerImage: CGImage? = renderGlassLayer()
    private lazy var outerRingImage: CGImage? = renderOuterRing()
    private lazy var middleRingImage: CGImage? = renderMiddleRing()
    private lazy var innerRingImage: CGImage? = renderInnerRing()
    private lazy var prismImage: CGImage? = renderPrismLayer()
    private lazy var portalArtImage: CGImage? = UIImage(named: "StartupPortalArt")?.cgImage
    private lazy var glassClipPath: CGPath = Self.motionFramePath(half: 128, radius: 54)
    private lazy var sheenGradient: CGGradient? = Self.makeGradient(
        colors: [0x00ffffff, 0x1affffff, 0x88ffffff, 0x1affffff, 0x00ffffff],
        locations: [0.0, 0.36, 0.5, 0.64, 1.0]
    )
    private lazy var wordmarkStrokes: [SampledStroke] = Self.buildWordmarkStrokes()
    private lazy var wordmarkTotalLength: CGFloat = wordmarkStrokes.reduce(0) { $0 + $1.totalLength }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(red: 9/255, green: 3/255, blue: 12/255, alpha: 1)
        isOpaque = true
        isUserInteractionEnabled = true
        accessibilityLabel = "PicShelf"
        captionLabel.text = Self.waitingMessage()
        addSubview(captionLabel)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        stopAnimation()
    }

    func updateLanguage(_ lang: String) {
        Self.saveLanguage(lang)
        captionLabel.text = Self.waitingMessage(for: lang)
        setNeedsLayout()
    }

    func elapsedMilliseconds() -> Double {
        guard startMediaTime > 0 else { return 0 }
        return max(0, (CACurrentMediaTime() - startMediaTime) * 1000.0)
    }

    func startAnimation() {
        guard !isAnimating else { return }
        isAnimating = true
        if startMediaTime == 0 {
            startMediaTime = CACurrentMediaTime()
        }
        let link = CADisplayLink(target: self, selector: #selector(onDisplayFrame))
        if #available(iOS 15.0, *) {
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        }
        link.add(to: .main, forMode: .common)
        displayLink = link
        setNeedsDisplay()
    }

    func stopAnimation() {
        isAnimating = false
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func onDisplayFrame() {
        let elapsed = elapsedMilliseconds()
        if !wordmarkCompleted && elapsed >= Self.wordmarkCompleteMs {
            wordmarkCompleted = true
            onWordmarkComplete?()
        }
        // Show localized "Getting your library ready…" if loading continues past wordmark completion
        if wordmarkCompleted && captionLabel.isHidden && elapsed >= 3100.0 {
            captionLabel.isHidden = false
            UIView.animate(withDuration: 0.25) {
                self.captionLabel.alpha = 1
            }
        }
        setNeedsDisplay()
    }

    private func layoutMetrics() -> (unit: CGFloat, originY: CGFloat, captionTop: CGFloat, captionHeight: CGFloat) {
        let w = bounds.width
        let h = bounds.height
        let designScale = max(1.0, min(w / 390.0, h / 610.0))
        let targetFontSize = 15.0 * designScale
        if abs(captionLabel.font.pointSize - targetFontSize) > 0.2 {
            captionLabel.font = UIFont.systemFont(ofSize: targetFontSize, weight: .regular)
        }
        let sideMargin: CGFloat = 24.0
        let maxCaptionW = max(1.0, w - sideMargin * 2.0)
        let capSize = captionLabel.sizeThatFits(CGSize(width: maxCaptionW, height: .greatestFiniteMagnitude))
        let captionHeight = ceil(capSize.height)
        let unit = min(w / 390.0, max(1.0, h - captionHeight - 32.0) / 462.0)
        let originY = (h - (462.0 * unit + captionHeight)) / 2.0 + 202.0 * unit
        let captionTop = originY + 260.0 * unit
        return (unit, originY, captionTop, captionHeight)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let m = layoutMetrics()
        captionLabel.frame = CGRect(x: 24, y: m.captionTop, width: max(1, bounds.width - 48), height: m.captionHeight)
        if cachedBackdropSize != bounds.size && bounds.width > 0 && bounds.height > 0 {
            cachedBackdropSize = bounds.size
            cachedBackdropImage = renderBackdrop(size: bounds.size)
        }
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext(), bounds.width > 0, bounds.height > 0 else { return }

        if cachedBackdropImage == nil || cachedBackdropSize != bounds.size {
            cachedBackdropSize = bounds.size
            cachedBackdropImage = renderBackdrop(size: bounds.size)
        }

        // 1. Cached full-screen ambient backdrop (exact Android dark plum + rose/champagne/cyan glows)
        if let bg = cachedBackdropImage {
            ctx.saveGState()
            ctx.translateBy(x: 0, y: bounds.height)
            ctx.scaleBy(x: 1, y: -1)
            ctx.draw(bg, in: bounds)
            ctx.restoreGState()
        }

        let m = layoutMetrics()
        guard m.unit > 0 else { return }
        let elapsed = elapsedMilliseconds()

        ctx.saveGState()
        ctx.translateBy(x: bounds.width / 2.0, y: m.originY)
        ctx.scaleBy(x: m.unit, y: m.unit)

        // 2. Rose halo + outer glass square
        drawImage(baseLayerImage, half: 202, in: ctx)

        // 3. Rotating sweeping edge frame (period 5,000 ms)
        let edgeAngleRad = CGFloat(elapsed.truncatingRemainder(dividingBy: 5000.0) / 5000.0) * (.pi * 2.0)
        drawRotatedImage(edgeLayerImage, half: 138, radians: edgeAngleRad, in: ctx)

        // 4. Smoky glass square + rose-gold rim
        drawImage(glassLayerImage, half: 130, in: ctx)

        // 5. Diagonal sheen sweep (starts at 800ms, repeats every 3600ms, active 1450ms)
        drawSheen(elapsedMs: elapsed, in: ctx)

        // 6. Central camera-lens portal artwork
        drawImage(portalArtImage, half: 108, in: ctx)

        // 7. Three counter-rotating precision orbit rings
        let outerRad = CGFloat(elapsed.truncatingRemainder(dividingBy: 12000.0) / 12000.0) * (.pi * 2.0)
        let middleRad = -CGFloat(elapsed.truncatingRemainder(dividingBy: 8000.0) / 8000.0) * (.pi * 2.0)
        drawRotatedImage(outerRingImage, half: 91, radians: outerRad, in: ctx)
        drawRotatedImage(middleRingImage, half: 79, radians: middleRad, in: ctx)
        drawRotatedImage(innerRingImage, half: 66, radians: edgeAngleRad, in: ctx)

        // 8. Breathing & gently rotating faceted prism (period 4,500 ms)
        let breathePhase = (elapsed.truncatingRemainder(dividingBy: 4500.0) / 4500.0) * (.pi * 2.0)
        let breathe = CGFloat((1.0 - cos(breathePhase)) * 0.5)
        ctx.saveGState()
        let prismScale = 0.97 + 0.06 * breathe
        ctx.scaleBy(x: prismScale, y: prismScale)
        ctx.rotate(by: (6.0 * breathe) * (.pi / 180.0))
        drawImage(prismImage, half: 38, in: ctx)
        ctx.restore()

        // 9. Handwritten "PicShelf" connected script wordmark (320ms -> 2720ms)
        let progress = wordmarkCompleted ? 1.0 : CGFloat(max(0.0, min(1.0, (elapsed - 320.0) / 2400.0)))
        drawWordmark(progress: progress, in: ctx)

        ctx.restore()
    }

    private func drawImage(_ img: CGImage?, half: CGFloat, in ctx: CGContext) {
        guard let img = img else { return }
        ctx.saveGState()
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(img, in: CGRect(x: -half, y: -half, width: half * 2, height: half * 2))
        ctx.restore()
    }

    private func drawRotatedImage(_ img: CGImage?, half: CGFloat, radians: CGFloat, in ctx: CGContext) {
        guard let img = img else { return }
        ctx.saveGState()
        ctx.rotate(by: radians)
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(img, in: CGRect(x: -half, y: -half, width: half * 2, height: half * 2))
        ctx.restore()
    }

    private func drawSheen(elapsedMs: Double, in ctx: CGContext) {
        guard elapsedMs >= 800.0, let grad = sheenGradient else { return }
        let sweep = (elapsedMs - 800.0).truncatingRemainder(dividingBy: 3600.0)
        guard sweep < 1450.0 else { return }
        ctx.saveGState()
        ctx.addPath(glassClipPath)
        ctx.clip()
        ctx.rotate(by: 35.0 * (.pi / 180.0))
        ctx.translateBy(x: -205.0 + 410.0 * CGFloat(sweep / 1450.0), y: 0)
        ctx.clip(to: CGRect(x: -23, y: -190, width: 46, height: 380))
        ctx.drawLinearGradient(grad, start: CGPoint(x: -23, y: 0), end: CGPoint(x: 23, y: 0), options: [])
        ctx.restore()
    }

    private func drawWordmark(progress: CGFloat, in ctx: CGContext) {
        guard progress > 0 else { return }
        ctx.saveGState()
        ctx.translateBy(x: -124, y: 154)
        ctx.setStrokeColor(UIColor.white.cgColor)
        ctx.setLineWidth(3.6)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)

        var remaining = wordmarkTotalLength * progress
        for stroke in wordmarkStrokes {
            guard stroke.points.count >= 2 else { continue }
            if remaining >= stroke.totalLength {
                ctx.beginPath()
                ctx.move(to: stroke.points[0])
                for i in 1..<stroke.points.count {
                    ctx.addLine(to: stroke.points[i])
                }
                ctx.strokePath()
                remaining -= stroke.totalLength
            } else {
                if remaining > 0 {
                    ctx.beginPath()
                    ctx.move(to: stroke.points[0])
                    for i in 1..<stroke.points.count {
                        let segEnd = stroke.cumulativeLengths[i]
                        if segEnd <= remaining {
                            ctx.addLine(to: stroke.points[i])
                        } else {
                            let segStart = stroke.cumulativeLengths[i - 1]
                            let segLen = max(0.0001, segEnd - segStart)
                            let t = (remaining - segStart) / segLen
                            let p0 = stroke.points[i - 1]
                            let p1 = stroke.points[i]
                            let interp = CGPoint(x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t)
                            ctx.addLine(to: interp)
                            break
                        }
                    }
                    ctx.strokePath()
                }
                break
            }
        }
        ctx.restore()
    }

    // MARK: - Layer Pre-Rasterization Helpers

    private static func argbColor(_ argb: UInt32) -> UIColor {
        let a = CGFloat((argb >> 24) & 0xff) / 255.0
        let r = CGFloat((argb >> 16) & 0xff) / 255.0
        let g = CGFloat((argb >> 8) & 0xff) / 255.0
        let b = CGFloat(argb & 0xff) / 255.0
        return UIColor(red: r, green: g, blue: b, alpha: a)
    }

    private static func makeGradient(colors: [UInt32], locations: [CGFloat]?) -> CGGradient? {
        let cgColors = colors.map { argbColor($0).cgColor } as CFArray
        let cs = CGColorSpaceCreateDeviceRGB()
        if let locs = locations {
            return CGGradient(colorsSpace: cs, colors: cgColors, locations: locs)
        }
        return CGGradient(colorsSpace: cs, colors: cgColors, locations: nil)
    }

    private static func motionFramePath(half: CGFloat, radius: CGFloat) -> CGPath {
        let t = half - radius
        let p = CGMutablePath()
        p.move(to: CGPoint(x: -t, y: -half))
        p.addLine(to: CGPoint(x: t, y: -half))
        p.addQuadCurve(to: CGPoint(x: half, y: -t), control: CGPoint(x: half, y: -half))
        p.addLine(to: CGPoint(x: half, y: t))
        p.addQuadCurve(to: CGPoint(x: t, y: half), control: CGPoint(x: half, y: half))
        p.addLine(to: CGPoint(x: -t, y: half))
        p.addQuadCurve(to: CGPoint(x: -half, y: t), control: CGPoint(x: -half, y: half))
        p.addLine(to: CGPoint(x: -half, y: -t))
        p.addQuadCurve(to: CGPoint(x: -t, y: -half), control: CGPoint(x: -half, y: -half))
        p.closeSubpath()
        return p
    }

    private func rasterLayer(half: CGFloat, draw: (CGContext) -> Void) -> CGImage? {
        let pixels = min(Int(half * 4.0), 540)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: pixels, height: pixels), format: format)
        let img = renderer.image { rc in
            let ctx = rc.cgContext
            ctx.translateBy(x: CGFloat(pixels) / 2.0, y: CGFloat(pixels) / 2.0)
            let s = CGFloat(pixels) / (half * 2.0)
            ctx.scaleBy(x: s, y: s)
            draw(ctx)
        }
        return img.cgImage
    }

    private func renderBackdrop(size: CGSize) -> CGImage? {
        let w = size.width
        let h = size.height
        let unit = min(w / 390.0, h / 610.0)
        let format = UIGraphicsImageRendererFormat()
        format.scale = min(UIScreen.main.scale, 2.0)
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { rc in
            let ctx = rc.cgContext
            if let baseGrad = Self.makeGradient(colors: [0xff1a0a20, 0xff09030c, 0xff020104], locations: [0.0, 0.7, 1.0]) {
                let c = CGPoint(x: w * 0.5, y: h * 0.48)
                let r = hypot(w * 0.5, h * 0.52)
                ctx.drawRadialGradient(baseGrad, startCenter: c, startRadius: 0, endCenter: c, endRadius: r, options: [.drawsAfterEndLocation])
            }
            let glows: [(CGPoint, CGFloat, UInt32)] = [
                (CGPoint(x: w * 0.08 + 132 * unit, y: h * 0.15 + 132 * unit), 175 * unit, 0x35f43f5e),
                (CGPoint(x: w * 0.95 - 138 * unit, y: h * 0.82 - 138 * unit), 193 * unit, 0x32e5a985),
                (CGPoint(x: w * 0.15 + 120 * unit, y: h * 0.70 - 120 * unit), 146 * unit, 0x2006b6d4)
            ]
            for (center, radius, color) in glows {
                if let g = Self.makeGradient(colors: [color, color & 0x00ffffff], locations: [0.0, 1.0]) {
                    ctx.drawRadialGradient(g, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
                }
            }
        }.cgImage
    }

    private func renderBaseLayer() -> CGImage? {
        return rasterLayer(half: 202) { ctx in
            if let haloGrad = Self.makeGradient(colors: [0x00f43f5e, 0x40f43f5e, 0x00f43f5e], locations: [0.0, 0.60, 1.0]) {
                ctx.drawRadialGradient(haloGrad, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: 202, options: [])
            }
            let outerRect = CGRect(x: -132.5, y: -132.5, width: 265, height: 265)
            let outerPath = UIBezierPath(roundedRect: outerRect, cornerRadius: 58).cgPath
            ctx.saveGState()
            ctx.addPath(outerPath)
            ctx.clip()
            if let grad = Self.makeGradient(colors: [0xffb89d99, 0xff70575a, 0xff775755, 0xff976952], locations: nil) {
                ctx.drawLinearGradient(grad, start: CGPoint(x: -132, y: -132), end: CGPoint(x: 132, y: 132), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }
            ctx.restore()
        }
    }

    private func renderEdgeLayer() -> CGImage? {
        let half: CGFloat = 138
        let pixels = min(Int(half * 4.0), 540)
        let s = CGFloat(pixels) / (half * 2.0)

        let gradLayer = CAGradientLayer()
        gradLayer.type = .conic
        gradLayer.frame = CGRect(x: 0, y: 0, width: pixels, height: pixels)
        gradLayer.startPoint = CGPoint(x: 0.5, y: 0.5)
        gradLayer.endPoint = CGPoint(x: 1.0, y: 0.5)
        gradLayer.colors = [
            0xd9f43f5e, 0xffffffff, 0xbf06b6d4, 0x99e5a985,
            0x4df43f5e, 0x00f43f5e, 0x00f43f5e, 0x80fbe0d4, 0xd9f43f5e
        ].map { Self.argbColor($0).cgColor }
        gradLayer.locations = [0.0, 0.139, 0.25, 0.417, 0.556, 0.694, 0.75, 0.861, 1.0].map { NSNumber(value: $0) }

        var transform = CGAffineTransform(translationX: CGFloat(pixels) / 2.0, y: CGFloat(pixels) / 2.0).scaledBy(x: s, y: s)
        let scaledPath = Self.motionFramePath(half: 135, radius: 60).copy(using: &transform)

        let maskLayer = CAShapeLayer()
        maskLayer.frame = gradLayer.bounds
        maskLayer.path = scaledPath
        maskLayer.fillColor = UIColor.clear.cgColor
        maskLayer.strokeColor = UIColor.white.cgColor
        maskLayer.lineWidth = 3.0 * s
        gradLayer.mask = maskLayer

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: pixels, height: pixels), format: format)
        return renderer.image { rc in
            gradLayer.render(in: rc.cgContext)
        }.cgImage
    }

    private func renderGlassLayer() -> CGImage? {
        return rasterLayer(half: 130) { ctx in
            let rect = CGRect(x: -128.5, y: -128.5, width: 257, height: 257)
            let path = UIBezierPath(roundedRect: rect, cornerRadius: 54).cgPath
            ctx.saveGState()
            ctx.addPath(path)
            ctx.clip()
            if let grad = Self.makeGradient(colors: [0xff4b2c3f, 0xff291421, 0xff170c18, 0xff351622], locations: [0.0, 0.13, 0.78, 1.0]) {
                ctx.drawLinearGradient(grad, start: CGPoint(x: -80, y: -129), end: CGPoint(x: 80, y: 129), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }
            ctx.restore()

            let strokeRect = CGRect(x: -127.8, y: -127.8, width: 255.6, height: 255.6)
            ctx.addPath(UIBezierPath(roundedRect: strokeRect, cornerRadius: 54).cgPath)
            ctx.setStrokeColor(Self.argbColor(0x86fbe0d4).cgColor)
            ctx.setLineWidth(1.5)
            ctx.strokePath()
        }
    }

    private func renderOuterRing() -> CGImage? {
        return rasterLayer(half: 91) { ctx in
            ctx.setStrokeColor(Self.argbColor(0x73fbe0d4).cgColor)
            ctx.setLineWidth(1.5)
            ctx.setLineDash(phase: 0, lengths: [4.5, 3.0])
            ctx.addArc(center: .zero, radius: 89, startAngle: 0, endAngle: .pi * 2.0, clockwise: false)
            ctx.strokePath()
        }
    }

    private func renderMiddleRing() -> CGImage? {
        return rasterLayer(half: 79) { ctx in
            ctx.setStrokeColor(Self.argbColor(0x8cf43f5e).cgColor)
            ctx.setLineWidth(1.0)
            ctx.setLineDash(phase: 0, lengths: [1.0, 2.4])
            ctx.addArc(center: .zero, radius: 77, startAngle: 0, endAngle: .pi * 2.0, clockwise: false)
            ctx.strokePath()
        }
    }

    private func renderInnerRing() -> CGImage? {
        return rasterLayer(half: 66) { ctx in
            ctx.setLineWidth(1.5)
            ctx.setStrokeColor(Self.argbColor(0x33ffffff).cgColor)
            ctx.addArc(center: .zero, radius: 64, startAngle: 0, endAngle: .pi * 2.0, clockwise: false)
            ctx.strokePath()

            ctx.setStrokeColor(Self.argbColor(0xfffbe0d4).cgColor)
            ctx.addArc(center: .zero, radius: 64, startAngle: 225.0 * .pi / 180.0, endAngle: 315.0 * .pi / 180.0, clockwise: false)
            ctx.strokePath()

            ctx.setStrokeColor(Self.argbColor(0xff06b6d4).cgColor)
            ctx.addArc(center: .zero, radius: 64, startAngle: 45.0 * .pi / 180.0, endAngle: 135.0 * .pi / 180.0, clockwise: false)
            ctx.strokePath()
        }
    }

    private func renderPrismLayer() -> CGImage? {
        // Exact port of app/src/main/res/drawable/startup_prism.xml (200x200 viewport mapped to -80..+80)
        return rasterLayer(half: 38) { ctx in
            ctx.saveGState()
            ctx.translateBy(x: -80, y: -80)
            ctx.scaleBy(x: 160.0 / 200.0, y: 160.0 / 200.0)

            // Center radial aura
            if let rad = Self.makeGradient(colors: [0x59ffffff, 0x40fbe0d4, 0x26f43f5e, 0x00f43f5e], locations: [0.0, 0.4, 0.75, 1.0]) {
                let c = CGPoint(x: 100, y: 100)
                ctx.drawRadialGradient(rad, startCenter: c, startRadius: 0, endCenter: c, endRadius: 38, options: [])
            }

            func polygonPath(_ pts: [(CGFloat, CGFloat)]) -> CGPath {
                let p = CGMutablePath()
                if let first = pts.first {
                    p.move(to: CGPoint(x: first.0, y: first.1))
                    for pt in pts.dropFirst() {
                        p.addLine(to: CGPoint(x: pt.0, y: pt.1))
                    }
                    p.closeSubpath()
                }
                return p
            }

            func drawSolidFacet(_ pts: [(CGFloat, CGFloat)], fill: UInt32, stroke: UInt32, alpha: CGFloat, lineWidth: CGFloat) {
                let path = polygonPath(pts)
                ctx.saveGState()
                ctx.setAlpha(alpha)
                ctx.addPath(path)
                ctx.setFillColor(Self.argbColor(fill).cgColor)
                ctx.fillPath()
                ctx.addPath(path)
                ctx.setStrokeColor(Self.argbColor(stroke).cgColor)
                ctx.setLineWidth(lineWidth)
                ctx.strokePath()
                ctx.restore()
            }

            // Central octagon
            let oct = polygonPath([(88,72),(112,72),(128,88),(128,112),(112,128),(88,128),(72,112),(72,88)])
            ctx.saveGState()
            ctx.setAlpha(0.85)
            ctx.addPath(oct)
            ctx.clip()
            if let octGrad = Self.makeGradient(colors: [0x73fbe0d4, 0x66f43f5e, 0x6bc084fc, 0x7306b6d4], locations: [0.0, 0.35, 0.7, 1.0]) {
                ctx.drawLinearGradient(octGrad, start: CGPoint(x: 72, y: 72), end: CGPoint(x: 128, y: 128), options: [])
            }
            ctx.restore()
            ctx.saveGState()
            ctx.setAlpha(0.85)
            ctx.addPath(oct)
            ctx.setStrokeColor(Self.argbColor(0x99ffffff).cgColor)
            ctx.setLineWidth(0.8)
            ctx.strokePath()
            ctx.restore()

            // Cardinal facets
            drawSolidFacet([(100,56),(88,72),(112,72)], fill: 0x99ffffff, stroke: 0xb2fbe0d4, alpha: 0.8, lineWidth: 0.6)
            drawSolidFacet([(100,144),(88,128),(112,128)], fill: 0xa6f43f5e, stroke: 0xb2fbe0d4, alpha: 0.8, lineWidth: 0.6)
            drawSolidFacet([(56,100),(72,88),(72,112)], fill: 0xa606b6d4, stroke: 0xb2fbe0d4, alpha: 0.8, lineWidth: 0.6)
            drawSolidFacet([(144,100),(128,88),(128,112)], fill: 0xa6fbe0d4, stroke: 0xb2fbe0d4, alpha: 0.8, lineWidth: 0.6)

            // Top-left gradient facet
            let tl = polygonPath([(68,68),(72,88),(88,72)])
            ctx.saveGState()
            ctx.setAlpha(0.75)
            ctx.addPath(tl)
            ctx.clip()
            if let tlGrad = Self.makeGradient(colors: [0xb2ffffff, 0xa6c084fc, 0xb2f43f5e, 0x9938bdf8], locations: [0.0, 0.4, 0.75, 1.0]) {
                ctx.drawLinearGradient(tlGrad, start: CGPoint(x: 88, y: 68), end: CGPoint(x: 68, y: 88), options: [])
            }
            ctx.restore()
            ctx.saveGState()
            ctx.setAlpha(0.75)
            ctx.addPath(tl)
            ctx.setStrokeColor(Self.argbColor(0xb2ffffff).cgColor)
            ctx.setLineWidth(0.6)
            ctx.strokePath()
            ctx.restore()

            // Other diagonal & outer facets
            drawSolidFacet([(132,68),(112,72),(128,88)], fill: 0xa6ffffff, stroke: 0xb2ffffff, alpha: 0.75, lineWidth: 0.6)
            drawSolidFacet([(68,132),(72,112),(88,128)], fill: 0x99f43f5e, stroke: 0xb2ffffff, alpha: 0.75, lineWidth: 0.6)
            drawSolidFacet([(132,132),(128,112),(112,128)], fill: 0x9938bdf8, stroke: 0xb2ffffff, alpha: 0.75, lineWidth: 0.6)

            drawSolidFacet([(100,56),(68,68),(88,72)], fill: 0x73ffffff, stroke: 0x80fbe0d4, alpha: 1.0, lineWidth: 0.5)
            drawSolidFacet([(100,56),(132,68),(112,72)], fill: 0x8cfbe0d4, stroke: 0x80fbe0d4, alpha: 1.0, lineWidth: 0.5)
            drawSolidFacet([(100,144),(68,132),(88,128)], fill: 0x80f43f5e, stroke: 0x80fbe0d4, alpha: 1.0, lineWidth: 0.5)
            drawSolidFacet([(100,144),(132,132),(112,128)], fill: 0x8cc084fc, stroke: 0x80fbe0d4, alpha: 1.0, lineWidth: 0.5)

            ctx.restore()
        }
    }

    // Exact 10 cubic Bezier strokes from Android StartupWordmark.kt
    private static func buildWordmarkStrokes() -> [SampledStroke] {
        enum Seg {
            case line(CGPoint)
            case cubic(CGPoint, CGPoint, CGPoint)
        }
        func sampleStroke(start: CGPoint, segments: [Seg]) -> SampledStroke {
            var pts: [CGPoint] = [start]
            var cur = start
            for seg in segments {
                switch seg {
                case .line(let to):
                    pts.append(to)
                    cur = to
                case .cubic(let c1, let c2, let to):
                    let steps = 28
                    for i in 1...steps {
                        let t = CGFloat(i) / CGFloat(steps)
                        let mt = 1.0 - t
                        let x = mt*mt*mt*cur.x + 3*mt*mt*t*c1.x + 3*mt*t*t*c2.x + t*t*t*to.x
                        let y = mt*mt*mt*cur.y + 3*mt*mt*t*c1.y + 3*mt*t*t*c2.y + t*t*t*to.y
                        pts.append(CGPoint(x: x, y: y))
                    }
                    cur = to
                }
            }
            var cum: [CGFloat] = [0]
            var total: CGFloat = 0
            for i in 1..<pts.count {
                total += hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
                cum.append(total)
            }
            return SampledStroke(points: pts, cumulativeLengths: cum, totalLength: total)
        }

        return [
            // P
            sampleStroke(start: CGPoint(x: 14, y: 70), segments: [
                .cubic(CGPoint(x: 18, y: 50), CGPoint(x: 25, y: 13), CGPoint(x: 31, y: 10)),
                .cubic(CGPoint(x: 41, y: 5), CGPoint(x: 62, y: 10), CGPoint(x: 59, y: 25)),
                .cubic(CGPoint(x: 55, y: 42), CGPoint(x: 32, y: 42), CGPoint(x: 25, y: 32))
            ]),
            // i stem
            sampleStroke(start: CGPoint(x: 60, y: 49), segments: [
                .cubic(CGPoint(x: 56, y: 61), CGPoint(x: 54, y: 72), CGPoint(x: 62, y: 69)),
                .cubic(CGPoint(x: 67, y: 66), CGPoint(x: 71, y: 61), CGPoint(x: 74, y: 55))
            ]),
            // i dot
            sampleStroke(start: CGPoint(x: 64, y: 38), segments: [
                .line(CGPoint(x: 64.2, y: 37.8))
            ]),
            // c
            sampleStroke(start: CGPoint(x: 94, y: 50), segments: [
                .cubic(CGPoint(x: 83, y: 38), CGPoint(x: 66, y: 59), CGPoint(x: 75, y: 68)),
                .cubic(CGPoint(x: 82, y: 74), CGPoint(x: 93, y: 64), CGPoint(x: 99, y: 58))
            ]),
            // S
            sampleStroke(start: CGPoint(x: 139, y: 20), segments: [
                .cubic(CGPoint(x: 139, y: 7), CGPoint(x: 118, y: 5), CGPoint(x: 111, y: 15)),
                .cubic(CGPoint(x: 96, y: 33), CGPoint(x: 134, y: 38), CGPoint(x: 133, y: 54)),
                .cubic(CGPoint(x: 133, y: 77), CGPoint(x: 105, y: 77), CGPoint(x: 100, y: 66))
            ]),
            // h
            sampleStroke(start: CGPoint(x: 141, y: 67), segments: [
                .cubic(CGPoint(x: 146, y: 49), CGPoint(x: 164, y: 9), CGPoint(x: 157, y: 10)),
                .cubic(CGPoint(x: 147, y: 13), CGPoint(x: 144, y: 47), CGPoint(x: 141, y: 67)),
                .cubic(CGPoint(x: 151, y: 45), CGPoint(x: 162, y: 45), CGPoint(x: 159, y: 61)),
                .cubic(CGPoint(x: 154, y: 76), CGPoint(x: 164, y: 69), CGPoint(x: 170, y: 63))
            ]),
            // e
            sampleStroke(start: CGPoint(x: 169, y: 60), segments: [
                .cubic(CGPoint(x: 183, y: 60), CGPoint(x: 188, y: 46), CGPoint(x: 177, y: 48)),
                .cubic(CGPoint(x: 164, y: 50), CGPoint(x: 165, y: 70), CGPoint(x: 176, y: 70)),
                .cubic(CGPoint(x: 183, y: 70), CGPoint(x: 191, y: 63), CGPoint(x: 195, y: 57))
            ]),
            // l
            sampleStroke(start: CGPoint(x: 194, y: 60), segments: [
                .cubic(CGPoint(x: 210, y: 43), CGPoint(x: 219, y: 11), CGPoint(x: 212, y: 10)),
                .cubic(CGPoint(x: 203, y: 11), CGPoint(x: 188, y: 69), CGPoint(x: 198, y: 70)),
                .cubic(CGPoint(x: 204, y: 71), CGPoint(x: 210, y: 63), CGPoint(x: 214, y: 59))
            ]),
            // f
            sampleStroke(start: CGPoint(x: 213, y: 83), segments: [
                .cubic(CGPoint(x: 215, y: 61), CGPoint(x: 231, y: 9), CGPoint(x: 240, y: 13)),
                .cubic(CGPoint(x: 250, y: 20), CGPoint(x: 223, y: 45), CGPoint(x: 218, y: 48)),
                .cubic(CGPoint(x: 216, y: 54), CGPoint(x: 234, y: 56), CGPoint(x: 228, y: 72)),
                .cubic(CGPoint(x: 224, y: 80), CGPoint(x: 216, y: 88), CGPoint(x: 213, y: 83))
            ]),
            // f crossbar
            sampleStroke(start: CGPoint(x: 209, y: 45), segments: [
                .cubic(CGPoint(x: 219, y: 44), CGPoint(x: 232, y: 47), CGPoint(x: 239, y: 45))
            ])
        ]
    }
}

// MARK: - Main ViewController

class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {

    private var webView: WKWebView!
    private let bridge = AuraBridge()
    private let backdropSchemeHandler = BackdropSchemeHandler()
    private let originalsSchemeHandler = PicShelfOriginalsSchemeHandler()
    private let thumbnailsSchemeHandler = PicShelfThumbnailsSchemeHandler()
    private var currentStatusBarStyle: UIStatusBarStyle = .lightContent
    private var desiredTheme: String = "dark"
    private var startupCoverView: PicShelfStartupCoverView?
    private var isWebStartupReady: Bool = false
    private var startupDismissWorkItem: DispatchWorkItem?
    private var startupSafetyWorkItem: DispatchWorkItem?

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return startupCoverView != nil ? .lightContent : currentStatusBarStyle
    }

    override var prefersStatusBarHidden: Bool {
        return false
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 9/255, green: 3/255, blue: 12/255, alpha: 1)

        // Ensure video & audio playback works at full volume even when iPhone mute switch is on
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [])
        try? AVAudioSession.sharedInstance().setActive(true)

        // Start loopback HTTP/1.1 Range media server (zero-deadlock streaming for 24h+ videos)
        PicShelfLocalMediaServer.shared.start()

        setupWebView()
        setupStartupCover()
        loadLocalApp()
    }

    private func setupStartupCover() {
        let cover = PicShelfStartupCoverView(frame: view.bounds)
        cover.translatesAutoresizingMaskIntoConstraints = false
        cover.onWordmarkComplete = { [weak self] in
            self?.tryDismissStartupCoverIfReady()
        }
        view.addSubview(cover)
        NSLayoutConstraint.activate([
            cover.topAnchor.constraint(equalTo: view.topAnchor),
            cover.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            cover.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            cover.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        startupCoverView = cover
        cover.startAnimation()

        // Safety fallback so startup cover can never get stuck even if WebView fails to signal readiness
        let safety = DispatchWorkItem { [weak self] in
            self?.dismissStartupCover(animated: true)
        }
        startupSafetyWorkItem = safety
        DispatchQueue.main.asyncAfter(deadline: .now() + 15.0, execute: safety)
    }

    func updateStartupLanguage(_ lang: String) {
        startupCoverView?.updateLanguage(lang)
    }

    func onWebStartupReady() {
        isWebStartupReady = true
        tryDismissStartupCoverIfReady()
    }

    func onWebStartupFailed() {
        dismissStartupCover(animated: true)
    }

    private func tryDismissStartupCoverIfReady() {
        guard isWebStartupReady, let cover = startupCoverView else { return }
        if cover.wordmarkCompleted {
            startupDismissWorkItem?.cancel()
            startupDismissWorkItem = nil
            // Brief 180ms pause so the completed "PicShelf" signature settles cleanly before revealing Dock
            let work = DispatchWorkItem { [weak self] in
                self?.dismissStartupCover(animated: true)
            }
            startupDismissWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
        }
    }

    private func dismissStartupCover(animated: Bool) {
        startupDismissWorkItem?.cancel()
        startupDismissWorkItem = nil
        startupSafetyWorkItem?.cancel()
        startupSafetyWorkItem = nil
        guard let cover = startupCoverView else { return }
        startupCoverView = nil
        setNeedsStatusBarAppearanceUpdate()
        if animated {
            UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut]) {
                cover.alpha = 0
            } completion: { _ in
                cover.stopAnimation()
                cover.removeFromSuperview()
            }
        } else {
            cover.stopAnimation()
            cover.removeFromSuperview()
        }
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
        desiredTheme = theme
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
        PicShelfLocalMediaServer.shared.ensureRunning()
        try? AVAudioSession.sharedInstance().setActive(true)
        startupCoverView?.startAnimation()
        bridge.startSensors()
        let origLit = PicShelfLocalMediaServer.shared.originalsOrigin.map { "\"\($0)\"" } ?? "null"
        let thumbLit = PicShelfLocalMediaServer.shared.thumbnailsOrigin.map { "\"\($0)\"" } ?? "null"
        webView?.evaluateJavaScript(
            "window.__PICSHELF_IOS_ORIGINALS_ORIGIN = \(origLit); window.__PICSHELF_IOS_THUMBNAILS_ORIGIN = \(thumbLit); if (window.state && window.state.biometricLock && window.state.isAppLocked) { if (window.showAppLock) window.showAppLock(); }",
            completionHandler: nil
        )
    }

    func notifyAppInactive() {
        startupCoverView?.stopAnimation()
        bridge.stopSensors()
        webView?.evaluateJavaScript(
            "(function(){ try { var v = document.getElementById('detailVideo'); if (v && !v.paused) { if (typeof silenceIosAudioForPause === 'function') silenceIosAudioForPause(v); v.pause(); } } catch(_){} if (window.state && window.state.biometricLock) { window.state.isAppLocked = true; if (window.showAppLock) window.showAppLock(); } })();",
            completionHandler: nil
        )
    }

    // MARK: - Setup WebView

    private func setupWebView() {
        let contentController = WKUserContentController()

        // 1. Add native bridge message handler
        bridge.viewController = self
        contentController.add(bridge, name: "auraBridge")

        // 2. Snapshot existing durable source IDs & loopback media server origins
        PicShelfLocalMediaServer.shared.ensureRunning()
        let existingIds = PicShelfMediaStore.shared.allSourceIds()
        let idsJsonData = (try? JSONSerialization.data(withJSONObject: existingIds, options: [])) ?? Data("[]".utf8)
        let idsJsonLiteral = String(data: idsJsonData, encoding: .utf8) ?? "[]"
        let originalsOriginLiteral = PicShelfLocalMediaServer.shared.originalsOrigin.map { "\"\($0)\"" } ?? "null"
        let thumbsOriginLiteral = PicShelfLocalMediaServer.shared.thumbnailsOrigin.map { "\"\($0)\"" } ?? "null"

        // 3. Inject compatibility shim for AndroidApp & iOS native bridge
        let bridgeShimScript = """
        (function() {
            window.isNativeIOS = true;
            window.__PICSHELF_IOS_ORIGINALS_ORIGIN = \(originalsOriginLiteral);
            window.__PICSHELF_IOS_THUMBNAILS_ORIGIN = \(thumbsOriginLiteral);
            window.__iosKnownSourceIds = new Set(\(idsJsonLiteral));

            const send = function(action, payload) {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.auraBridge) {
                    window.webkit.messageHandlers.auraBridge.postMessage(Object.assign({ action: action }, payload || {}));
                }
            };

            let iosStreamSeq = 0;
            const nativeBridge = {
                openCamera: function() { send('openCamera'); },
                openGallery: function() { send('openGallery'); },
                openGalleryForAlbum: function(album) { send('openGalleryForAlbum', { album: album }); },
                beginDownloadStream: function(sessionId, expectedSize) {
                    iosStreamSeq++;
                    var token = 'ios_stream_' + Date.now() + '_' + iosStreamSeq;
                    send('beginDownloadStream', { token: token, sessionId: String(sessionId || ''), expectedSize: Number(expectedSize || 0) });
                    return token;
                },
                appendDownloadStream: function(token, base64) {
                    send('appendDownloadStream', { token: String(token || ''), base64: String(base64 || '') });
                    return true;
                },
                sealDownloadStream: function(token) {
                    send('sealDownloadStream', { token: String(token || '') });
                    return true;
                },
                discardDownloadStream: function(token) {
                    send('discardDownloadStream', { token: String(token || '') });
                },
                executeDownloadChunk: function(payloadJson) {
                    send('executeDownloadChunk', { payloadJson: typeof payloadJson === 'string' ? payloadJson : JSON.stringify(payloadJson || {}) });
                },
                verifyDownloadedFiles: function(itemsJson) {
                    return new Promise(function(resolve) {
                        var reqId = 'vdf_' + Date.now() + '_' + (++iosStreamSeq);
                        window._iosVerifyCallbacks = window._iosVerifyCallbacks || {};
                        var timer = setTimeout(function() {
                            if (window._iosVerifyCallbacks && window._iosVerifyCallbacks[reqId]) {
                                delete window._iosVerifyCallbacks[reqId];
                                resolve(null);
                            }
                        }, 4000);
                        window._iosVerifyCallbacks[reqId] = function(result) {
                            clearTimeout(timer);
                            if (window._iosVerifyCallbacks) delete window._iosVerifyCallbacks[reqId];
                            resolve(result);
                        };
                        send('verifyDownloadedFiles', {
                            requestId: reqId,
                            itemsJson: typeof itemsJson === 'string' ? itemsJson : JSON.stringify(itemsJson || [])
                        });
                    });
                },
                resumeDownloadSession: function(sessionId) {
                    send('resumeDownloadSession', { sessionId: String(sessionId || '') });
                },
                cancelDownloadSession: function(sessionId) {
                    send('cancelDownloadSession', { sessionId: String(sessionId || '') });
                },
                cancelDownloadItem: function(sessionId, itemId) {
                    send('cancelDownloadItem', { sessionId: String(sessionId || ''), itemId: String(itemId || '') });
                    return true;
                },
                acknowledgeVideoDownloadResult: function(sessionId) { return true; },
                discardCancelledVideoDownload: function(sessionId, uri) {
                    send('discardCancelledVideoDownload', { sessionId: String(sessionId || ''), uri: String(uri || '') });
                    return true;
                },
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
                    var code = String(lang || 'en');
                    try { localStorage.setItem('app_language', code); } catch(_) {}
                    send('setStartupLanguage', { language: code });
                },
                onStartupReady: function() { send('onStartupReady'); },
                onStartupFailed: function() { send('onStartupFailed'); },
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
