import UIKit
import WebKit
import UniformTypeIdentifiers
import Compression
import ImageIO
import AVFoundation
import PDFKit
import UserNotifications

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
        if safeId.hasPrefix("held_") && safeId.hasSuffix(".tar") {
            let jobId = String(safeId.dropFirst(5).dropLast(4))
            if UUID(uuidString: jobId) != nil {
                return PicShelfBackupManager.shared.heldArchiveURL(for: jobId)
            }
        }
        return sourcesDir.appendingPathComponent(safeId)
    }

    func adoptFile(from tempURL: URL, ext: String) -> (sourceId: String, fileURL: URL, size: Int64)? {
        let safeExt = sanitizeExtension(ext)
        let sourceId = "\(UUID().uuidString.lowercased()).\(safeExt)"
        let dstURL = sourcesDir.appendingPathComponent(sourceId)
        markImporting(sourceId)
        do {
            if FileManager.default.fileExists(atPath: dstURL.path) {
                try FileManager.default.removeItem(at: dstURL)
            }
            try FileManager.default.moveItem(at: tempURL, to: dstURL)
            let attrs = try FileManager.default.attributesOfItem(atPath: dstURL.path)
            let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
            return (sourceId, dstURL, size)
        } catch {
            unmarkImporting(sourceId)
            return nil
        }
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

    var backupOrigin: String? {
        guard port > 0 else { return nil }
        return "http://127.0.0.1:\(port)/\(secretPath)/backup/"
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

        // Read HTTP request headers up to 32 KB (preserving any body bytes that arrived in the same packet)
        var reqData = Data()
        var buf = [UInt8](repeating: 0, count: 65536)
        let headerDelim = Data("\r\n\r\n".utf8)
        var headerEndRange: Range<Data.Index>? = nil
        while reqData.count < 32768 {
            let n = Darwin.recv(fd, &buf, buf.count, 0)
            if n <= 0 { break }
            reqData.append(buf, count: n)
            if let r = reqData.range(of: headerDelim) {
                headerEndRange = r
                break
            }
        }
        guard let hRange = headerEndRange,
              let headerStr = String(data: reqData[..<hRange.lowerBound], encoding: .utf8) else { return }

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
            let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type\r\nAccess-Control-Max-Age: 86400\r\nConnection: close\r\n\r\n"
            _ = writeAll(fd, Data(resp.utf8))
            return
        }

        guard httpMethod == "GET" || httpMethod == "HEAD" || httpMethod == "POST" else {
            sendSimpleError(fd, code: 405, reason: "Method Not Allowed")
            return
        }

        guard let fullURL = URL(string: "http://127.0.0.1\(rawTarget)") else {
            sendSimpleError(fd, code: 400, reason: "Bad Request")
            return
        }

        let comps = fullURL.pathComponents.filter { $0 != "/" }
        guard comps.count >= 2, comps[0] == secretPath else {
            sendSimpleError(fd, code: 403, reason: "Forbidden")
            return
        }

        let route = comps[1]
        let urlComps = URLComponents(url: fullURL, resolvingAgainstBaseURL: false)

        if route == "backup" && comps.count >= 3 {
            let endpoint = comps[2]
            var bodyData = Data(reqData[hRange.upperBound...])
            if let clStr = headersMap["content-length"], let expectedLen = Int(clStr), expectedLen > 0, expectedLen <= 16 * 1024 * 1024 {
                if bodyData.count < expectedLen {
                    bodyData.reserveCapacity(expectedLen)
                    while bodyData.count < expectedLen {
                        let remain = min(buf.count, expectedLen - bodyData.count)
                        let n = Darwin.recv(fd, &buf, remain, 0)
                        if n <= 0 { break }
                        bodyData.append(buf, count: n)
                    }
                }
                if bodyData.count > expectedLen {
                    bodyData = bodyData.prefix(expectedLen)
                }
            }
            var queryMap: [String: String] = [:]
            for qi in (urlComps?.queryItems ?? []) {
                queryMap[qi.name] = qi.value ?? ""
            }
            let reply = PicShelfBackupManager.shared.handleHTTP(endpoint: endpoint, query: queryMap, body: bodyData)
            let reason = (reply.status == 200) ? "OK" : "Error"
            let header = "HTTP/1.1 \(reply.status) \(reason)\r\nContent-Type: \(reply.contentType)\r\nContent-Length: \(reply.body.count)\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            guard writeAll(fd, Data(header.utf8)) else { return }
            if httpMethod != "HEAD" && !reply.body.isEmpty {
                _ = writeAll(fd, reply.body)
            }
            return
        }

        // Expected media route: [secretPath, "originals"|"thumbs", token, kind/mode, offset, size, method]
        guard comps.count >= 7,
              let token = comps[2].removingPercentEncoding,
              let offset = UInt64(comps[4]),
              let size = UInt64(comps[5]),
              let method = Int(comps[6]),
              let srcURL = PicShelfMediaStore.shared.sourceURL(for: token),
              FileManager.default.fileExists(atPath: srcURL.path) else {
            sendSimpleError(fd, code: 404, reason: "Not Found")
            return
        }

        let modeOrKind = comps[3].lowercased()
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

// MARK: - Full Cross-Platform PicShelf Backup & Restore Engine (.picshelf TAR + GZIP + Background + Checkpoints + Notifications)

enum BackupCRC32 {
    private static let table: [UInt32] = {
        var t = [UInt32](repeating: 0, count: 256)
        for i in 0..<256 {
            var c = UInt32(i)
            for _ in 0..<8 {
                c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1)
            }
            t[i] = c
        }
        return t
    }()

    static func update(_ crc: UInt32, data: Data) -> UInt32 {
        var c = crc ^ 0xFFFFFFFF
        data.withUnsafeBytes { raw in
            for b in raw {
                let idx = Int((c ^ UInt32(b)) & 0xFF)
                c = table[idx] ^ (c >> 8)
            }
        }
        return c ^ 0xFFFFFFFF
    }
}

private final class GzipStreamWriter {
    private let fileHandle: FileHandle
    private let streamPtr: UnsafeMutablePointer<compression_stream>
    private let dstBuf: UnsafeMutablePointer<UInt8>
    private let bufSize = 65536
    private var crc: UInt32 = 0
    private var totalIn: UInt64 = 0
    private var closed = false

    init?(url: URL) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let fh = try? FileHandle(forWritingTo: url) else { return nil }
        let sPtr = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        if compression_stream_init(sPtr, COMPRESSION_STREAM_ENCODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_ERROR {
            sPtr.deallocate()
            try? fh.close()
            return nil
        }
        self.fileHandle = fh
        self.streamPtr = sPtr
        self.dstBuf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
        // Standard RFC 1952 GZIP 10-byte header
        let hdr = Data([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03])
        fh.write(hdr)
    }

    deinit {
        if !closed { close() }
        dstBuf.deallocate()
        streamPtr.deallocate()
    }

    func write(_ data: Data) -> Bool {
        guard !closed else { return false }
        if data.isEmpty { return true }
        crc = BackupCRC32.update(crc, data: data)
        totalIn &+= UInt64(data.count)
        return data.withUnsafeBytes { rawBuf -> Bool in
            guard let ptr = rawBuf.bindMemory(to: UInt8.self).baseAddress else { return true }
            streamPtr.pointee.src_ptr = ptr
            streamPtr.pointee.src_size = data.count
            while streamPtr.pointee.src_size > 0 {
                streamPtr.pointee.dst_ptr = dstBuf
                streamPtr.pointee.dst_size = bufSize
                let status = compression_stream_process(streamPtr, 0)
                let produced = bufSize - streamPtr.pointee.dst_size
                if produced > 0 {
                    let out = Data(bytesNoCopy: dstBuf, count: produced, deallocator: .none)
                    fileHandle.write(out)
                }
                if status == COMPRESSION_STATUS_ERROR { return false }
            }
            return true
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        streamPtr.pointee.src_ptr = UnsafePointer(dstBuf)
        streamPtr.pointee.src_size = 0
        while true {
            streamPtr.pointee.dst_ptr = dstBuf
            streamPtr.pointee.dst_size = bufSize
            let status = compression_stream_process(streamPtr, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
            let produced = bufSize - streamPtr.pointee.dst_size
            if produced > 0 {
                let out = Data(bytesNoCopy: dstBuf, count: produced, deallocator: .none)
                fileHandle.write(out)
            }
            if status == COMPRESSION_STATUS_END || status == COMPRESSION_STATUS_ERROR { break }
        }
        compression_stream_destroy(streamPtr)
        var trailer = Data(capacity: 8)
        var cLE = crc.littleEndian
        var sLE = UInt32(truncatingIfNeeded: totalIn).littleEndian
        withUnsafeBytes(of: &cLE) { trailer.append(contentsOf: $0) }
        withUnsafeBytes(of: &sLE) { trailer.append(contentsOf: $0) }
        fileHandle.write(trailer)
        try? fileHandle.close()
    }
}

private enum BackupGzipHelper {
    static func compress(_ data: Data) -> Data? {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ps_gz_\(UUID().uuidString).gz")
        defer { try? FileManager.default.removeItem(at: tmp) }
        guard let w = GzipStreamWriter(url: tmp) else { return nil }
        guard w.write(data) else { w.close(); return nil }
        w.close()
        return try? Data(contentsOf: tmp)
    }

    static func decompress(_ data: Data) -> Data? {
        let tmpIn = FileManager.default.temporaryDirectory.appendingPathComponent("ps_gzi_\(UUID().uuidString).gz")
        let tmpOut = FileManager.default.temporaryDirectory.appendingPathComponent("ps_gzo_\(UUID().uuidString).bin")
        defer {
            try? FileManager.default.removeItem(at: tmpIn)
            try? FileManager.default.removeItem(at: tmpOut)
        }
        guard (try? data.write(to: tmpIn)) != nil,
              PicShelfMediaStore.shared.decompressGzipFile(from: tmpIn, to: tmpOut) != nil else { return nil }
        return try? Data(contentsOf: tmpOut)
    }
}

private enum BackupTarHelper {
    static let blockSize: UInt64 = 512
    static let maxOctalSize: UInt64 = 8_589_934_591

    static func padding(for size: UInt64) -> Int {
        return Int((blockSize - (size % blockSize)) % blockSize)
    }

    static func span(for size: UInt64) -> UInt64 {
        return blockSize + size + UInt64(padding(for: size))
    }

    static func header(name: String, size: UInt64, mtimeSeconds: UInt64) -> Data {
        var bytes = [UInt8](repeating: 0, count: 512)
        let nameUtf8 = Array(name.utf8.prefix(100))
        for (i, b) in nameUtf8.enumerated() { bytes[i] = b }

        func writeOctal(_ val: UInt64, offset: Int, length: Int) {
            let oct = String(val, radix: 8)
            let digits = length - 1
            let padded = oct.count >= digits ? String(oct.suffix(digits)) : (String(repeating: "0", count: digits - oct.count) + oct)
            for (i, b) in padded.utf8.enumerated() { bytes[offset + i] = b }
            bytes[offset + length - 1] = 0
        }

        writeOctal(0o644, offset: 100, length: 8)
        writeOctal(0, offset: 108, length: 8)
        writeOctal(0, offset: 116, length: 8)
        if size <= maxOctalSize {
            writeOctal(size, offset: 124, length: 12)
        } else {
            bytes[124] = 0x80
            var v = size
            for idx in stride(from: 135, through: 125, by: -1) {
                bytes[idx] = UInt8(v & 0xFF)
                v >>= 8
            }
        }
        writeOctal(min(mtimeSeconds, maxOctalSize), offset: 136, length: 12)
        for i in 148..<156 { bytes[i] = 0x20 }
        bytes[156] = UInt8(ascii: "0")
        for (i, b) in "ustar".utf8.enumerated() { bytes[257 + i] = b }
        bytes[263] = UInt8(ascii: "0")
        bytes[264] = UInt8(ascii: "0")
        for (i, b) in "picshelf".utf8.enumerated() { bytes[265 + i] = b }
        for (i, b) in "picshelf".utf8.enumerated() { bytes[297 + i] = b }

        var sum: UInt64 = 0
        for b in bytes { sum += UInt64(b) }
        let sumOct = String(sum, radix: 8)
        let sumStr = sumOct.count >= 6 ? String(sumOct.suffix(6)) : (String(repeating: "0", count: 6 - sumOct.count) + sumOct)
        for (i, b) in sumStr.utf8.enumerated() { bytes[148 + i] = b }
        bytes[154] = 0
        bytes[155] = 0x20
        return Data(bytes)
    }

    static func isHeader(_ data: Data) -> Bool {
        guard data.count >= 512 else { return false }
        var allZero = true
        for b in data.prefix(512) { if b != 0 { allZero = false; break } }
        if allZero { return false }
        let chkStr = String(data: data.subdata(in: 148..<156), encoding: .ascii)?
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\0"))) ?? ""
        guard let stored = UInt64(chkStr, radix: 8) else { return false }
        var sum: UInt64 = 0
        for i in 0..<512 {
            sum += (i >= 148 && i < 156) ? 0x20 : UInt64(data[i])
        }
        return sum == stored
    }

    static func name(_ data: Data) -> String {
        guard data.count >= 100 else { return "" }
        var end = 0
        while end < 100 && data[end] != 0 { end += 1 }
        return String(data: data.subdata(in: 0..<end), encoding: .utf8) ?? ""
    }
}

final class PicShelfBackupManager {
    static let shared = PicShelfBackupManager()

    private static let locatorName = "picshelf/locator.json"
    private static let freeReserve: UInt64 = 64 * 1024 * 1024
    private static let activeStates: Set<String> = ["preparing", "queued", "running", "cancelling"]
    private static let readmeText = """
PicShelf full library backup.

To restore everything — photos, videos, audio, albums, favorites, Dock, Gallery and Trash:
  Open PicShelf -> Settings -> Import Backup -> choose this file.

Keep a copy somewhere safe (iCloud Drive, Google Drive, a computer or another drive).
The media/ folder inside also holds your original files directly if you ever open this archive on a computer.
"""

    weak var webView: WKWebView?

    private let rootDir: URL
    private let pickedDir: URL
    private let stateLock = NSLock()
    private let workerQueue = DispatchQueue(label: "com.picshelf.ios.backup.worker", qos: .utility)

    private final class PreparingState {
        let id: String
        let dir: URL
        var indexWriter: GzipStreamWriter?
        var planHandle: FileHandle?
        var stageHandle: FileHandle?
        var stageExpected: UInt64 = 0
        var stageWritten: UInt64 = 0
        var entries: Int = 0
        var bytes: UInt64 = 0

        init(id: String, dir: URL) {
            self.id = id
            self.dir = dir
        }
    }

    private final class ReaderState {
        let token: String
        let sourceURL: URL
        let ownedCopyURL: URL?
        let name: String
        let fileSize: UInt64
        let isFull: Bool
        let tableJson: String
        let indexOffset: UInt64
        let indexLength: UInt64
        let plainIndexURL: URL
        let plainFH: FileHandle
        let plainSize: UInt64
        var plainPos: UInt64 = 0
        var closed: Bool = false

        init(token: String, sourceURL: URL, ownedCopyURL: URL?, name: String, fileSize: UInt64,
             isFull: Bool, tableJson: String, indexOffset: UInt64, indexLength: UInt64,
             plainIndexURL: URL, plainFH: FileHandle, plainSize: UInt64) {
            self.token = token
            self.sourceURL = sourceURL
            self.ownedCopyURL = ownedCopyURL
            self.name = name
            self.fileSize = fileSize
            self.isFull = isFull
            self.tableJson = tableJson
            self.indexOffset = indexOffset
            self.indexLength = indexLength
            self.plainIndexURL = plainIndexURL
            self.plainFH = plainFH
            self.plainSize = plainSize
        }
    }

    private var preparing: PreparingState? = nil
    private var liveJobId: String? = nil
    private var liveDone: UInt64 = 0
    private var liveTotal: UInt64 = 0
    private var interruptedPrepare: Bool = false
    private var activeWorkerJobId: String? = nil
    private var cancelRequestedJobIds: Set<String> = []
    private var pausedByOS: Bool = false
    private var readers: [String: ReaderState] = [:]

    private init() {
        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first!
        rootDir = appSupport.appendingPathComponent("PicShelfBackupJobs", isDirectory: true)
        pickedDir = rootDir.appendingPathComponent("_picked", isDirectory: true)
        try? fm.createDirectory(at: rootDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: pickedDir, withIntermediateDirectories: true)

        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        var mRoot = rootDir
        try? mRoot.setResourceValues(rv)

        cleanupOnLaunch()
    }

    private func cleanupOnLaunch() {
        let fm = FileManager.default
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        guard let dirs = try? fm.contentsOfDirectory(at: rootDir, includingPropertiesForKeys: nil) else { return }
        for d in dirs {
            if d.lastPathComponent == "_picked" {
                try? fm.removeItem(at: d)
                try? fm.createDirectory(at: pickedDir, withIntermediateDirectories: true)
                continue
            }
            guard let job = readJob(in: d) else {
                try? fm.removeItem(at: d)
                continue
            }
            let st = job["state"] as? String ?? ""
            let created = (job["createdAt"] as? NSNumber)?.int64Value ?? nowMs
            let age = nowMs - created
            if st == "preparing" {
                interruptedPrepare = true
                deleteJobDir(d, job: job)
            } else if st == "running" {
                // App was terminated while running -> re-queue cleanly from checkpoint
                var updated = job
                updated["state"] = "queued"
                writeJob(updated, in: d)
            } else if (st == "cancelled" || st == "failed") && age > 2 * 86400 * 1000 {
                deleteJobDir(d, job: job)
            } else if st == "done" && (job["type"] as? String) == "export" && age > 14 * 86400 * 1000 {
                deleteJobDir(d, job: job)
            }
            // Protect any pending restore's adopted source archive from retention cleanup
            if (job["type"] as? String) == "restore", st == "done",
               let res = job["result"] as? [String: Any],
               let sid = res["sourceId"] as? String, !sid.isEmpty {
                PicShelfMediaStore.shared.markImporting(sid)
            }
        }
    }

    func heldArchiveURL(for jobId: String) -> URL? {
        guard UUID(uuidString: jobId) != nil else { return nil }
        let u = rootDir.appendingPathComponent(jobId, isDirectory: true).appendingPathComponent("held.tar")
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    private func documentsDir() -> URL {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first!
        try? fm.createDirectory(at: docs, withIntermediateDirectories: true)
        return docs
    }

    private func availableDiskBytes() -> Int64 {
        let url = documentsDir()
        if let vals = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let cap = vals.volumeAvailableCapacityForImportantUsage {
            return cap
        }
        if let attrs = try? FileManager.default.attributesOfFileSystem(forPath: url.path),
           let free = (attrs[.systemFreeSize] as? NSNumber)?.int64Value {
            return free
        }
        return Int64.max / 2
    }

    func freeBytesJson() -> String {
        let free = availableDiskBytes()
        return jsonString(["app": free, "downloads": free])
    }

    private func jobDir(for id: String) -> URL? {
        guard UUID(uuidString: id) != nil else { return nil }
        let d = rootDir.appendingPathComponent(id, isDirectory: true)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: d.path, isDirectory: &isDir), isDir.boolValue else { return nil }
        return d
    }

    private func readJob(in dir: URL) -> [String: Any]? {
        let u = dir.appendingPathComponent("job.json")
        guard let data = try? Data(contentsOf: u),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    private func writeJob(_ job: [String: Any], in dir: URL) {
        let u = dir.appendingPathComponent("job.json")
        if let data = try? JSONSerialization.data(withJSONObject: job, options: []) {
            try? data.write(to: u, options: .atomic)
        }
    }

    private func updateJob(id: String, _ mutate: (inout [String: Any]) -> Void) {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard let d = jobDir(for: id), var job = readJob(in: d) else { return }
        mutate(&job)
        writeJob(job, in: d)
    }

    private func deleteJobDir(_ dir: URL, job: [String: Any]?) {
        if let partial = job?["partial"] as? String, !partial.isEmpty {
            try? FileManager.default.removeItem(atPath: partial)
        }
        try? FileManager.default.removeItem(at: dir)
    }

    private func allJobsUnlocked() -> [[String: Any]] {
        guard let dirs = try? FileManager.default.contentsOfDirectory(at: rootDir, includingPropertiesForKeys: nil) else { return [] }
        return dirs.compactMap { $0.lastPathComponent == "_picked" ? nil : readJob(in: $0) }
    }

    private func jsonString(_ obj: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let str = String(data: data, encoding: .utf8) else { return "{}" }
        return str
    }

    func pushStatusToWebView() {
        let statusStr = statusJson()
        let freeStr = freeBytesJson()
        guard let sLit = try? JSONSerialization.data(withJSONObject: [statusStr], options: []),
              let sArr = String(data: sLit, encoding: .utf8),
              let fLit = try? JSONSerialization.data(withJSONObject: [freeStr], options: []),
              let fArr = String(data: fLit, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(
                "if (window.__iosSetBackupStatus) { window.__iosSetBackupStatus((\(sArr))[0]); } else { window.__iosBackupStatusJson = (\(sArr))[0]; } window.__iosBackupFreeBytesJson = (\(fArr))[0];",
                completionHandler: nil
            )
        }
    }

    func statusJson() -> String {
        stateLock.lock()
        let prepId = preparing?.id
        let jobs = allJobsUnlocked()
        let currentLiveId = liveJobId
        let currentLiveDone = liveDone
        let interrupted = interruptedPrepare
        stateLock.unlock()

        let active = jobs.first { Self.activeStates.contains(($0["state"] as? String) ?? "") }
        let latest = jobs.max {
            (($0["createdAt"] as? NSNumber)?.int64Value ?? 0) < (($1["createdAt"] as? NSNumber)?.int64Value ?? 0)
        }
        let chosen: [String: Any]?
        if let pid = prepId, let d = jobDir(for: pid), let j = readJob(in: d) {
            chosen = j
        } else {
            chosen = active ?? latest
        }

        var out: [String: Any] = ["interrupted": interrupted]
        if let job = chosen {
            let jid = job["id"] as? String ?? ""
            out["id"] = jid
            out["type"] = job["type"] as? String ?? ""
            out["state"] = job["state"] as? String ?? ""
            out["total"] = (job["totalBytes"] as? NSNumber)?.uint64Value ?? 0
            out["error"] = job["error"] as? String ?? ""
            let doneVal = (currentLiveId == jid) ? currentLiveDone : ((job["doneBytes"] as? NSNumber)?.uint64Value ?? 0)
            out["done"] = doneVal
            if let res = job["result"] as? [String: Any] {
                out["result"] = res
            }
        }
        return jsonString(out)
    }

    func clearInterrupted() {
        stateLock.lock()
        interruptedPrepare = false
        stateLock.unlock()
        pushStatusToWebView()
    }

    func acknowledge(id: String) {
        stateLock.lock()
        if let d = jobDir(for: id), let job = readJob(in: d) {
            let st = job["state"] as? String ?? ""
            if !Self.activeStates.contains(st) {
                deleteJobDir(d, job: job)
            }
        }
        stateLock.unlock()
        pushStatusToWebView()
    }

    func cancelJob(id: String) {
        stateLock.lock()
        cancelRequestedJobIds.insert(id)
        if let d = jobDir(for: id), var job = readJob(in: d) {
            let st = job["state"] as? String ?? ""
            if Self.activeStates.contains(st) {
                job["state"] = "cancelling"
                writeJob(job, in: d)
            }
        }
        let isRunningThis = (activeWorkerJobId == id)
        stateLock.unlock()
        if !isRunningThis {
            cleanupCancelled(id: id)
        }
        pushStatusToWebView()
    }

    func shareURL(for id: String) -> URL? {
        guard let d = jobDir(for: id), let job = readJob(in: d),
              let res = job["result"] as? [String: Any] else { return nil }
        if let name = res["name"] as? String, !name.isEmpty {
            let u = documentsDir().appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: u.path) { return u }
        }
        if let uri = res["uri"] as? String, let u = URL(string: uri), u.isFileURL,
           FileManager.default.fileExists(atPath: u.path) {
            return u
        }
        return nil
    }

    func resumeQueuedJobsIfNeeded(pushUpdate: Bool = true) {
        stateLock.lock()
        pausedByOS = false
        let jobs = allJobsUnlocked()
        let alreadyActive = (activeWorkerJobId != nil)
        stateLock.unlock()

        guard !alreadyActive else {
            if pushUpdate { pushStatusToWebView() }
            return
        }
        if let queued = jobs.first(where: { ($0["state"] as? String) == "queued" }),
           let jid = queued["id"] as? String {
            scheduleWorker(jobId: jid)
        }
        if pushUpdate { pushStatusToWebView() }
    }

    // MARK: - HTTP Router for Loopback Backup Endpoints

    func handleHTTP(endpoint: String, query: [String: String], body: Data) -> (status: Int, contentType: String, body: Data) {
        func jsonResp(_ str: String) -> (Int, String, Data) {
            return (200, "application/json; charset=utf-8", Data(str.utf8))
        }
        func boolResp(_ ok: Bool) -> (Int, String, Data) {
            return jsonResp(ok ? "{\"ok\":true}" : "{\"ok\":false}")
        }

        switch endpoint {
        case "export-begin":
            let obj = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            let name = obj["name"] as? String ?? "PicShelf-backup.picshelf"
            let copy = obj["copy"] as? String ?? "{}"
            let res = beginExport(name: name, copy: copy)
            pushStatusToWebView()
            return jsonResp(res)

        case "export-index":
            let jobId = query["id"] ?? ""
            let ok = appendIndex(id: jobId, data: body)
            return boolResp(ok)

        case "export-plan":
            let jobId = query["id"] ?? ""
            let ok = appendPlan(id: jobId, data: body)
            return boolResp(ok)

        case "export-stage-begin":
            let jobId = query["id"] ?? ""
            let stage = Int(query["stage"] ?? "-1") ?? -1
            let length = UInt64(query["length"] ?? "0") ?? 0
            return boolResp(stageBegin(id: jobId, stage: stage, length: length))

        case "export-stage-append":
            let jobId = query["id"] ?? ""
            let base64 = String(data: body, encoding: .utf8) ?? ""
            return boolResp(stageAppend(id: jobId, base64: base64))

        case "export-stage-end":
            let jobId = query["id"] ?? ""
            let complete = (query["complete"] ?? "1") != "0"
            return boolResp(stageEnd(id: jobId, complete: complete))

        case "export-start":
            let jobId = query["id"] ?? ""
            let res = finishPrepareAndStartExport(id: jobId)
            pushStatusToWebView()
            return jsonResp(res)

        case "status":
            // Self-repair (matching Android MainActivity): auto-resume any queued job if worker is idle
            resumeQueuedJobsIfNeeded(pushUpdate: false)
            return jsonResp(statusJson())

        case "free-bytes":
            return jsonResp(freeBytesJson())

        case "validate-sources":
            guard let arr = try? JSONSerialization.jsonObject(with: body) as? [String] else {
                return boolResp(true)
            }
            let fm = FileManager.default
            var allPresent = true
            for sid in arr {
                guard let u = PicShelfMediaStore.shared.sourceURL(for: sid),
                      fm.fileExists(atPath: u.path) else {
                    allPresent = false
                    break
                }
            }
            return boolResp(allPresent)

        case "entries":
            let token = query["token"] ?? ""
            return jsonResp(entriesJson(token: token))

        case "read":
            let token = query["token"] ?? ""
            let maxBytes = Int(query["max"] ?? "1048576") ?? 1048576
            let r = readIndexChunk(token: token, maxBytes: maxBytes)
            let resp = jsonString(["ok": r.ok, "chunk": r.chunk, "progress": r.progress])
            return jsonResp(resp)

        case "restore-start":
            let obj = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            let token = obj["token"] as? String ?? ""
            let entries = obj["entries"] as? String ?? "[]"
            let copy = obj["copy"] as? String ?? "{}"
            let res = beginAndStartRestore(token: token, entriesJson: entries, copy: copy)
            pushStatusToWebView()
            return jsonResp(res)

        case "restore-result":
            let jobId = query["id"] ?? ""
            return jsonResp(restoreResultJson(id: jobId))

        case "reopen":
            let jobId = query["id"] ?? ""
            return jsonResp(reopenRestoreIndex(id: jobId))

        case "precision-available":
            return boolResp(PicShelfBackdropPrecisionManager.shared.isAvailable())

        case "precision-status":
            return jsonResp(PicShelfBackdropPrecisionManager.shared.modelStatusJson())

        case "precision-segment":
            let obj = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            let reqId = obj["id"] as? String ?? ""
            let img = obj["image"] as? String ?? ""
            guard !reqId.isEmpty, !img.isEmpty else { return boolResp(false) }
            PicShelfBackdropPrecisionManager.shared.segment(requestId: reqId, imageBase64: img)
            return boolResp(true)

        case "object-remove-available":
            return boolResp(PicShelfObjectRemoverManager.shared.isAvailable())

        case "object-remove-status":
            return jsonResp(PicShelfObjectRemoverManager.shared.modelStatusJson())

        case "object-remove-inpaint":
            let obj = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            let reqId = obj["id"] as? String ?? ""
            let img = obj["image"] as? String ?? ""
            let mask = obj["mask"] as? String ?? ""
            guard !reqId.isEmpty, !img.isEmpty, !mask.isEmpty else { return boolResp(false) }
            PicShelfObjectRemoverManager.shared.inpaint(requestId: reqId, imageBase64: img, maskBase64: mask)
            return boolResp(true)

        default:
            return (404, "application/json", Data("{\"ok\":false,\"error\":\"unknown\"}".utf8))
        }
    }

    // MARK: - Export Phase A

    private static func safeBackupFileName(_ requested: String) -> String {
        var base = (requested as NSString).lastPathComponent
        if base.lowercased().hasSuffix(".picshelf") { base = String(base.dropLast(9)) }
        if base.lowercased().hasSuffix(".json") { base = String(base.dropLast(5)) }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        let cleaned = String(base.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
            .trimmingCharacters(in: CharacterSet(charactersIn: "._-"))
        let stem = cleaned.isEmpty ? "PicShelf-backup" : String(cleaned.prefix(100))
        return "\(stem).picshelf"
    }

    private func uniqueBackupURL(named fileName: String) -> (url: URL, name: String) {
        let dir = documentsDir()
        let fm = FileManager.default
        let base = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension
        var candidate = dir.appendingPathComponent(fileName)
        if !fm.fileExists(atPath: candidate.path) { return (candidate, fileName) }
        for i in 1..<1000 {
            let next = ext.isEmpty ? "\(base) (\(i))" : "\(base) (\(i)).\(ext)"
            candidate = dir.appendingPathComponent(next)
            if !fm.fileExists(atPath: candidate.path) { return (candidate, next) }
        }
        let fallback = "\(base)_\(Int(Date().timeIntervalSince1970)).picshelf"
        return (dir.appendingPathComponent(fallback), fallback)
    }

    private func createNewJobUnlocked(type: String, copyJson: String, extra: [String: Any]) -> (id: String, dir: URL)? {
        let jobs = allJobsUnlocked()
        if preparing != nil { return nil }
        if jobs.contains(where: { Self.activeStates.contains(($0["state"] as? String) ?? "") }) { return nil }
        if jobs.contains(where: { ($0["type"] as? String) == "restore" && ($0["state"] as? String) == "done" }) { return nil }

        // Clear previously acknowledged / old finished jobs
        if let dirs = try? FileManager.default.contentsOfDirectory(at: rootDir, includingPropertiesForKeys: nil) {
            for d in dirs where d.lastPathComponent != "_picked" {
                deleteJobDir(d, job: readJob(in: d))
            }
        }

        let id = UUID().uuidString.lowercased()
        let dir = rootDir.appendingPathComponent(id, isDirectory: true)
        guard (try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)) != nil else { return nil }

        let copyObj = (try? JSONSerialization.jsonObject(with: Data(copyJson.utf8)) as? [String: Any]) ?? [:]
        var job: [String: Any] = [
            "version": 1,
            "id": id,
            "type": type,
            "state": "preparing",
            "createdAt": Int64(Date().timeIntervalSince1970 * 1000),
            "copy": copyObj
        ]
        for (k, v) in extra { job[k] = v }
        writeJob(job, in: dir)
        return (id, dir)
    }

    private func beginExport(name: String, copy: String) -> String {
        let safe = Self.safeBackupFileName(name)
        stateLock.lock()
        guard let created = createNewJobUnlocked(type: "export", copyJson: copy, extra: ["name": safe]) else {
            stateLock.unlock()
            return jsonString(["ok": false, "error": "busy"])
        }
        let stagedDir = created.dir.appendingPathComponent("staged", isDirectory: true)
        try? FileManager.default.createDirectory(at: stagedDir, withIntermediateDirectories: true)
        let indexURL = created.dir.appendingPathComponent("index.json.gz")
        let planURL = created.dir.appendingPathComponent("plan.jsonl")
        FileManager.default.createFile(atPath: planURL.path, contents: nil)
        guard let gzWriter = GzipStreamWriter(url: indexURL),
              let planFH = try? FileHandle(forWritingTo: planURL) else {
            try? FileManager.default.removeItem(at: created.dir)
            stateLock.unlock()
            return jsonString(["ok": false, "error": "storage"])
        }
        let prep = PreparingState(id: created.id, dir: created.dir)
        prep.indexWriter = gzWriter
        prep.planHandle = planFH
        preparing = prep
        stateLock.unlock()
        return jsonString(["ok": true, "id": created.id])
    }

    private func appendIndex(id: String, data: Data) -> Bool {
        stateLock.lock()
        guard let prep = preparing, prep.id == id, let w = prep.indexWriter else {
            stateLock.unlock()
            return false
        }
        let ok = w.write(data)
        stateLock.unlock()
        if !ok { abortPrepare(id: id) }
        return ok
    }

    private func appendPlan(id: String, data: Data) -> Bool {
        stateLock.lock()
        guard let prep = preparing, prep.id == id, let planFH = prep.planHandle else {
            stateLock.unlock()
            return false
        }
        guard let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            stateLock.unlock()
            abortPrepare(id: id)
            return false
        }
        var lines = Data()
        for entry in arr {
            guard let name = entry["name"] as? String, !name.isEmpty, name.count <= 95,
                  let lenNum = entry["length"] as? NSNumber else {
                stateLock.unlock()
                abortPrepare(id: id)
                return false
            }
            let length = lenNum.uint64Value
            let t = entry["t"] as? String ?? ""
            if t == "a" {
                guard let src = entry["source"] as? String,
                      PicShelfMediaStore.shared.sourceURL(for: src) != nil else {
                    stateLock.unlock()
                    abortPrepare(id: id)
                    return false
                }
            } else if t == "f" {
                guard let stageIdx = (entry["stage"] as? NSNumber)?.intValue else {
                    stateLock.unlock()
                    abortPrepare(id: id)
                    return false
                }
                let stURL = prep.dir.appendingPathComponent("staged/\(stageIdx)")
                guard FileManager.default.fileExists(atPath: stURL.path) else {
                    stateLock.unlock()
                    abortPrepare(id: id)
                    return false
                }
            } else {
                stateLock.unlock()
                abortPrepare(id: id)
                return false
            }
            if let lineData = try? JSONSerialization.data(withJSONObject: entry, options: []) {
                lines.append(lineData)
                lines.append(0x0A)
            }
            prep.entries += 1
            prep.bytes &+= length
        }
        planFH.write(lines)
        stateLock.unlock()
        return true
    }

    private func stageBegin(id: String, stage: Int, length: UInt64) -> Bool {
        stateLock.lock()
        guard let prep = preparing, prep.id == id, prep.stageHandle == nil, stage >= 0 else {
            stateLock.unlock()
            return false
        }
        if UInt64(max(0, availableDiskBytes())) < length + Self.freeReserve {
            stateLock.unlock()
            abortPrepare(id: id)
            return false
        }
        let stURL = prep.dir.appendingPathComponent("staged/\(stage)")
        FileManager.default.createFile(atPath: stURL.path, contents: nil)
        guard let fh = try? FileHandle(forWritingTo: stURL) else {
            stateLock.unlock()
            abortPrepare(id: id)
            return false
        }
        prep.stageHandle = fh
        prep.stageExpected = length
        prep.stageWritten = 0
        stateLock.unlock()
        return true
    }

    private func stageAppend(id: String, base64: String) -> Bool {
        stateLock.lock()
        guard let prep = preparing, prep.id == id, let fh = prep.stageHandle else {
            stateLock.unlock()
            return false
        }
        guard let decoded = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            stateLock.unlock()
            abortPrepare(id: id)
            return false
        }
        if prep.stageWritten + UInt64(decoded.count) > prep.stageExpected {
            stateLock.unlock()
            abortPrepare(id: id)
            return false
        }
        fh.write(decoded)
        prep.stageWritten += UInt64(decoded.count)
        stateLock.unlock()
        return true
    }

    private func stageEnd(id: String, complete: Bool) -> Bool {
        stateLock.lock()
        guard let prep = preparing, prep.id == id, let fh = prep.stageHandle else {
            stateLock.unlock()
            return false
        }
        try? fh.close()
        prep.stageHandle = nil
        let valid = !complete || (prep.stageWritten == prep.stageExpected)
        stateLock.unlock()
        if !valid { abortPrepare(id: id) }
        return valid
    }

    func abortPrepare(id: String) {
        stateLock.lock()
        guard let prep = preparing, prep.id == id else {
            stateLock.unlock()
            return
        }
        preparing = nil
        try? prep.stageHandle?.close()
        prep.indexWriter?.close()
        try? prep.planHandle?.close()
        try? FileManager.default.removeItem(at: prep.dir)
        stateLock.unlock()
        pushStatusToWebView()
    }

    private func finishPrepareAndStartExport(id: String) -> String {
        stateLock.lock()
        guard let prep = preparing, prep.id == id, prep.stageHandle == nil else {
            stateLock.unlock()
            return jsonString(["ok": false, "error": "busy"])
        }
        prep.indexWriter?.close()
        prep.indexWriter = nil
        try? prep.planHandle?.close()
        prep.planHandle = nil
        preparing = nil

        let indexURL = prep.dir.appendingPathComponent("index.json.gz")
        let indexSize = ((try? FileManager.default.attributesOfItem(atPath: indexURL.path)[.size]) as? NSNumber)?.uint64Value ?? 0
        let totalBytes = prep.bytes + UInt64(prep.entries) * 1024 + indexSize + 65536
        let needed = prep.bytes + indexSize + Self.freeReserve

        if UInt64(max(0, availableDiskBytes())) < needed {
            try? FileManager.default.removeItem(at: prep.dir)
            stateLock.unlock()
            return jsonString(["ok": false, "error": "space", "needed": needed])
        }

        if var job = readJob(in: prep.dir) {
            job["state"] = "queued"
            job["entries"] = prep.entries
            job["mediaBytes"] = prep.bytes
            job["totalBytes"] = totalBytes
            writeJob(job, in: prep.dir)
        }
        stateLock.unlock()

        let st = statusJson()
        scheduleWorker(jobId: id)
        return jsonString(["ok": true, "id": id, "total": totalBytes, "status": st])
    }

    // MARK: - Import / Reader Phase

    func openPickedBackup(from url: URL) -> String {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }

        let token = UUID().uuidString.lowercased()
        let copyURL = pickedDir.appendingPathComponent("\(token).backup")
        do {
            if FileManager.default.fileExists(atPath: copyURL.path) {
                try FileManager.default.removeItem(at: copyURL)
            }
            try FileManager.default.copyItem(at: url, to: copyURL)
        } catch {
            return jsonString(["ok": false, "error": "read"])
        }
        return openBackupFile(at: copyURL, ownedCopy: copyURL, displayName: url.lastPathComponent, token: token)
    }

    private func openBackupFile(at fileURL: URL, ownedCopy: URL?, displayName: String, token: String) -> String {
        guard let fh = try? FileHandle(forReadingFrom: fileURL),
              let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let fileSize = (attrs[.size] as? NSNumber)?.uint64Value else {
            if let own = ownedCopy { try? FileManager.default.removeItem(at: own) }
            return jsonString(["ok": false, "error": "read"])
        }
        defer { try? fh.close() }

        let plainIndexURL = pickedDir.appendingPathComponent("\(token)_index.json")

        // Check if this is a full .picshelf backup by inspecting the final 2048-byte locator
        if let locator = readLocator(from: fh, fileSize: fileSize) {
            let maxIndex: UInt64 = 1024 * 1024 * 1024
            guard locator.indexLength <= maxIndex, locator.tableLength <= maxIndex else {
                if let own = ownedCopy { try? FileManager.default.removeItem(at: own) }
                return jsonString(["ok": false, "error": "too_large"])
            }
            // Read and decompress entries.json.gz
            guard let tableGz = readRange(from: fh, offset: locator.tableOffset, length: locator.tableLength),
                  let tableData = BackupGzipHelper.decompress(tableGz),
                  let tableStr = String(data: tableData, encoding: .utf8) else {
                if let own = ownedCopy { try? FileManager.default.removeItem(at: own) }
                return jsonString(["ok": false, "error": "read"])
            }
            // Stream-decompress index.json.gz to disk (constant 64 KB RAM)
            let tmpGz = pickedDir.appendingPathComponent("\(token)_index.gz")
            defer { try? FileManager.default.removeItem(at: tmpGz) }
            guard copyRangeToFile(from: fh, offset: locator.indexOffset, length: locator.indexLength, to: tmpGz),
                  PicShelfMediaStore.shared.decompressGzipFile(from: tmpGz, to: plainIndexURL) != nil,
                  let plainFH = try? FileHandle(forReadingFrom: plainIndexURL),
                  let pAttrs = try? FileManager.default.attributesOfItem(atPath: plainIndexURL.path),
                  let pSize = (pAttrs[.size] as? NSNumber)?.uint64Value else {
                try? FileManager.default.removeItem(at: plainIndexURL)
                if let own = ownedCopy { try? FileManager.default.removeItem(at: own) }
                return jsonString(["ok": false, "error": "read"])
            }

            let state = ReaderState(
                token: token, sourceURL: fileURL, ownedCopyURL: ownedCopy,
                name: String(displayName.prefix(200)), fileSize: fileSize,
                isFull: true, tableJson: tableStr,
                indexOffset: locator.indexOffset, indexLength: locator.indexLength,
                plainIndexURL: plainIndexURL, plainFH: plainFH, plainSize: pSize
            )
            stateLock.lock()
            readers[token] = state
            stateLock.unlock()

            return jsonString([
                "ok": true,
                "token": token,
                "name": state.name,
                "size": locator.indexLength,
                "full": true,
                "entries": locator.entries,
                "backupSize": fileSize
            ])
        } else {
            // Organization-only JSON or GZIP JSON backup
            let maxText: UInt64 = 512 * 1024 * 1024
            guard fileSize <= maxText else {
                if let own = ownedCopy { try? FileManager.default.removeItem(at: own) }
                return jsonString(["ok": false, "error": "too_large"])
            }
            try? fh.seek(toOffset: 0)
            let head = (try? fh.read(upToCount: 2)) ?? Data()
            let isGzip = (head.count == 2 && head[0] == 0x1f && head[1] == 0x8b)
            if isGzip {
                guard PicShelfMediaStore.shared.decompressGzipFile(from: fileURL, to: plainIndexURL) != nil else {
                    if let own = ownedCopy { try? FileManager.default.removeItem(at: own) }
                    return jsonString(["ok": false, "error": "read"])
                }
            } else {
                do {
                    try FileManager.default.copyItem(at: fileURL, to: plainIndexURL)
                } catch {
                    if let own = ownedCopy { try? FileManager.default.removeItem(at: own) }
                    return jsonString(["ok": false, "error": "read"])
                }
            }
            guard let plainFH = try? FileHandle(forReadingFrom: plainIndexURL),
                  let pAttrs = try? FileManager.default.attributesOfItem(atPath: plainIndexURL.path),
                  let pSize = (pAttrs[.size] as? NSNumber)?.uint64Value else {
                try? FileManager.default.removeItem(at: plainIndexURL)
                if let own = ownedCopy { try? FileManager.default.removeItem(at: own) }
                return jsonString(["ok": false, "error": "read"])
            }
            let state = ReaderState(
                token: token, sourceURL: fileURL, ownedCopyURL: ownedCopy,
                name: String(displayName.prefix(200)), fileSize: fileSize,
                isFull: false, tableJson: "", indexOffset: 0, indexLength: 0,
                plainIndexURL: plainIndexURL, plainFH: plainFH, plainSize: pSize
            )
            stateLock.lock()
            readers[token] = state
            stateLock.unlock()

            return jsonString([
                "ok": true,
                "token": token,
                "name": state.name,
                "size": fileSize,
                "full": false
            ])
        }
    }

    private struct LocatorInfo {
        let indexOffset: UInt64
        let indexLength: UInt64
        let tableOffset: UInt64
        let tableLength: UInt64
        let entries: Int
    }

    private func readLocator(from fh: FileHandle, fileSize: UInt64) -> LocatorInfo? {
        guard fileSize >= 2048 else { return nil }
        guard let tail = readRange(from: fh, offset: fileSize - 2048, length: 2048), tail.count == 2048 else { return nil }
        let hdr = tail.subdata(in: 0..<512)
        guard BackupTarHelper.isHeader(hdr), BackupTarHelper.name(hdr) == Self.locatorName else { return nil }
        let jsonSlice = tail.subdata(in: 512..<1024)
        guard let jsonStr = String(data: jsonSlice, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let jsonData = jsonStr.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
              (obj["format"] as? String) == "picshelf-backup",
              (obj["version"] as? NSNumber)?.intValue == 1,
              let idxArr = obj["index"] as? [NSNumber], idxArr.count >= 2,
              let tblArr = obj["table"] as? [NSNumber], tblArr.count >= 2 else { return nil }
        let io = idxArr[0].uint64Value, il = idxArr[1].uint64Value
        let to = tblArr[0].uint64Value, tl = tblArr[1].uint64Value
        guard io <= fileSize, il <= fileSize - io, to <= fileSize, tl <= fileSize - to else { return nil }
        let entries = (obj["entries"] as? NSNumber)?.intValue ?? 0
        return LocatorInfo(indexOffset: io, indexLength: il, tableOffset: to, tableLength: tl, entries: entries)
    }

    private func readRange(from fh: FileHandle, offset: UInt64, length: UInt64) -> Data? {
        guard length <= 64 * 1024 * 1024 else { return nil }
        do {
            try fh.seek(toOffset: offset)
            return try fh.read(upToCount: Int(length))
        } catch {
            return nil
        }
    }

    private func copyRangeToFile(from fh: FileHandle, offset: UInt64, length: UInt64, to dstURL: URL) -> Bool {
        FileManager.default.createFile(atPath: dstURL.path, contents: nil)
        guard let outFH = try? FileHandle(forWritingTo: dstURL) else { return false }
        defer { try? outFH.close() }
        let inFd = fh.fileDescriptor
        let outFd = outFH.fileDescriptor
        let bufCap = 1024 * 1024
        let rawBuf = UnsafeMutableRawPointer.allocate(byteCount: bufCap, alignment: 4096)
        defer { rawBuf.deallocate() }
        var curOff = offset
        var rem = length
        while rem > 0 {
            let toRead = Int(min(rem, UInt64(bufCap)))
            let n = Darwin.pread(inFd, rawBuf, toRead, off_t(curOff))
            if n < 0 {
                if errno == EINTR { continue }
                return false
            }
            if n == 0 { return false }
            var written = 0
            while written < n {
                let w = Darwin.write(outFd, rawBuf.advanced(by: written), n - written)
                if w < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                if w == 0 { return false }
                written += w
            }
            curOff += UInt64(n)
            rem -= UInt64(n)
        }
        return true
    }

    private func entriesJson(token: String) -> String {
        stateLock.lock()
        let tbl = readers[token]?.tableJson ?? ""
        stateLock.unlock()
        return tbl
    }

    private func readIndexChunk(token: String, maxBytes: Int) -> (ok: Bool, chunk: String, progress: Double) {
        stateLock.lock()
        guard let st = readers[token], !st.closed else {
            stateLock.unlock()
            return (false, "", -1)
        }
        let clampMax = max(65536, min(maxBytes, 2 * 1024 * 1024))
        var raw = (try? st.plainFH.read(upToCount: clampMax)) ?? Data()
        if raw.isEmpty {
            stateLock.unlock()
            return (true, "", 1.0)
        }
        // Never split a multi-byte UTF-8 sequence across chunk boundaries
        var trim = 0
        let count = raw.count
        if count > 0 && st.plainPos + UInt64(count) < st.plainSize {
            var i = count - 1
            var cont = 0
            while i >= max(0, count - 4) && (raw[i] & 0xC0) == 0x80 {
                cont += 1
                i -= 1
            }
            if i >= max(0, count - 4) {
                let lead = raw[i]
                let expected: Int
                if (lead & 0x80) == 0 { expected = 1 }
                else if (lead & 0xE0) == 0xC0 { expected = 2 }
                else if (lead & 0xF0) == 0xE0 { expected = 3 }
                else if (lead & 0xF8) == 0xF0 { expected = 4 }
                else { expected = 1 }
                let have = cont + 1
                if have < expected {
                    trim = have
                }
            }
        }
        if trim > 0 && trim < raw.count {
            raw = raw.prefix(raw.count - trim)
            try? st.plainFH.seek(toOffset: st.plainPos + UInt64(raw.count))
        }
        st.plainPos += UInt64(raw.count)
        let prog = st.plainSize > 0 ? min(1.0, Double(st.plainPos) / Double(st.plainSize)) : 1.0
        stateLock.unlock()
        let text = String(decoding: raw, as: UTF8.self)
        return (true, text, prog)
    }

    func closeRead(token: String) {
        stateLock.lock()
        let removed = readers.removeValue(forKey: token)
        stateLock.unlock()
        guard let st = removed else { return }
        st.closed = true
        try? st.plainFH.close()
        try? FileManager.default.removeItem(at: st.plainIndexURL)
        if let own = st.ownedCopyURL {
            try? FileManager.default.removeItem(at: own)
        }
    }

    // MARK: - Restore Phase A & C Helpers

    private func beginAndStartRestore(token: String, entriesJson: String, copy: String) -> String {
        stateLock.lock()
        guard let reader = readers[token], reader.isFull, reader.indexLength > 0 else {
            stateLock.unlock()
            return jsonString(["ok": false, "error": "read"])
        }
        let sourceURL = reader.sourceURL
        let name = reader.name
        let fileSize = reader.fileSize
        let indexOffset = reader.indexOffset
        let indexLength = reader.indexLength
        stateLock.unlock()

        guard let listData = entriesJson.data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: listData) as? [[Any]] else {
            return jsonString(["ok": false, "error": "invalid"])
        }
        var totalMedia: UInt64 = 0
        var seen = Set<Int64>()
        for row in list {
            guard row.count >= 3,
                  let num = (row[0] as? NSNumber)?.int64Value,
                  let off = (row[1] as? NSNumber)?.uint64Value,
                  let len = (row[2] as? NSNumber)?.uint64Value,
                  num >= 0, seen.insert(num).inserted,
                  off <= fileSize, len <= fileSize - off else {
                return jsonString(["ok": false, "error": "invalid"])
            }
            totalMedia &+= len
        }
        let needed = totalMedia + UInt64(list.count) * 1024 + indexLength + Self.freeReserve
        if UInt64(max(0, availableDiskBytes())) < needed {
            return jsonString(["ok": false, "error": "space", "needed": needed])
        }

        stateLock.lock()
        guard let created = createNewJobUnlocked(type: "restore", copyJson: copy, extra: [
            "backupName": name,
            "backupSize": fileSize,
            "indexOffset": indexOffset,
            "indexLength": indexLength,
            "entries": list.count,
            "mediaBytes": totalMedia,
            "totalBytes": totalMedia + indexLength + UInt64(list.count) * 1024
        ]) else {
            stateLock.unlock()
            return jsonString(["ok": false, "error": "busy"])
        }

        // Preserve a dedicated copy of the picked backup inside the job directory (instant APFS CoW <1ms)
        let jobBackupURL = created.dir.appendingPathComponent("source.picshelf")
        do {
            try FileManager.default.copyItem(at: sourceURL, to: jobBackupURL)
            try listData.write(to: created.dir.appendingPathComponent("restore.json"), options: .atomic)
            if var job = readJob(in: created.dir) {
                job["backupPath"] = jobBackupURL.path
                job["state"] = "queued"
                writeJob(job, in: created.dir)
            }
        } catch {
            try? FileManager.default.removeItem(at: created.dir)
            stateLock.unlock()
            return jsonString(["ok": false, "error": "storage"])
        }
        stateLock.unlock()

        let st = statusJson()
        scheduleWorker(jobId: created.id)
        return jsonString(["ok": true, "id": created.id, "status": st])
    }

    private func restoreResultJson(id: String) -> String {
        guard let d = jobDir(for: id),
              let data = try? Data(contentsOf: d.appendingPathComponent("result.json")),
              let str = String(data: data, encoding: .utf8) else { return "{}" }
        return str
    }

    private func reopenRestoreIndex(id: String) -> String {
        guard let d = jobDir(for: id), let job = readJob(in: d),
              (job["state"] as? String) == "done" else {
            return jsonString(["ok": false, "error": "read"])
        }
        let idxGz = d.appendingPathComponent("index.json.gz")
        guard FileManager.default.fileExists(atPath: idxGz.path) else {
            return jsonString(["ok": false, "error": "read"])
        }
        let token = UUID().uuidString.lowercased()
        let plainIndexURL = pickedDir.appendingPathComponent("\(token)_reopen.json")
        guard PicShelfMediaStore.shared.decompressGzipFile(from: idxGz, to: plainIndexURL) != nil,
              let plainFH = try? FileHandle(forReadingFrom: plainIndexURL),
              let pAttrs = try? FileManager.default.attributesOfItem(atPath: plainIndexURL.path),
              let pSize = (pAttrs[.size] as? NSNumber)?.uint64Value else {
            try? FileManager.default.removeItem(at: plainIndexURL)
            return jsonString(["ok": false, "error": "read"])
        }
        let name = job["backupName"] as? String ?? "PicShelf backup"
        let st = ReaderState(
            token: token, sourceURL: idxGz, ownedCopyURL: nil,
            name: name, fileSize: pSize, isFull: true, tableJson: "",
            indexOffset: 0, indexLength: pSize,
            plainIndexURL: plainIndexURL, plainFH: plainFH, plainSize: pSize
        )
        stateLock.lock()
        readers[token] = st
        stateLock.unlock()
        return jsonString(["ok": true, "token": token, "name": name, "size": pSize, "full": true, "local": true])
    }

    // MARK: - Background Worker (Phase B: Export & Restore with Checkpoints & iOS Background Task)

    private func scheduleWorker(jobId: String) {
        stateLock.lock()
        guard activeWorkerJobId == nil else {
            stateLock.unlock()
            return
        }
        activeWorkerJobId = jobId
        pausedByOS = false
        stateLock.unlock()

        workerQueue.async { [weak self] in
            self?.runWorker(jobId: jobId)
        }
    }

    private func isStopped(jobId: String) -> Bool {
        stateLock.lock()
        let stopped = pausedByOS || cancelRequestedJobIds.contains(jobId)
        stateLock.unlock()
        return stopped
    }

    private func isCancelled(jobId: String) -> Bool {
        stateLock.lock()
        let cancelled = cancelRequestedJobIds.contains(jobId)
        stateLock.unlock()
        return cancelled
    }

    private func cleanupCancelled(id: String) {
        stateLock.lock()
        cancelRequestedJobIds.remove(id)
        if let d = jobDir(for: id), var job = readJob(in: d) {
            if let partial = job["partial"] as? String, !partial.isEmpty {
                try? FileManager.default.removeItem(atPath: partial)
            }
            try? FileManager.default.removeItem(at: d.appendingPathComponent("export.part"))
            try? FileManager.default.removeItem(at: d.appendingPathComponent("staged"))
            try? FileManager.default.removeItem(at: d.appendingPathComponent("plan.jsonl"))
            try? FileManager.default.removeItem(at: d.appendingPathComponent("index.json.gz"))
            try? FileManager.default.removeItem(at: d.appendingPathComponent("checkpoint.json"))
            try? FileManager.default.removeItem(at: d.appendingPathComponent("held.tar"))
            try? FileManager.default.removeItem(at: d.appendingPathComponent("restore.json"))
            try? FileManager.default.removeItem(at: d.appendingPathComponent("source.picshelf"))
            job["state"] = "cancelled"
            writeJob(job, in: d)
        }
        stateLock.unlock()
        pushStatusToWebView()
    }

    private func runWorker(jobId: String) {
        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "PicShelfBackup") { [weak self] in
                guard let self = self else { return }
                self.stateLock.lock()
                self.pausedByOS = true
                self.stateLock.unlock()
                if bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTaskId)
                    bgTaskId = .invalid
                }
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 2)

        defer {
            stateLock.lock()
            if activeWorkerJobId == jobId { activeWorkerJobId = nil }
            if liveJobId == jobId { liveJobId = nil }
            stateLock.unlock()
            DispatchQueue.main.async {
                if bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTaskId)
                    bgTaskId = .invalid
                }
            }
            pushStatusToWebView()
        }

        guard let dir = jobDir(for: jobId), let job = readJob(in: dir) else { return }
        let st = job["state"] as? String ?? ""
        if st == "done" { return }
        if st == "cancelling" || isCancelled(jobId: jobId) {
            cleanupCancelled(id: jobId)
            return
        }
        guard Self.activeStates.contains(st) else { return }

        let type = job["type"] as? String ?? ""
        let totalBytes = (job["totalBytes"] as? NSNumber)?.uint64Value ?? 0
        let initialDone = (job["doneBytes"] as? NSNumber)?.uint64Value ?? 0

        updateJob(id: jobId) { j in j["state"] = "running" }
        stateLock.lock()
        liveJobId = jobId
        liveDone = initialDone
        liveTotal = totalBytes
        stateLock.unlock()
        pushStatusToWebView()

        let outcome: String
        if type == "export" {
            outcome = executeExport(dir: dir, jobId: jobId, job: job)
        } else if type == "restore" {
            outcome = executeRestore(dir: dir, jobId: jobId, job: job)
        } else {
            outcome = "failed:invalid"
        }

        if outcome == "done" {
            if let finalJob = readJob(in: dir) {
                postLocalNotification(job: finalJob, failedReason: nil)
            }
        } else if outcome == "paused" {
            updateJob(id: jobId) { j in
                j["state"] = "queued"
                j["doneBytes"] = self.liveDone
            }
        } else if outcome == "cancelled" {
            cleanupCancelled(id: jobId)
        } else {
            let reason = outcome.hasPrefix("failed:") ? String(outcome.dropFirst(7)) : "storage"
            updateJob(id: jobId) { j in
                j["state"] = "failed"
                j["error"] = reason
            }
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("export.part"))
            if let finalJob = readJob(in: dir) {
                postLocalNotification(job: finalJob, failedReason: reason)
            }
        }
    }

    private func posixWriteAll(fd: Int32, ptr: UnsafeRawPointer, count: Int) -> Bool {
        var sent = 0
        while sent < count {
            let w = Darwin.write(fd, ptr.advanced(by: sent), count - sent)
            if w > 0 {
                sent += w
            } else if w < 0 && errno == EINTR {
                continue
            } else {
                return false
            }
        }
        return true
    }

    private func posixWriteData(fd: Int32, _ data: Data) -> Bool {
        if data.isEmpty { return true }
        return data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return true }
            return posixWriteAll(fd: fd, ptr: base, count: data.count)
        }
    }

    private func posixOffset(fd: Int32) -> UInt64 {
        let pos = Darwin.lseek(fd, 0, SEEK_CUR)
        return pos >= 0 ? UInt64(pos) : 0
    }

    private func writeZeros(to fh: FileHandle, count: UInt64) -> Bool {
        if count == 0 { return true }
        let outFd = fh.fileDescriptor
        let blockSize = Int(min(count, 262144))
        guard let zBuf = Darwin.calloc(1, blockSize) else { return false }
        defer { Darwin.free(zBuf) }
        var rem = count
        while rem > 0 {
            let n = Int(min(rem, UInt64(blockSize)))
            if !posixWriteAll(fd: outFd, ptr: zBuf, count: n) { return false }
            rem -= UInt64(n)
        }
        return true
    }

    private func copyRange(from inFH: FileHandle, start: UInt64, length: UInt64, to outFH: FileHandle,
                           buf: UnsafeMutableRawPointer, bufCap: Int, jobId: String,
                           onBytes: (UInt64) -> Void, onCheckpoint: ((UInt64) -> Void)? = nil) -> UInt64 {
        guard length > 0 else { return 0 }
        let inFd = inFH.fileDescriptor
        let outFd = outFH.fileDescriptor
        var copied: UInt64 = 0
        var lastCp = CACurrentMediaTime()
        while copied < length {
            if isStopped(jobId: jobId) { return copied }
            let toRead = Int(min(length - copied, UInt64(bufCap)))
            let n = Darwin.pread(inFd, buf, toRead, off_t(start + copied))
            if n < 0 {
                if errno == EINTR { continue }
                break
            }
            if n == 0 { break }
            if !posixWriteAll(fd: outFd, ptr: buf, count: n) { break }
            let c = UInt64(n)
            copied += c
            onBytes(c)
            if let cpCb = onCheckpoint {
                let now = CACurrentMediaTime()
                if now - lastCp >= 2.0 {
                    lastCp = now
                    cpCb(copied)
                }
            }
        }
        return copied
    }

    private func executeExport(dir jobDirURL: URL, jobId: String, job: [String: Any]) -> String {
        let planURL = jobDirURL.appendingPathComponent("plan.jsonl")
        guard let planText = try? String(contentsOf: planURL, encoding: .utf8) else { return "failed:storage" }
        var entries: [[String: Any]] = []
        for line in planText.split(separator: "\n") {
            let s = String(line).trimmingCharacters(in: .whitespacesAndNewlines)
            if s.isEmpty { continue }
            if let d = s.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                entries.append(obj)
            }
        }

        let readmeData = Data(Self.readmeText.utf8)
        let startOffset = BackupTarHelper.span(for: UInt64(readmeData.count))
        var offsets: [UInt64] = []
        offsets.reserveCapacity(entries.count)
        var cursor = startOffset
        for e in entries {
            let len = (e["length"] as? NSNumber)?.uint64Value ?? 0
            offsets.append(cursor + BackupTarHelper.blockSize)
            cursor += BackupTarHelper.span(for: len)
        }
        let mediaEnd = cursor

        let exportPartURL = jobDirURL.appendingPathComponent("export.part")
        if !FileManager.default.fileExists(atPath: exportPartURL.path) {
            FileManager.default.createFile(atPath: exportPartURL.path, contents: nil)
        }
        guard let outFH = try? FileHandle(forUpdating: exportPartURL) else { return "failed:storage" }
        defer { try? outFH.close() }
        let outFd = outFH.fileDescriptor
        let existingPartSize = ((try? FileManager.default.attributesOfItem(atPath: exportPartURL.path)[.size]) as? NSNumber)?.uint64Value ?? 0

        // Restore exact byte-level checkpoint if resuming (supports mid-video resume with zero backwards progress)
        var nextIdx = 0
        var resumeOffset: UInt64 = 0
        var resumeEntryCopied: UInt64 = 0
        var failedSet = Set<Int>()
        let cpURL = jobDirURL.appendingPathComponent("checkpoint.json")
        if let cpData = try? Data(contentsOf: cpURL),
           let cp = try? JSONSerialization.jsonObject(with: cpData) as? [String: Any],
           let cpNext = (cp["next"] as? NSNumber)?.intValue,
           let cpOff = (cp["offset"] as? NSNumber)?.uint64Value,
           cpNext >= 0, cpNext <= entries.count, cpOff >= startOffset, cpOff <= mediaEnd, cpOff <= existingPartSize {
            let cpEntryCopied = (cp["entryCopied"] as? NSNumber)?.uint64Value ?? 0
            if cpEntryCopied > 0 && cpNext < entries.count {
                let expectedLen = (entries[cpNext]["length"] as? NSNumber)?.uint64Value ?? 0
                if cpEntryCopied <= expectedLen && cpOff == offsets[cpNext] + cpEntryCopied {
                    nextIdx = cpNext
                    resumeOffset = cpOff
                    resumeEntryCopied = cpEntryCopied
                }
            } else if cpEntryCopied == 0 {
                nextIdx = cpNext
                resumeOffset = cpOff
            }
            if let fArr = cp["failed"] as? [NSNumber] {
                failedSet = Set(fArr.map { $0.intValue })
            }
        }

        let startPos: UInt64 = (nextIdx == 0 && resumeEntryCopied == 0) ? 0 : resumeOffset
        guard Darwin.ftruncate(outFd, off_t(startPos)) == 0,
              Darwin.lseek(outFd, off_t(startPos), SEEK_SET) == off_t(startPos) else {
            return "failed:storage"
        }

        let nowSec = UInt64(Date().timeIntervalSince1970)
        if startPos == 0 {
            guard posixWriteData(fd: outFd, BackupTarHelper.header(name: "PicShelf backup - read me.txt", size: UInt64(readmeData.count), mtimeSeconds: nowSec)),
                  posixWriteData(fd: outFd, readmeData),
                  writeZeros(to: outFH, count: UInt64(BackupTarHelper.padding(for: UInt64(readmeData.count)))) else {
                return "failed:storage"
            }
        }

        var lastProgressPush = CACurrentMediaTime()
        var lastCheckpoint = CACurrentMediaTime()
        stateLock.lock()
        liveDone = min(liveTotal, startPos)
        stateLock.unlock()
        pushStatusToWebView()

        let onBytes: (UInt64) -> Void = { [weak self] added in
            guard let self = self else { return }
            self.stateLock.lock()
            self.liveDone += added
            self.stateLock.unlock()
            let now = CACurrentMediaTime()
            if now - lastProgressPush >= 0.35 {
                lastProgressPush = now
                self.pushStatusToWebView()
            }
        }

        // Single reusable 4 MB copy buffer -> constant ~4 MB RAM even on 100 GB backups (zero Jetsam kills!)
        let copyBufCap = 4 * 1024 * 1024
        let copyBuf = UnsafeMutableRawPointer.allocate(byteCount: copyBufCap, alignment: 4096)
        defer { copyBuf.deallocate() }

        // Keep up to 6 open source FileHandles to avoid reopening the same archive repeatedly
        var openHandles: [String: FileHandle] = [:]
        defer { for (_, fh) in openHandles { try? fh.close() } }
        func sourceHandle(for sourceId: String) -> FileHandle? {
            if let existing = openHandles[sourceId] { return existing }
            if openHandles.count >= 6, let firstKey = openHandles.keys.first {
                try? openHandles.removeValue(forKey: firstKey)?.close()
            }
            guard let u = PicShelfMediaStore.shared.sourceURL(for: sourceId),
                  let fh = try? FileHandle(forReadingFrom: u) else { return nil }
            openHandles[sourceId] = fh
            return fh
        }

        func saveExportCheckpoint(next: Int, pos: UInt64, entryCopied: UInt64) {
            let cpObj: [String: Any] = [
                "next": next,
                "offset": pos,
                "entryCopied": entryCopied,
                "failed": Array(failedSet).sorted()
            ]
            if let cpD = try? JSONSerialization.data(withJSONObject: cpObj, options: []) {
                try? cpD.write(to: cpURL, options: .atomic)
            }
            updateJob(id: jobId) { j in j["doneBytes"] = self.liveDone }
        }

        while nextIdx < entries.count {
            if isStopped(jobId: jobId) {
                return isCancelled(jobId: jobId) ? "cancelled" : "paused"
            }
            let e = entries[nextIdx]
            let entryName = e["name"] as? String ?? "media/entry.bin"
            let length = (e["length"] as? NSNumber)?.uint64Value ?? 0
            let t = e["t"] as? String ?? "a"

            let continuingMidEntry = (resumeEntryCopied > 0)
            let alreadyCopied = resumeEntryCopied
            resumeEntryCopied = 0

            let dataStartPos: UInt64
            if continuingMidEntry {
                dataStartPos = offsets[nextIdx]
            } else {
                guard posixWriteData(fd: outFd, BackupTarHelper.header(name: entryName, size: length, mtimeSeconds: UInt64(Date().timeIntervalSince1970))) else {
                    return "failed:storage"
                }
                dataStartPos = posixOffset(fd: outFd)
            }

            var copied: UInt64 = alreadyCopied

            autoreleasepool {
                if t == "a" {
                    let srcId = e["source"] as? String ?? ""
                    let kind = e["kind"] as? String ?? "tar"
                    let offset = (e["offset"] as? NSNumber)?.uint64Value ?? 0
                    let size = (e["size"] as? NSNumber)?.uint64Value ?? length
                    let method = (e["method"] as? NSNumber)?.intValue ?? 0
                    if let inFH = sourceHandle(for: srcId) {
                        if kind == "zip" && method == 8 {
                            if let inflated = PicShelfMediaStore.shared.extractEntryToData(sourceId: srcId, kind: "zip", offset: offset, size: size, method: 8, maxBytes: 512 * 1024 * 1024) {
                                let slice = inflated.prefix(Int(length))
                                if posixWriteData(fd: outFd, slice) {
                                    copied = UInt64(slice.count)
                                    onBytes(copied)
                                }
                            }
                        } else {
                            var realStart = offset
                            var validStart = true
                            if kind == "zip" {
                                if let resolved = PicShelfMediaStore.shared.resolveZipDataOffset(fileHandle: inFH, localOffset: offset) {
                                    realStart = resolved
                                } else {
                                    validStart = false
                                }
                            }
                            if validStart {
                                let targetLen = min(size, length)
                                if targetLen > alreadyCopied {
                                    let newlyCopied = copyRange(
                                        from: inFH, start: realStart + alreadyCopied, length: targetLen - alreadyCopied,
                                        to: outFH, buf: copyBuf, bufCap: copyBufCap, jobId: jobId, onBytes: onBytes
                                    ) { chunkCopied in
                                        let totalInEntry = alreadyCopied + chunkCopied
                                        saveExportCheckpoint(next: nextIdx, pos: dataStartPos + totalInEntry, entryCopied: totalInEntry)
                                    }
                                    copied = alreadyCopied + newlyCopied
                                }
                            }
                        }
                    }
                } else if t == "f", let stageIdx = (e["stage"] as? NSNumber)?.intValue {
                    let stURL = jobDirURL.appendingPathComponent("staged/\(stageIdx)")
                    let method = (e["method"] as? NSNumber)?.intValue ?? 0
                    if method == 8 {
                        if let compressed = try? Data(contentsOf: stURL),
                           let inflated = PicShelfMediaStore.shared.inflateRawDeflate(compressed, expectedSize: Int(min(length, 256 * 1024 * 1024))) {
                            let slice = inflated.prefix(Int(length))
                            if posixWriteData(fd: outFd, slice) {
                                copied = UInt64(slice.count)
                                onBytes(copied)
                            }
                        }
                    } else if let stFH = try? FileHandle(forReadingFrom: stURL) {
                        defer { try? stFH.close() }
                        if length > alreadyCopied {
                            let newlyCopied = copyRange(
                                from: stFH, start: alreadyCopied, length: length - alreadyCopied,
                                to: outFH, buf: copyBuf, bufCap: copyBufCap, jobId: jobId, onBytes: onBytes
                            ) { chunkCopied in
                                let totalInEntry = alreadyCopied + chunkCopied
                                saveExportCheckpoint(next: nextIdx, pos: dataStartPos + totalInEntry, entryCopied: totalInEntry)
                            }
                            copied = alreadyCopied + newlyCopied
                        }
                    }
                }
            }

            if isStopped(jobId: jobId) {
                // Persist exact byte offset mid-entry so resuming continues seamlessly with zero progress drop
                if copied > 0 && copied < length && ((e["method"] as? NSNumber)?.intValue ?? 0) == 0 {
                    let curPos = posixOffset(fd: outFd)
                    if curPos == dataStartPos + copied {
                        saveExportCheckpoint(next: nextIdx, pos: curPos, entryCopied: copied)
                    }
                }
                return isCancelled(jobId: jobId) ? "cancelled" : "paused"
            }

            let curPos = posixOffset(fd: outFd)
            let writtenSoFar = curPos >= dataStartPos ? (curPos - dataStartPos) : 0
            if writtenSoFar < length {
                failedSet.insert(nextIdx)
                guard writeZeros(to: outFH, count: length - writtenSoFar) else { return "failed:storage" }
            } else if copied < length {
                failedSet.insert(nextIdx)
            }
            guard writeZeros(to: outFH, count: UInt64(BackupTarHelper.padding(for: length))) else { return "failed:storage" }
            nextIdx += 1

            let now = CACurrentMediaTime()
            if now - lastCheckpoint >= 2.0 || nextIdx == entries.count {
                saveExportCheckpoint(next: nextIdx, pos: posixOffset(fd: outFd), entryCopied: 0)
                lastCheckpoint = now
            }
        }

        if isStopped(jobId: jobId) {
            return isCancelled(jobId: jobId) ? "cancelled" : "paused"
        }

        // Write picshelf/index.json.gz
        let indexURL = jobDirURL.appendingPathComponent("index.json.gz")
        guard let indexAttrs = try? FileManager.default.attributesOfItem(atPath: indexURL.path),
              let indexLen = (indexAttrs[.size] as? NSNumber)?.uint64Value,
              let idxFH = try? FileHandle(forReadingFrom: indexURL) else { return "failed:storage" }
        let indexOffset = posixOffset(fd: outFd) + BackupTarHelper.blockSize
        guard posixWriteData(fd: outFd, BackupTarHelper.header(name: "picshelf/index.json.gz", size: indexLen, mtimeSeconds: UInt64(Date().timeIntervalSince1970))) else {
            try? idxFH.close()
            return "failed:storage"
        }
        _ = copyRange(from: idxFH, start: 0, length: indexLen, to: outFH, buf: copyBuf, bufCap: copyBufCap, jobId: jobId, onBytes: { _ in })
        try? idxFH.close()
        guard writeZeros(to: outFH, count: UInt64(BackupTarHelper.padding(for: indexLen))) else { return "failed:storage" }

        // Write picshelf/entries.json.gz
        var tableEntries: [[UInt64]] = []
        tableEntries.reserveCapacity(entries.count)
        for i in 0..<entries.count {
            let len = (entries[i]["length"] as? NSNumber)?.uint64Value ?? 0
            tableEntries.append([offsets[i], len, failedSet.contains(i) ? 0 : 1])
        }
        let tableObj: [String: Any] = ["version": 1, "entries": tableEntries]
        guard let tableRaw = try? JSONSerialization.data(withJSONObject: tableObj, options: []),
              let tableGz = BackupGzipHelper.compress(tableRaw) else { return "failed:storage" }
        let tableOffset = posixOffset(fd: outFd) + BackupTarHelper.blockSize
        guard posixWriteData(fd: outFd, BackupTarHelper.header(name: "picshelf/entries.json.gz", size: UInt64(tableGz.count), mtimeSeconds: UInt64(Date().timeIntervalSince1970))),
              posixWriteData(fd: outFd, tableGz),
              writeZeros(to: outFH, count: UInt64(BackupTarHelper.padding(for: UInt64(tableGz.count)))) else {
            return "failed:storage"
        }

        // Write fixed 512-byte picshelf/locator.json + 1024-byte TAR EOF trailer
        let locatorObj: [String: Any] = [
            "format": "picshelf-backup",
            "version": 1,
            "index": [indexOffset, indexLen],
            "table": [tableOffset, UInt64(tableGz.count)],
            "entries": entries.count
        ]
        guard let locRaw = try? JSONSerialization.data(withJSONObject: locatorObj, options: []), locRaw.count <= 512 else { return "failed:storage" }
        var locBlock = Data(repeating: 0x20, count: 512)
        locBlock.replaceSubrange(0..<locRaw.count, with: locRaw)
        guard posixWriteData(fd: outFd, BackupTarHelper.header(name: Self.locatorName, size: 512, mtimeSeconds: UInt64(Date().timeIntervalSince1970))),
              posixWriteData(fd: outFd, locBlock),
              writeZeros(to: outFH, count: 1024) else {
            return "failed:storage"
        }

        let totalWritten = posixOffset(fd: outFd)
        Darwin.fsync(outFd)
        try? outFH.close()

        // Atomically publish to Files › On My iPhone › PicShelf/
        let requestedName = job["name"] as? String ?? "PicShelf-backup.picshelf"
        let dest = uniqueBackupURL(named: requestedName)
        do {
            if FileManager.default.fileExists(atPath: dest.url.path) {
                try FileManager.default.removeItem(at: dest.url)
            }
            try FileManager.default.moveItem(at: exportPartURL, to: dest.url)
        } catch {
            return "failed:storage"
        }

        // Cleanup staging artifacts
        try? FileManager.default.removeItem(at: jobDirURL.appendingPathComponent("staged"))
        try? FileManager.default.removeItem(at: planURL)
        try? FileManager.default.removeItem(at: indexURL)
        try? FileManager.default.removeItem(at: cpURL)

        stateLock.lock()
        liveDone = totalWritten
        liveTotal = totalWritten
        stateLock.unlock()

        updateJob(id: jobId) { j in
            j["state"] = "done"
            j["doneBytes"] = totalWritten
            j["totalBytes"] = totalWritten
            j["finishedAt"] = Int64(Date().timeIntervalSince1970 * 1000)
            j["result"] = [
                "name": dest.name,
                "folder": "Files › On My iPhone › PicShelf",
                "bytes": totalWritten,
                "skipped": failedSet.count,
                "uri": dest.url.absoluteString
            ]
        }
        return "done"
    }

    private func executeRestore(dir jobDirURL: URL, jobId: String, job: [String: Any]) -> String {
        guard let backupPath = job["backupPath"] as? String,
              let srcFH = try? FileHandle(forReadingFrom: URL(fileURLWithPath: backupPath)),
              let restoreData = try? Data(contentsOf: jobDirURL.appendingPathComponent("restore.json")),
              let list = try? JSONSerialization.jsonObject(with: restoreData) as? [[Any]] else {
            return "failed:source"
        }
        defer { try? srcFH.close() }

        let indexOffset = (job["indexOffset"] as? NSNumber)?.uint64Value ?? 0
        let indexLength = (job["indexLength"] as? NSNumber)?.uint64Value ?? 0
        let indexDst = jobDirURL.appendingPathComponent("index.json.gz")
        if !FileManager.default.fileExists(atPath: indexDst.path) {
            guard copyRangeToFile(from: srcFH, offset: indexOffset, length: indexLength, to: indexDst) else {
                return "failed:source"
            }
        }

        let partialArchiveURL = jobDirURL.appendingPathComponent("restore.tar.part")
        let heldURL = jobDirURL.appendingPathComponent("held.tar")
        if !FileManager.default.fileExists(atPath: partialArchiveURL.path) {
            FileManager.default.createFile(atPath: partialArchiveURL.path, contents: nil)
        }
        if !FileManager.default.fileExists(atPath: heldURL.path) {
            FileManager.default.createFile(atPath: heldURL.path, contents: nil)
        }
        guard let archFH = try? FileHandle(forUpdating: partialArchiveURL),
              let heldFH = try? FileHandle(forUpdating: heldURL) else { return "failed:storage" }
        defer {
            try? archFH.close()
            try? heldFH.close()
        }
        let archFd = archFH.fileDescriptor
        let heldFd = heldFH.fileDescriptor
        let existingArchSize = ((try? FileManager.default.attributesOfItem(atPath: partialArchiveURL.path)[.size]) as? NSNumber)?.uint64Value ?? 0
        let existingHeldSize = ((try? FileManager.default.attributesOfItem(atPath: heldURL.path)[.size]) as? NSNumber)?.uint64Value ?? 0

        var nextIdx = 0
        var archPos: UInt64 = 0
        var heldPos: UInt64 = 0
        var resumeEntryCopied: UInt64 = 0
        var resumeEntryDataOff: UInt64 = 0
        var outOffsets: [UInt64] = []
        var failedSet = Set<Int>()
        let cpURL = jobDirURL.appendingPathComponent("checkpoint.json")
        if let cpData = try? Data(contentsOf: cpURL),
           let cp = try? JSONSerialization.jsonObject(with: cpData) as? [String: Any],
           let cpNext = (cp["next"] as? NSNumber)?.intValue,
           let cpArch = (cp["offset"] as? NSNumber)?.uint64Value,
           let cpHeld = (cp["held"] as? NSNumber)?.uint64Value,
           let cpOffs = cp["offsets"] as? [NSNumber],
           cpNext >= 0, cpNext <= list.count, cpOffs.count == cpNext,
           cpArch <= existingArchSize, cpHeld <= existingHeldSize {
            let cpEntryCopied = (cp["entryCopied"] as? NSNumber)?.uint64Value ?? 0
            let cpEntryDataOff = (cp["entryDataOff"] as? NSNumber)?.uint64Value ?? 0
            nextIdx = cpNext
            archPos = cpArch
            heldPos = cpHeld
            outOffsets = cpOffs.map { $0.uint64Value }
            if cpEntryCopied > 0 && cpNext < list.count {
                let rowLen = (list[cpNext][2] as? NSNumber)?.uint64Value ?? 0
                if cpEntryCopied <= rowLen && cpEntryDataOff >= BackupTarHelper.blockSize {
                    resumeEntryCopied = cpEntryCopied
                    resumeEntryDataOff = cpEntryDataOff
                }
            }
            if let fArr = cp["failed"] as? [NSNumber] {
                failedSet = Set(fArr.map { $0.intValue })
            }
        }

        let initArchPos = (nextIdx == 0 && resumeEntryCopied == 0) ? 0 : archPos
        let initHeldPos = (nextIdx == 0 && resumeEntryCopied == 0) ? 0 : heldPos
        guard Darwin.ftruncate(archFd, off_t(initArchPos)) == 0,
              Darwin.lseek(archFd, off_t(initArchPos), SEEK_SET) == off_t(initArchPos),
              Darwin.ftruncate(heldFd, off_t(initHeldPos)) == 0,
              Darwin.lseek(heldFd, off_t(initHeldPos), SEEK_SET) == off_t(initHeldPos) else {
            return "failed:storage"
        }

        var doneAcc: UInt64 = indexLength + resumeEntryCopied
        for i in 0..<nextIdx {
            doneAcc += (list[i][2] as? NSNumber)?.uint64Value ?? 0
        }
        stateLock.lock()
        liveDone = min(liveTotal, doneAcc)
        stateLock.unlock()
        pushStatusToWebView()

        var hasArchive = false
        var hasHeld = false
        for row in list {
            let isHeld = ((row.count >= 5 ? (row[4] as? NSNumber)?.intValue : 0) ?? 0) == 1
            if isHeld { hasHeld = true } else { hasArchive = true }
        }

        var lastProgressPush = CACurrentMediaTime()
        var lastCheckpoint = CACurrentMediaTime()
        let onBytes: (UInt64) -> Void = { [weak self] added in
            guard let self = self else { return }
            self.stateLock.lock()
            self.liveDone += added
            self.stateLock.unlock()
            let now = CACurrentMediaTime()
            if now - lastProgressPush >= 0.35 {
                lastProgressPush = now
                self.pushStatusToWebView()
            }
        }

        let copyBufCap = 4 * 1024 * 1024
        let copyBuf = UnsafeMutableRawPointer.allocate(byteCount: copyBufCap, alignment: 4096)
        defer { copyBuf.deallocate() }

        func saveRestoreCheckpoint(next: Int, entryCopied: UInt64, entryDataOff: UInt64) {
            let cpObj: [String: Any] = [
                "next": next,
                "offset": posixOffset(fd: archFd),
                "held": posixOffset(fd: heldFd),
                "entryCopied": entryCopied,
                "entryDataOff": entryDataOff,
                "offsets": outOffsets,
                "failed": Array(failedSet).sorted()
            ]
            if let cpD = try? JSONSerialization.data(withJSONObject: cpObj, options: []) {
                try? cpD.write(to: cpURL, options: .atomic)
            }
            updateJob(id: jobId) { j in j["doneBytes"] = self.liveDone }
        }

        while nextIdx < list.count {
            if isStopped(jobId: jobId) {
                return isCancelled(jobId: jobId) ? "cancelled" : "paused"
            }
            let row = list[nextIdx]
            let entryNum = (row[0] as? NSNumber)?.int64Value ?? Int64(nextIdx)
            let srcOff = (row[1] as? NSNumber)?.uint64Value ?? 0
            let length = (row[2] as? NSNumber)?.uint64Value ?? 0
            let isHeld = ((row.count >= 5 ? (row[4] as? NSNumber)?.intValue : 0) ?? 0) == 1

            let continuingMidEntry = (resumeEntryCopied > 0)
            let alreadyCopied = resumeEntryCopied
            let savedDataOff = resumeEntryDataOff
            resumeEntryCopied = 0
            resumeEntryDataOff = 0

            let remainingLen = length > alreadyCopied ? (length - alreadyCopied) : 0
            if UInt64(max(0, availableDiskBytes())) < remainingLen + Self.freeReserve {
                return "failed:space"
            }

            let targetFH = isHeld ? heldFH : archFH
            let targetFd = isHeld ? heldFd : archFd
            let dataOff: UInt64
            if continuingMidEntry {
                dataOff = savedDataOff
            } else {
                guard posixWriteData(fd: targetFd, BackupTarHelper.header(name: "m/\(entryNum).bin", size: length, mtimeSeconds: UInt64(Date().timeIntervalSince1970))) else {
                    return "failed:storage"
                }
                dataOff = posixOffset(fd: targetFd)
            }

            let newlyCopied = copyRange(
                from: srcFH, start: srcOff + alreadyCopied, length: remainingLen,
                to: targetFH, buf: copyBuf, bufCap: copyBufCap, jobId: jobId, onBytes: onBytes
            ) { chunkCopied in
                saveRestoreCheckpoint(next: nextIdx, entryCopied: alreadyCopied + chunkCopied, entryDataOff: dataOff)
            }
            let copied = alreadyCopied + newlyCopied

            if isStopped(jobId: jobId) {
                if copied > 0 && copied < length {
                    saveRestoreCheckpoint(next: nextIdx, entryCopied: copied, entryDataOff: dataOff)
                }
                return isCancelled(jobId: jobId) ? "cancelled" : "paused"
            }
            if copied < length {
                failedSet.insert(nextIdx)
                guard writeZeros(to: targetFH, count: length - copied) else { return "failed:storage" }
            }
            guard writeZeros(to: targetFH, count: UInt64(BackupTarHelper.padding(for: length))) else { return "failed:storage" }
            outOffsets.append(dataOff)
            nextIdx += 1

            let now = CACurrentMediaTime()
            if now - lastCheckpoint >= 2.0 || nextIdx == list.count {
                saveRestoreCheckpoint(next: nextIdx, entryCopied: 0, entryDataOff: 0)
                lastCheckpoint = now
            }
        }

        _ = writeZeros(to: archFH, count: 1024)
        _ = writeZeros(to: heldFH, count: 1024)
        Darwin.fsync(archFd)
        Darwin.fsync(heldFd)
        try? archFH.close()
        try? heldFH.close()

        var adoptedSourceId = ""
        if hasArchive {
            guard let adopted = PicShelfMediaStore.shared.adoptFile(from: partialArchiveURL, ext: "tar") else {
                return "failed:storage"
            }
            adoptedSourceId = adopted.sourceId
            // Register immediately in JS known sources set so validateArchiveSources sees it right away
            if let sidData = try? JSONSerialization.data(withJSONObject: [adoptedSourceId], options: []),
               let sidArr = String(data: sidData, encoding: .utf8) {
                DispatchQueue.main.async { [weak self] in
                    self?.webView?.evaluateJavaScript(
                        "if (window.__iosKnownSourceIds) window.__iosKnownSourceIds.add((\(sidArr))[0]);",
                        completionHandler: nil
                    )
                }
            }
        } else {
            try? FileManager.default.removeItem(at: partialArchiveURL)
        }

        let heldToken = hasHeld ? "held_\(jobId).tar" : ""
        if !hasHeld {
            try? FileManager.default.removeItem(at: heldURL)
        }

        var resultEntries: [[Any]] = []
        resultEntries.reserveCapacity(list.count)
        for i in 0..<list.count {
            let row = list[i]
            let entryNum = (row[0] as? NSNumber)?.int64Value ?? Int64(i)
            let length = (row[2] as? NSNumber)?.uint64Value ?? 0
            let isHeld = ((row.count >= 5 ? (row[4] as? NSNumber)?.intValue : 0) ?? 0) == 1
            let off: Int64 = i < outOffsets.count ? Int64(outOffsets[i]) : -1
            let okFlag = (i < outOffsets.count && !failedSet.contains(i)) ? 1 : 0
            resultEntries.append([entryNum, off, length, okFlag, isHeld ? 1 : 0])
        }

        let resObj: [String: Any] = [
            "sourceId": adoptedSourceId,
            "heldToken": heldToken,
            "entries": resultEntries
        ]
        if let rData = try? JSONSerialization.data(withJSONObject: resObj, options: []) {
            try? rData.write(to: jobDirURL.appendingPathComponent("result.json"), options: .atomic)
        }
        try? FileManager.default.removeItem(at: cpURL)
        try? FileManager.default.removeItem(at: jobDirURL.appendingPathComponent("source.picshelf"))
        try? FileManager.default.removeItem(at: jobDirURL.appendingPathComponent("restore.json"))

        stateLock.lock()
        liveDone = liveTotal
        stateLock.unlock()

        updateJob(id: jobId) { j in
            j["state"] = "done"
            j["doneBytes"] = self.liveTotal
            j["finishedAt"] = Int64(Date().timeIntervalSince1970 * 1000)
            j["result"] = ["sourceId": adoptedSourceId, "entries": list.count]
        }
        return "done"
    }

    // MARK: - Local Notifications for Background Completion

    private func postLocalNotification(job: [String: Any], failedReason: String?) {
        let copy = (job["copy"] as? [String: Any]) ?? [:]
        let isRestore = (job["type"] as? String) == "restore"
        func txt(_ key: String, _ fallback: String) -> String {
            if let v = copy[key] as? String, !v.isEmpty { return String(v.prefix(300)) }
            return fallback
        }
        let content = UNMutableNotificationContent()
        content.sound = .default
        if let reason = failedReason {
            content.title = txt("failedTitle", "Backup did not finish")
            content.body = (reason == "space")
                ? txt("spaceText", "Not enough free space. Free up some space, then try again.")
                : txt("failedText", "Open PicShelf to try again.")
        } else if isRestore {
            content.title = txt("restoreDoneTitle", "Photos and videos copied")
            content.body = txt("restoreDoneText", "Open PicShelf to finish restoring your library.")
        } else {
            let res = (job["result"] as? [String: Any]) ?? [:]
            let folder = (res["folder"] as? String) ?? "Files › On My iPhone › PicShelf"
            let name = (res["name"] as? String) ?? ""
            content.title = txt("exportDoneTitle", "Backup saved")
            content.body = txt("exportDoneText", "Saved in {folder} as {name}.")
                .replacingOccurrences(of: "{folder}", with: folder)
                .replacingOccurrences(of: "{name}", with: name)
        }
        let req = UNNotificationRequest(identifier: "picshelf_backup_\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }
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
        ctx.restoreGState()

        // 9. Handwritten "PicShelf" connected script wordmark (320ms -> 2720ms)
        let progress = wordmarkCompleted ? 1.0 : CGFloat(max(0.0, min(1.0, (elapsed - 320.0) / 2400.0)))
        drawWordmark(progress: progress, in: ctx)

        ctx.restoreGState()
    }

    private func drawImage(_ img: CGImage?, half: CGFloat, in ctx: CGContext) {
        guard let img = img else { return }
        ctx.saveGState()
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(img, in: CGRect(x: -half, y: -half, width: half * 2, height: half * 2))
        ctx.restoreGState()
    }

    private func drawRotatedImage(_ img: CGImage?, half: CGFloat, radians: CGFloat, in ctx: CGContext) {
        guard let img = img else { return }
        ctx.saveGState()
        ctx.rotate(by: radians)
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(img, in: CGRect(x: -half, y: -half, width: half * 2, height: half * 2))
        ctx.restoreGState()
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
        ctx.restoreGState()
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
        ctx.restoreGState()
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
            ctx.restoreGState()
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
            ctx.restoreGState()

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
                ctx.restoreGState()
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
            ctx.restoreGState()
            ctx.saveGState()
            ctx.setAlpha(0.85)
            ctx.addPath(oct)
            ctx.setStrokeColor(Self.argbColor(0x99ffffff).cgColor)
            ctx.setLineWidth(0.8)
            ctx.strokePath()
            ctx.restoreGState()

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
            ctx.restoreGState()
            ctx.saveGState()
            ctx.setAlpha(0.75)
            ctx.addPath(tl)
            ctx.setStrokeColor(Self.argbColor(0xb2ffffff).cgColor)
            ctx.setLineWidth(0.6)
            ctx.strokePath()
            ctx.restoreGState()

            // Other diagonal & outer facets
            drawSolidFacet([(132,68),(112,72),(128,88)], fill: 0xa6ffffff, stroke: 0xb2ffffff, alpha: 0.75, lineWidth: 0.6)
            drawSolidFacet([(68,132),(72,112),(88,128)], fill: 0x99f43f5e, stroke: 0xb2ffffff, alpha: 0.75, lineWidth: 0.6)
            drawSolidFacet([(132,132),(128,112),(112,128)], fill: 0x9938bdf8, stroke: 0xb2ffffff, alpha: 0.75, lineWidth: 0.6)

            drawSolidFacet([(100,56),(68,68),(88,72)], fill: 0x73ffffff, stroke: 0x80fbe0d4, alpha: 1.0, lineWidth: 0.5)
            drawSolidFacet([(100,56),(132,68),(112,72)], fill: 0x8cfbe0d4, stroke: 0x80fbe0d4, alpha: 1.0, lineWidth: 0.5)
            drawSolidFacet([(100,144),(68,132),(88,128)], fill: 0x80f43f5e, stroke: 0x80fbe0d4, alpha: 1.0, lineWidth: 0.5)
            drawSolidFacet([(100,144),(132,132),(112,128)], fill: 0x8cc084fc, stroke: 0x80fbe0d4, alpha: 1.0, lineWidth: 0.5)

            ctx.restoreGState()
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
        PicShelfBackupManager.shared.resumeQueuedJobsIfNeeded()
        let origLit = PicShelfLocalMediaServer.shared.originalsOrigin.map { "\"\($0)\"" } ?? "null"
        let thumbLit = PicShelfLocalMediaServer.shared.thumbnailsOrigin.map { "\"\($0)\"" } ?? "null"
        let backupLit = PicShelfLocalMediaServer.shared.backupOrigin.map { "\"\($0)\"" } ?? "null"
        webView?.evaluateJavaScript(
            "window.__PICSHELF_IOS_ORIGINALS_ORIGIN = \(origLit); window.__PICSHELF_IOS_THUMBNAILS_ORIGIN = \(thumbLit); window.__PICSHELF_IOS_BACKUP_ORIGIN = \(backupLit); if (window.MediaShare && window.MediaShare.onResume) window.MediaShare.onResume(); if (window.state && window.state.biometricLock && window.state.isAppLocked) { if (window.showAppLock) window.showAppLock(); }",
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

    private func makeBridgeUserScript() -> WKUserScript {
        // Snapshot live durable source IDs, loopback media server origins, and backup status
        PicShelfLocalMediaServer.shared.ensureRunning()
        let existingIds = PicShelfMediaStore.shared.allSourceIds()
        let idsJsonData = (try? JSONSerialization.data(withJSONObject: existingIds, options: [])) ?? Data("[]".utf8)
        let idsJsonLiteral = String(data: idsJsonData, encoding: .utf8) ?? "[]"
        let originalsOriginLiteral = PicShelfLocalMediaServer.shared.originalsOrigin.map { "\"\($0)\"" } ?? "null"
        let thumbsOriginLiteral = PicShelfLocalMediaServer.shared.thumbnailsOrigin.map { "\"\($0)\"" } ?? "null"
        let backupOriginLiteral = PicShelfLocalMediaServer.shared.backupOrigin.map { "\"\($0)\"" } ?? "null"
        let initialBackupStatusData = (try? JSONSerialization.data(withJSONObject: [PicShelfBackupManager.shared.statusJson()], options: [])) ?? Data("[\"{}\"]".utf8)
        let initialBackupStatusArr = String(data: initialBackupStatusData, encoding: .utf8) ?? "[\"{}\"]"
        let initialFreeBytesData = (try? JSONSerialization.data(withJSONObject: [PicShelfBackupManager.shared.freeBytesJson()], options: [])) ?? Data("[\"{}\"]".utf8)
        let initialFreeBytesArr = String(data: initialFreeBytesData, encoding: .utf8) ?? "[\"{}\"]"

        // Inject compatibility shim for AndroidApp & iOS native bridge
        let bridgeShimScript = """
        (function() {
            window.isNativeIOS = true;
            window.__PICSHELF_IOS_ORIGINALS_ORIGIN = \(originalsOriginLiteral);
            window.__PICSHELF_IOS_THUMBNAILS_ORIGIN = \(thumbsOriginLiteral);
            window.__PICSHELF_IOS_BACKUP_ORIGIN = \(backupOriginLiteral);
            window.__iosKnownSourceIds = new Set(\(idsJsonLiteral));
            window.__iosBackupStatusJson = (\(initialBackupStatusArr))[0];
            window.__iosBackupFreeBytesJson = (\(initialFreeBytesArr))[0];
            window.__iosBackupPendingJson = '';
            window.__iosBackupReadProgress = {};
            window.__iosBackupNotificationsAllowed = false;

            const backupBase = function() {
                return window.__PICSHELF_IOS_BACKUP_ORIGIN || '';
            };
            const backupPost = function(path, body, isJson) {
                return fetch(backupBase() + path, {
                    method: 'POST',
                    headers: { 'Content-Type': isJson ? 'application/json' : 'text/plain' },
                    body: body == null ? '' : body
                }).then(function(r) { return r.text(); });
            };
            const backupGet = function(path) {
                return fetch(backupBase() + path).then(function(r) { return r.text(); });
            };
            const backupSyncRequest = function(method, path, body) {
                var base = backupBase();
                if (!base) return null;
                try {
                    var xhr = new XMLHttpRequest();
                    xhr.open(method, base + path, false);
                    if (method === 'POST') xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.send(body == null ? null : body);
                    if (xhr.status === 200) return xhr.responseText;
                } catch (_) {}
                return null;
            };
            window.__iosSetBackupStatus = function(nextJson) {
                if (typeof nextJson !== 'string' || !nextJson) return;
                try {
                    var prev = window.__iosBackupStatusJson ? JSON.parse(window.__iosBackupStatusJson) : null;
                    var next = JSON.parse(nextJson);
                    // Never allow an out-of-order status update to move an active job's progress bar backwards
                    if (prev && next && prev.id && prev.id === next.id &&
                        (prev.state === 'queued' || prev.state === 'running') &&
                        (next.state === 'queued' || next.state === 'running') &&
                        Number(next.done) < Number(prev.done)) {
                        next.done = prev.done;
                        nextJson = JSON.stringify(next);
                    }
                } catch (_) {}
                window.__iosBackupStatusJson = nextJson;
            };

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
                        var payload = typeof idsJson === 'string' ? idsJson : JSON.stringify(idsJson || []);
                        var live = backupSyncRequest('POST', 'validate-sources', payload);
                        if (live !== null) {
                            var parsed = JSON.parse(live);
                            return !!parsed.ok;
                        }
                        var arr = JSON.parse(payload);
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
                libraryBackupExportBegin: function(name, copy) {
                    return backupPost('export-begin', JSON.stringify({ name: String(name || ''), copy: String(copy || '{}') }), true);
                },
                libraryBackupExportIndex: function(jobId, chunk) {
                    return backupPost('export-index?id=' + encodeURIComponent(String(jobId || '')), String(chunk || ''), false)
                        .then(function(t) { try { return !!JSON.parse(t).ok; } catch (_) { return false; } });
                },
                libraryBackupExportPlan: function(jobId, json) {
                    return backupPost('export-plan?id=' + encodeURIComponent(String(jobId || '')), String(json || '[]'), true)
                        .then(function(t) { try { return !!JSON.parse(t).ok; } catch (_) { return false; } });
                },
                libraryBackupExportStageBegin: function(jobId, stage, length) {
                    return backupPost('export-stage-begin?id=' + encodeURIComponent(String(jobId || '')) + '&stage=' + Number(stage || 0) + '&length=' + Number(length || 0), '', false)
                        .then(function(t) { try { return !!JSON.parse(t).ok; } catch (_) { return false; } });
                },
                libraryBackupExportStageAppend: function(jobId, base64) {
                    return backupPost('export-stage-append?id=' + encodeURIComponent(String(jobId || '')), String(base64 || ''), false)
                        .then(function(t) { try { return !!JSON.parse(t).ok; } catch (_) { return false; } });
                },
                libraryBackupExportStageEnd: function(jobId, complete) {
                    return backupPost('export-stage-end?id=' + encodeURIComponent(String(jobId || '')) + '&complete=' + (complete === false ? '0' : '1'), '', false)
                        .then(function(t) { try { return !!JSON.parse(t).ok; } catch (_) { return false; } });
                },
                libraryBackupExportStart: function(jobId) {
                    return backupPost('export-start?id=' + encodeURIComponent(String(jobId || '')), '', false)
                        .then(function(t) {
                            try {
                                var parsed = JSON.parse(t);
                                if (parsed && typeof parsed.status === 'string') window.__iosSetBackupStatus(parsed.status);
                            } catch (_) {}
                            return t;
                        });
                },
                libraryBackupExportAbort: function(jobId) {
                    send('libraryBackupExportAbort', { id: String(jobId || '') });
                },
                libraryBackupStatus: function() {
                    var live = backupSyncRequest('GET', 'status', null);
                    if (live !== null) {
                        window.__iosSetBackupStatus(live);
                    }
                    return window.__iosBackupStatusJson || '{}';
                },
                libraryBackupCancel: function(jobId) {
                    send('libraryBackupCancel', { id: String(jobId || '') });
                },
                libraryBackupAcknowledge: function(jobId) {
                    window.__iosBackupStatusJson = '{}';
                    send('libraryBackupAcknowledge', { id: String(jobId || '') });
                },
                libraryBackupClearInterrupted: function() {
                    send('libraryBackupClearInterrupted');
                },
                libraryBackupShareResult: function(jobId, title) {
                    send('libraryBackupShareResult', { id: String(jobId || ''), title: String(title || 'Share Backup') });
                },
                libraryBackupPick: function() {
                    send('libraryBackupPick');
                },
                libraryBackupTakePending: function() {
                    var v = window.__iosBackupPendingJson || '';
                    window.__iosBackupPendingJson = '';
                    return v;
                },
                libraryBackupProgress: function(token) {
                    var p = window.__iosBackupReadProgress && window.__iosBackupReadProgress[String(token || '')];
                    return typeof p === 'number' ? p : 0;
                },
                libraryBackupRead: function(token, maxChars) {
                    var key = String(token || '');
                    return backupGet('read?token=' + encodeURIComponent(key) + '&max=' + Number(maxChars || 1048576))
                        .then(function(t) {
                            var parsed = JSON.parse(t);
                            if (!parsed || !parsed.ok) throw new Error('Backup read failed');
                            if (typeof parsed.progress === 'number') window.__iosBackupReadProgress[key] = parsed.progress;
                            return parsed.chunk || '';
                        });
                },
                libraryBackupEntries: function(token) {
                    return backupGet('entries?token=' + encodeURIComponent(String(token || '')));
                },
                libraryBackupClose: function(token) {
                    var key = String(token || '');
                    if (window.__iosBackupReadProgress) delete window.__iosBackupReadProgress[key];
                    send('libraryBackupClose', { token: key });
                },
                libraryBackupFreeBytes: function() {
                    var live = backupSyncRequest('GET', 'free-bytes', null);
                    if (live !== null) window.__iosBackupFreeBytesJson = live;
                    return window.__iosBackupFreeBytesJson || '{}';
                },
                libraryBackupRestoreStart: function(token, entriesJson, copy) {
                    return backupPost('restore-start', JSON.stringify({
                        token: String(token || ''),
                        entries: String(entriesJson || '[]'),
                        copy: String(copy || '{}')
                    }), true).then(function(t) {
                        try {
                            var parsed = JSON.parse(t);
                            if (parsed && typeof parsed.status === 'string') window.__iosSetBackupStatus(parsed.status);
                        } catch (_) {}
                        return t;
                    });
                },
                libraryBackupRestoreResult: function(jobId) {
                    return backupGet('restore-result?id=' + encodeURIComponent(String(jobId || '')));
                },
                libraryBackupReopen: function(jobId) {
                    return backupGet('reopen?id=' + encodeURIComponent(String(jobId || '')));
                },
                libraryBackupReleaseSource: function(sourceId) {
                    send('libraryBackupReleaseSource', { sourceId: String(sourceId || '') });
                },
                libraryBackupNotificationsAllowed: function() {
                    return !!window.__iosBackupNotificationsAllowed;
                },
                libraryBackupRequestNotifications: function() {
                    send('libraryBackupRequestNotifications');
                },
                authenticateBiometrics: function() { send('authenticateBiometrics', { mode: 'unlock' }); },
                authenticateForPasscodeReset: function() { send('authenticateBiometrics', { mode: 'reset' }); },
                getCurrentLocation: function(callbackId) { send('getCurrentLocation', { callbackId: callbackId }); },
                sharePhoto: function(dataUrl, title) { send('sharePhoto', { dataUrl: dataUrl, title: title }); },
                shareMultiplePhotos: function(photosJson, title) { send('shareMultiplePhotos', { photos: photosJson, title: title }); },
                beginMediaShareStream: function(requestId, size) {
                    iosStreamSeq++;
                    var token = 'ios_sh_' + Date.now() + '_' + iosStreamSeq;
                    send('beginMediaShareStream', { requestId: String(requestId || ''), token: token, size: Number(size || 0) });
                    return token;
                },
                appendMediaShareStream: function(token, base64) {
                    send('appendMediaShareStream', { token: String(token || ''), base64: String(base64 || '') });
                    return true;
                },
                sealMediaShareStream: function(token) {
                    send('sealMediaShareStream', { token: String(token || '') });
                    return true;
                },
                discardMediaShareStream: function(token) {
                    send('discardMediaShareStream', { token: String(token || '') });
                },
                cancelMediaShare: function(requestId) {
                    send('cancelMediaShare', { requestId: String(requestId || '') });
                },
                shareMediaBatch: function(payloadJson) {
                    send('shareMediaBatch', { payloadJson: typeof payloadJson === 'string' ? payloadJson : JSON.stringify(payloadJson || {}) });
                },
                getMediaShareFreeBytes: function() {
                    try {
                        var live = backupSyncRequest('GET', 'free-bytes', null);
                        if (live !== null) {
                            var parsed = JSON.parse(live);
                            if (typeof parsed.app === 'number') return parsed.app;
                        }
                        var cached = window.__iosBackupFreeBytesJson ? JSON.parse(window.__iosBackupFreeBytesJson) : null;
                        if (cached && typeof cached.app === 'number') return cached.app;
                    } catch (_) {}
                    return -1;
                },
                beginMediaShareArchive: function(requestId, total) {
                    send('beginMediaShareArchive', { requestId: String(requestId || ''), total: Number(total || 0) });
                    return true;
                },
                shareMediaArchiveBatch: function(payloadJson) {
                    send('shareMediaArchiveBatch', { payloadJson: typeof payloadJson === 'string' ? payloadJson : JSON.stringify(payloadJson || {}) });
                },
                resumeMediaShare: function(requestId) {
                    send('resumeMediaShare', { requestId: String(requestId || '') });
                    return true;
                },
                reopenMediaShare: function(requestId) {
                    send('reopenMediaShare', { requestId: String(requestId || '') });
                    return true;
                },
                backdropPrecisionAvailable: function() {
                    try {
                        var live = backupSyncRequest('GET', 'precision-available', null);
                        if (live !== null) return !!JSON.parse(live).ok;
                    } catch (_) {}
                    return false;
                },
                backdropPrecisionModelStatus: function() {
                    var live = backupSyncRequest('GET', 'precision-status', null);
                    return live !== null ? live : '{"state":"missing","downloaded":0,"total":0,"metered":false,"error":null}';
                },
                backdropPrecisionDownload: function() {
                    send('backdropPrecisionDownload');
                },
                backdropPrecisionStopDownload: function() {
                    send('backdropPrecisionStopDownload');
                },
                backdropPrecisionCancel: function(requestId) {
                    send('backdropPrecisionCancel', { requestId: String(requestId || '') });
                },
                backdropPrecisionSegment: function(requestId, imageBase64) {
                    backupPost('precision-segment', JSON.stringify({
                        id: String(requestId || ''),
                        image: String(imageBase64 || '')
                    }), true).catch(function() {
                        if (window.PicShelfBackdropPrecision && window.PicShelfBackdropPrecision.onNative) {
                            window.PicShelfBackdropPrecision.onNative({ id: String(requestId || ''), error: 'Precision request failed' });
                        }
                    });
                },
                objectRemoveAvailable: function() {
                    try {
                        var live = backupSyncRequest('GET', 'object-remove-available', null);
                        if (live !== null) return !!JSON.parse(live).ok;
                    } catch (_) {}
                    return false;
                },
                objectRemoveModelStatus: function() {
                    var live = backupSyncRequest('GET', 'object-remove-status', null);
                    return live !== null ? live : '{"state":"missing","downloaded":0,"total":0,"error":null}';
                },
                objectRemoveDownload: function() {
                    send('objectRemoveDownload');
                },
                objectRemoveStopDownload: function() {
                    send('objectRemoveStopDownload');
                },
                objectRemoveCancel: function(requestId) {
                    send('objectRemoveCancel', { requestId: String(requestId || '') });
                },
                objectRemoveInpaint: function(requestId, imageBase64, maskBase64) {
                    backupPost('object-remove-inpaint', JSON.stringify({
                        id: String(requestId || ''),
                        image: String(imageBase64 || ''),
                        mask: String(maskBase64 || '')
                    }), true).catch(function() {
                        if (window.PicShelfCreativeStudio && window.PicShelfCreativeStudio.onRemoveResult) {
                            window.PicShelfCreativeStudio.onRemoveResult({ id: String(requestId || ''), error: 'AI eraser request failed' });
                        }
                    });
                },
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

        return WKUserScript(
            source: bridgeShimScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    private func setupWebView() {
        let contentController = WKUserContentController()

        // 1. Add native bridge message handler
        bridge.viewController = self
        contentController.add(bridge, name: "auraBridge")

        // 2. Inject live compatibility shim for AndroidApp & iOS native bridge
        contentController.addUserScript(makeBridgeUserScript())

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
        PicShelfBackupManager.shared.webView = webView
        PicShelfBackdropPrecisionManager.shared.webView = webView
        PicShelfObjectRemoverManager.shared.webView = webView
        PicShelfBackupManager.shared.resumeQueuedJobsIfNeeded()
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

    private func syncStatusBarSafeTopToWeb() {
        let topInset = max(view.safeAreaInsets.top, view.window?.safeAreaInsets.top ?? 0)
        let safeTop = Int(topInset > 0 ? ceil(topInset) : 59)
        let injectCss = """
        document.documentElement.classList.add('native-app-mode');
        document.body.classList.add('native-app-mode');
        document.documentElement.style.setProperty('--android-status-bar-height', '\(safeTop)px');
        """
        webView?.evaluateJavaScript(injectCss, completionHandler: nil)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        syncStatusBarSafeTopToWeb()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        syncStatusBarSafeTopToWeb()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Recover cleanly if iOS reclaims the WebContent process while backgrounded during a large backup
        PicShelfLocalMediaServer.shared.ensureRunning()
        PicShelfBackupManager.shared.resumeQueuedJobsIfNeeded()
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let controller = webView.configuration.userContentController
            controller.removeAllUserScripts()
            controller.addUserScript(self.makeBridgeUserScript())
            self.loadLocalApp()
        }
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
