import UIKit
import WebKit
import Photos
import PhotosUI
import LocalAuthentication
import CoreMotion
import CoreLocation
import AVFoundation
import ImageIO
import UniformTypeIdentifiers
import PDFKit

class AuraBridge: NSObject, WKScriptMessageHandler, UIImagePickerControllerDelegate, UINavigationControllerDelegate, PHPickerViewControllerDelegate, UIDocumentPickerDelegate, CLLocationManagerDelegate {

    weak var viewController: UIViewController?
    weak var webView: WKWebView?

    private var targetAlbumForImport: String?
    private var isGpsMetadataEnabled: Bool = true
    private let importQueue = DispatchQueue(label: "com.picshelf.ios.importQueue", qos: .userInitiated)
    private let downloadQueue = DispatchQueue(label: "com.picshelf.ios.downloadQueue", qos: .userInitiated)
    private let photosMirrorQueue = DispatchQueue(label: "com.picshelf.ios.photosMirror", qos: .utility)
    private let downloadStateLock = NSLock()
    private var stagedStreams: [String: URL] = [:]
    private var cancelledDownloadSessions: Set<String> = []
    private var cancelledDownloadItems: Set<String> = []

    // Sensors
    private let motionManager = CMMotionManager()
    private var lastNativeGyroDispatchTime: TimeInterval = 0
    private var lastNativeShakeTime: TimeInterval = 0

    // Location
    private let locationManager = CLLocationManager()
    private var pendingLocationCallbackId: String?
    private var lastKnownLocation: CLLocation?

    override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
    }

    // MARK: - Motion Physics (60fps Gyroscope Parallax & Shake Detection)

    func startSensors() {
        guard motionManager.isDeviceMotionAvailable else { return }
        motionManager.deviceMotionUpdateInterval = 1.0 / 60.0 // 60 FPS

        motionManager.startDeviceMotionUpdates(to: .main) { [weak self] (motion, error) in
            guard let self = self, let motion = motion, error == nil else { return }
            let now = CACurrentMediaTime()

            // 1. Gyroscope orientation (Pitch & Roll in degrees, throttled to 16ms)
            if now - self.lastNativeGyroDispatchTime >= 0.016 {
                self.lastNativeGyroDispatchTime = now
                let pitchDeg = motion.attitude.pitch * (180.0 / .pi)
                let rollDeg = motion.attitude.roll * (180.0 / .pi)
                let js = String(
                    format: "window.Aura3DMotionPhysics && window.Aura3DMotionPhysics.onNativeOrientation && window.Aura3DMotionPhysics.onNativeOrientation(%.2f, %.2f);",
                    pitchDeg,
                    rollDeg
                )
                self.webView?.evaluateJavaScript(js, completionHandler: nil)
            }

            // 2. Shake detection via user acceleration
            let userAccel = motion.userAcceleration
            let magnitude = sqrt(userAccel.x * userAccel.x + userAccel.y * userAccel.y + userAccel.z * userAccel.z)
            if magnitude > 1.6 && now - self.lastNativeShakeTime > 0.8 {
                self.lastNativeShakeTime = now
                let generator = UIImpactFeedbackGenerator(style: .medium)
                generator.prepare()
                generator.impactOccurred()

                let jsShake = "window.Aura3DMotionPhysics && window.Aura3DMotionPhysics.triggerShakeWave && window.Aura3DMotionPhysics.triggerShakeWave();"
                self.webView?.evaluateJavaScript(jsShake, completionHandler: nil)
            }
        }
    }

    func stopSensors() {
        motionManager.stopDeviceMotionUpdates()
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "auraBridge",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }

        switch action {
        case "openCamera":
            openCamera()

        case "openGallery":
            targetAlbumForImport = nil
            presentUploadSourceChooser()

        case "openGalleryForAlbum":
            targetAlbumForImport = body["album"] as? String
            presentUploadSourceChooser()

        case "retainArchiveSources":
            if let idsJson = body["ids"] as? String,
               let data = idsJson.data(using: .utf8),
               let arr = try? JSONSerialization.jsonObject(with: data) as? [String] {
                PicShelfMediaStore.shared.retainSources(Set(arr))
            }

        case "authenticateBiometrics":
            let mode = body["mode"] as? String ?? "unlock"
            authenticateBiometrics(mode: mode)

        case "setStartupAppearance":
            if let theme = body["theme"] as? String {
                DispatchQueue.main.async { [weak self] in
                    (self?.viewController as? ViewController)?.updateAppearance(theme: theme)
                }
            }

        case "setStartupLanguage":
            if let lang = body["language"] as? String {
                DispatchQueue.main.async { [weak self] in
                    (self?.viewController as? ViewController)?.updateStartupLanguage(lang)
                }
            }

        case "onStartupReady":
            DispatchQueue.main.async { [weak self] in
                (self?.viewController as? ViewController)?.onWebStartupReady()
            }

        case "onStartupFailed":
            DispatchQueue.main.async { [weak self] in
                (self?.viewController as? ViewController)?.onWebStartupFailed()
            }

        case "sharePhoto":
            if let dataUrl = body["dataUrl"] as? String {
                let title = body["title"] as? String ?? "Photo"
                sharePhoto(dataUrl: dataUrl, title: title)
            }

        case "shareMultiplePhotos":
            if let photos = body["photos"] as? String {
                let title = body["title"] as? String ?? "Photos"
                shareMultiplePhotos(photosJson: photos, albumTitle: title)
            }

        case "downloadPhoto":
            if let dataUrl = body["dataUrl"] as? String,
               let name = body["name"] as? String {
                downloadPhoto(dataUrl: dataUrl, fileName: name)
            }

        case "executeDownloadBatch":
            executeDownloadBatch(body: body)

        case "beginDownloadStream":
            if let token = body["token"] as? String {
                beginDownloadStream(token: token)
            }

        case "appendDownloadStream":
            if let token = body["token"] as? String,
               let base64 = body["base64"] as? String {
                appendDownloadStream(token: token, base64: base64)
            }

        case "sealDownloadStream":
            break

        case "discardDownloadStream":
            if let token = body["token"] as? String {
                discardDownloadStream(token: token)
            }

        case "executeDownloadChunk":
            if let payloadJson = body["payloadJson"] as? String {
                executeDownloadChunk(payloadJson: payloadJson)
            }

        case "verifyDownloadedFiles":
            if let requestId = body["requestId"] as? String,
               let itemsJson = body["itemsJson"] as? String {
                verifyDownloadedFiles(requestId: requestId, itemsJson: itemsJson)
            }

        case "resumeDownloadSession":
            if let sessionId = body["sessionId"] as? String {
                downloadStateLock.lock()
                cancelledDownloadSessions.remove(sessionId)
                downloadStateLock.unlock()
            }

        case "cancelDownloadSession":
            if let sessionId = body["sessionId"] as? String {
                downloadStateLock.lock()
                cancelledDownloadSessions.insert(sessionId)
                downloadStateLock.unlock()
            }

        case "cancelDownloadItem":
            if let itemId = body["itemId"] as? String {
                downloadStateLock.lock()
                cancelledDownloadItems.insert(itemId)
                downloadStateLock.unlock()
            }

        case "discardCancelledVideoDownload":
            if let uri = body["uri"] as? String, !uri.isEmpty {
                downloadQueue.async {
                    if let url = URL(string: uri), url.isFileURL {
                        try? FileManager.default.removeItem(at: url)
                    } else if FileManager.default.fileExists(atPath: uri) {
                        try? FileManager.default.removeItem(atPath: uri)
                    }
                }
            }

        case "downloadZip":
            if let dataUrl = body["dataUrl"] as? String,
               let name = body["name"] as? String {
                downloadZip(base64ZipData: dataUrl, zipFileName: name)
            }

        case "getCurrentLocation":
            let callbackId = body["callbackId"] as? String ?? ""
            getCurrentLocation(callbackId: callbackId)

        case "setGpsMetadataEnabled":
            if let enabled = body["enabled"] as? Bool {
                isGpsMetadataEnabled = enabled
            }

        case "haptic":
            let type = body["type"] as? String ?? "light"
            triggerHaptic(type: type)

        default:
            break
        }
    }

    // MARK: - Upload Source Action Sheet (Photo Library, Choose Files [TAR/ZIP/All], Camera)

    private func presentUploadSourceChooser() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let vc = self.viewController else { return }

            let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)

            sheet.addAction(UIAlertAction(title: "Photo Library (Photos & Videos)", style: .default) { [weak self] _ in
                self?.openPhotoLibraryPicker()
            })

            sheet.addAction(UIAlertAction(title: "Choose Files (TAR, ZIP, Videos, Photos, PDF)", style: .default) { [weak self] _ in
                self?.openDocumentFilesPicker()
            })

            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                sheet.addAction(UIAlertAction(title: "Take Photo or Video", style: .default) { [weak self] _ in
                    self?.openCamera()
                })
            }

            sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
                self?.targetAlbumForImport = nil
            })

            if let popover = sheet.popoverPresentationController {
                popover.sourceView = vc.view
                popover.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }

            vc.present(sheet, animated: true)
        }
    }

    // MARK: - Camera (Photos & Videos — Front & Back, Flash Off by Default)

    private func restorePlaybackAudioSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [])
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    private func openCamera() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            showAlert(title: "Camera Unavailable", message: "Camera is not available on this device or simulator.")
            return
        }

        let presentPickerOnMain: () -> Void = { [weak self] in
            DispatchQueue.main.async {
                guard let self = self, let vc = self.viewController else { return }
                // Pause any active playback and release playback audio session so video recording has clean mic access
                self.webView?.evaluateJavaScript(
                    "(function(){ try { var v = document.getElementById('detailVideo'); if (v && !v.paused) { if (typeof silenceIosAudioForPause === 'function') silenceIosAudioForPause(v); v.pause(); } } catch(_){} })();",
                    completionHandler: nil
                )
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

                let picker = UIImagePickerController()
                picker.sourceType = .camera
                picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
                picker.cameraCaptureMode = .photo
                picker.videoQuality = .typeHigh
                picker.videoExportPreset = AVAssetExportPresetPassthrough
                picker.videoMaximumDuration = 86400
                // Disable Auto/Retina Flash on BOTH front and rear cameras by default to avoid blinding screen flash
                if UIImagePickerController.isCameraDeviceAvailable(.front) {
                    picker.cameraDevice = .front
                    picker.cameraFlashMode = .off
                }
                if UIImagePickerController.isCameraDeviceAvailable(.rear) {
                    picker.cameraDevice = .rear
                    picker.cameraFlashMode = .off
                } else {
                    picker.cameraFlashMode = .off
                }
                picker.delegate = self
                picker.allowsEditing = false
                picker.modalPresentationStyle = .fullScreen
                vc.present(picker, animated: true)
            }
        }

        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self = self else { return }
            guard granted else {
                DispatchQueue.main.async {
                    self.showAlert(title: "Camera Access Required", message: "Please enable Camera access in iOS Settings > PicShelf to capture photos and videos.")
                }
                return
            }
            if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                AVCaptureDevice.requestAccess(for: .audio) { _ in
                    presentPickerOnMain()
                }
            } else {
                presentPickerOnMain()
            }
        }
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
        // Captured Video (Front or Back Camera)
        if let mediaURL = info[.mediaURL] as? URL {
            let capturedAlbum = targetAlbumForImport
            targetAlbumForImport = nil
            let ext = mediaURL.pathExtension.isEmpty ? "mov" : mediaURL.pathExtension.lowercased()
            // Copy synchronously BEFORE dismissing picker (APFS CoW clone is <1ms) so iOS cannot delete tmp capture file
            let stored = PicShelfMediaStore.shared.storeFileByCopying(from: mediaURL, ext: ext)
            picker.dismiss(animated: true) { [weak self] in
                self?.restorePlaybackAudioSession()
            }
            guard let stored = stored else {
                showWebToast("Could not save captured video. Please try again.", durationMs: 3500)
                return
            }
            importQueue.async { [weak self] in
                guard let self = self else { return }
                let baseName = "Camera_Video_\(Int(Date().timeIntervalSince1970)).\(ext)"
                self.registerKnownSourceId(stored.sourceId)
                let vmeta = PicShelfMediaStore.extractVideoMetadata(from: stored.fileURL, includeGps: self.isGpsMetadataEnabled)
                var locDict = vmeta.location
                if locDict == nil && self.isGpsMetadataEnabled, let loc = self.lastKnownLocation {
                    let lat = loc.coordinate.latitude
                    let lon = loc.coordinate.longitude
                    let displayCoords = String(format: "%.4f° %@, %.4f° %@", abs(lat), lat >= 0 ? "N" : "S", abs(lon), lon >= 0 ? "E" : "W")
                    locDict = ["latitude": lat, "longitude": lon, "displayCoords": displayCoords, "place": "", "city": "", "country": ""]
                }
                var item: [String: Any] = [
                    "displayName": baseName,
                    "mediaType": "video",
                    "fileSize": stored.size,
                    "duration": vmeta.duration > 0 ? round(vmeta.duration) : 1,
                    "createdAt": vmeta.createdAt ?? (Date().timeIntervalSince1970 * 1000.0),
                    "tarEntry": [
                        "nativeSourceId": stored.sourceId,
                        "offset": 0,
                        "size": stored.size,
                        "baseName": baseName
                    ]
                ]
                if let loc = locDict { item["location"] = loc }
                if let cam = vmeta.cameraModel { item["cameraModel"] = cam }
                self.emitImportBatch([item], targetAlbum: capturedAlbum)
                self.emitImportFinished(totalCount: 1, targetAlbum: capturedAlbum)
                PicShelfMediaStore.shared.unmarkImporting(stored.sourceId)
            }
            return
        }

        // Captured Photo (Front or Back Camera)
        let image = info[.originalImage] as? UIImage
        let capturedAlbum = targetAlbumForImport
        targetAlbumForImport = nil
        picker.dismiss(animated: true) { [weak self] in
            self?.restorePlaybackAudioSession()
        }
        guard let image = image else { return }

        importQueue.async { [weak self] in
            guard let self = self else { return }
            let oriented = self.normalizeOrientation(image)
            guard let jpegData = oriented.jpegData(compressionQuality: 0.90),
                  let stored = PicShelfMediaStore.shared.storeData(jpegData, ext: "jpg") else {
                return
            }
            let baseName = "Camera_Shot_\(Int(Date().timeIntervalSince1970)).jpg"
            var locDict: [String: Any]? = nil
            if self.isGpsMetadataEnabled, let loc = self.lastKnownLocation {
                let lat = loc.coordinate.latitude
                let lon = loc.coordinate.longitude
                let displayCoords = String(format: "%.4f° %@, %.4f° %@", abs(lat), lat >= 0 ? "N" : "S", abs(lon), lon >= 0 ? "E" : "W")
                locDict = ["latitude": lat, "longitude": lon, "displayCoords": displayCoords, "place": "", "city": "", "country": ""]
            }
            self.registerKnownSourceId(stored.sourceId)
            var item: [String: Any] = [
                "displayName": "Camera Shot",
                "mediaType": "image",
                "fileSize": stored.size,
                "createdAt": Date().timeIntervalSince1970 * 1000.0,
                "tarEntry": [
                    "nativeSourceId": stored.sourceId,
                    "offset": 0,
                    "size": stored.size,
                    "baseName": baseName
                ]
            ]
            if let loc = locDict { item["location"] = loc }
            self.emitImportBatch([item], targetAlbum: capturedAlbum)
            self.emitImportFinished(totalCount: 1, targetAlbum: capturedAlbum)
            PicShelfMediaStore.shared.unmarkImporting(stored.sourceId)
        }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true) { [weak self] in
            self?.restorePlaybackAudioSession()
        }
    }

    // MARK: - Modern Native Photo Library Picker (Unlimited Multi-Select Photos + HEIC + Live Photos + Videos)

    private func openPhotoLibraryPicker() {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.selectionLimit = 0 // Unlimited multi-selection!
        config.filter = nil // All Photos, Live Photos, HEIC, PNG, JPEG, AND Videos!
        config.preferredAssetRepresentationMode = .current // Avoids WebKit/iOS transcode dropouts

        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        viewController?.present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        let capturedAlbum = targetAlbumForImport
        targetAlbumForImport = nil
        guard !results.isEmpty else { return }

        let totalSelected = results.count
        showWebToast("Importing \(totalSelected) item\(totalSelected > 1 ? "s" : "")...", durationMs: 2500)

        importQueue.async { [weak self] in
            guard let self = self else { return }
            var totalImported = 0
            var pendingBatch: [[String: Any]] = []
            var storedIdsToUnmark: [String] = []
            let batchThreshold = 12

            for (idx, result) in results.enumerated() {
                if totalSelected > 2 && idx % 3 == 0 {
                    self.showWebToast("Importing \(idx + 1) / \(totalSelected)...", durationMs: 1800)
                }

                let item: [String: Any]? = autoreleasepool {
                    return self.loadSinglePickerResult(result, index: idx)
                }

                if let validItem = item {
                    if let tar = validItem["tarEntry"] as? [String: Any], let sid = tar["nativeSourceId"] as? String {
                        storedIdsToUnmark.append(sid)
                    }
                    pendingBatch.append(validItem)
                    totalImported += 1
                    if pendingBatch.count >= batchThreshold || totalImported == 1 {
                        self.emitImportBatch(pendingBatch, targetAlbum: capturedAlbum)
                        pendingBatch.removeAll(keepingCapacity: true)
                    }
                }
            }

            if !pendingBatch.isEmpty {
                self.emitImportBatch(pendingBatch, targetAlbum: capturedAlbum)
                pendingBatch.removeAll()
            }

            if totalImported > 0 {
                self.emitImportFinished(totalCount: totalImported, targetAlbum: capturedAlbum)
            } else {
                self.showWebToast("Could not load selected media. If stored in iCloud, ensure internet is available.", durationMs: 4500)
            }

            for sid in storedIdsToUnmark {
                PicShelfMediaStore.shared.unmarkImporting(sid)
            }
        }
    }

    private func loadSinglePickerResult(_ result: PHPickerResult, index: Int) -> [String: Any]? {
        let provider = result.itemProvider
        let rawName = provider.suggestedName ?? "Moment_\(Int(Date().timeIntervalSince1970 * 1000))_\(index)"

        // 1. Check Video FIRST (movie conforms to UTType.movie; Live Photos do NOT conform to UTType.movie)
        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            let sem = DispatchSemaphore(value: 0)
            var importedItem: [String: Any]? = nil

            provider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { [weak self] url, error in
                defer { sem.signal() }
                guard let self = self, let url = url, error == nil else { return }
                let ext = url.pathExtension.isEmpty ? "mov" : url.pathExtension.lowercased()
                let fileName = rawName.lowercased().hasSuffix(".\(ext)") ? rawName : "\(rawName).\(ext)"
                importedItem = self.ingestVideoFile(from: url, displayName: fileName)
            }
            _ = sem.wait(timeout: .now() + 180)
            if let item = importedItem { return item }
        }

        // 2. Image (HEIC, HEIF, JPEG, PNG, GIF, WebP, RAW, Live Photo)
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            // Attempt A: Streaming disk-to-disk loadFileRepresentation (preserves full EXIF/GPS, zero RAM bloat)
            let sem = DispatchSemaphore(value: 0)
            var importedItem: [String: Any]? = nil

            provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] url, error in
                defer { sem.signal() }
                guard let self = self, let url = url, error == nil else { return }
                let ext = url.pathExtension.isEmpty ? "jpg" : url.pathExtension.lowercased()
                let fileName = rawName.lowercased().hasSuffix(".\(ext)") ? rawName : "\(rawName).\(ext)"
                importedItem = self.ingestImageFile(from: url, displayName: fileName)
            }
            _ = sem.wait(timeout: .now() + 90)
            if let item = importedItem { return item }

            // Attempt B: Fallback via loadDataRepresentation (handles some iCloud / virtual asset providers)
            let sem2 = DispatchSemaphore(value: 0)
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] data, _ in
                defer { sem2.signal() }
                guard let self = self, let data = data, !data.isEmpty else { return }
                let tmpURL = FileManager.default.temporaryDirectory.appendingPathComponent("ps_fb_\(UUID().uuidString).img")
                do {
                    try data.write(to: tmpURL)
                    defer { try? FileManager.default.removeItem(at: tmpURL) }
                    importedItem = self.ingestImageFile(from: tmpURL, displayName: "\(rawName).jpg")
                } catch {}
            }
            _ = sem2.wait(timeout: .now() + 90)
            if let item = importedItem { return item }
        }

        // Attempt C: Final fallback via UIImage object loader
        if provider.canLoadObject(ofClass: UIImage.self) {
            let sem3 = DispatchSemaphore(value: 0)
            var importedItem: [String: Any]? = nil
            provider.loadObject(ofClass: UIImage.self) { [weak self] obj, _ in
                defer { sem3.signal() }
                guard let self = self, let uiImg = obj as? UIImage else { return }
                let oriented = self.normalizeOrientation(uiImg)
                guard let jpeg = oriented.jpegData(compressionQuality: 0.90),
                      let stored = PicShelfMediaStore.shared.storeData(jpeg, ext: "jpg") else { return }
                self.registerKnownSourceId(stored.sourceId)
                let cleanDisplay = (rawName as NSString).deletingPathExtension
                importedItem = [
                    "displayName": cleanDisplay.isEmpty ? rawName : cleanDisplay,
                    "mediaType": "image",
                    "fileSize": stored.size,
                    "createdAt": Date().timeIntervalSince1970 * 1000.0,
                    "tarEntry": [
                        "nativeSourceId": stored.sourceId,
                        "offset": 0,
                        "size": stored.size,
                        "baseName": "\(cleanDisplay.isEmpty ? rawName : cleanDisplay).jpg"
                    ]
                ]
            }
            _ = sem3.wait(timeout: .now() + 60)
            if let item = importedItem { return item }
        }

        return nil
    }

    // MARK: - Native Files Picker (TAR, ZIP, TAR.GZ, TGZ, PDF, Videos, Audio, Photos — Unlimited Multi-Select)

    private func openDocumentFilesPicker() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.item], asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = self
        viewController?.present(picker, animated: true)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        targetAlbumForImport = nil
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let capturedAlbum = targetAlbumForImport
        targetAlbumForImport = nil
        guard !urls.isEmpty else { return }

        showWebToast("Opening \(urls.count) file\(urls.count > 1 ? "s" : "")...", durationMs: 2200)

        importQueue.async { [weak self] in
            guard let self = self else { return }
            var totalImported = 0
            var pendingBatch: [[String: Any]] = []
            var storedIdsToUnmark: [String] = []

            let flushBatch = {
                if !pendingBatch.isEmpty {
                    self.emitImportBatch(pendingBatch, targetAlbum: capturedAlbum)
                    pendingBatch.removeAll(keepingCapacity: true)
                }
            }

            for fileURL in urls {
                let accessed = fileURL.startAccessingSecurityScopedResource()
                defer { if accessed { fileURL.stopAccessingSecurityScopedResource() } }

                let fileName = fileURL.lastPathComponent
                let lower = fileName.lowercased()

                // 1. Plain TAR archive
                if lower.hasSuffix(".tar") {
                    self.showWebToast("Opening archive '\(fileName)'...", durationMs: 2500)
                    if let stored = PicShelfMediaStore.shared.storeFileByCopying(from: fileURL, ext: "tar") {
                        self.registerKnownSourceId(stored.sourceId)
                        storedIdsToUnmark.append(stored.sourceId)
                        let count = self.indexTarArchive(fileURL: stored.fileURL, sourceId: stored.sourceId, targetAlbum: capturedAlbum)
                        totalImported += count
                    }
                    continue
                }

                // 2. GZIP / TAR.GZ / TGZ archive
                if lower.hasSuffix(".tar.gz") || lower.hasSuffix(".tgz") || lower.hasSuffix(".gz") {
                    self.showWebToast("Decompressing '\(fileName)'...", durationMs: 3000)
                    let isTarGz = lower.hasSuffix(".tar.gz") || lower.hasSuffix(".tgz")
                    let outExt = isTarGz ? "tar" : ((String(lower.dropLast(3)) as NSString).pathExtension)
                    let sourceId = "\(UUID().uuidString.lowercased()).\(PicShelfMediaStore.shared.sanitizeExtension(outExt.isEmpty ? "tar" : outExt))"
                    let dstURL = PicShelfMediaStore.shared.sourcesDir.appendingPathComponent(sourceId)
                    PicShelfMediaStore.shared.markImporting(sourceId)
                    if let written = PicShelfMediaStore.shared.decompressGzipFile(from: fileURL, to: dstURL), written > 0 {
                        self.registerKnownSourceId(sourceId)
                        storedIdsToUnmark.append(sourceId)
                        let tarCount = self.indexTarArchive(fileURL: dstURL, sourceId: sourceId, targetAlbum: capturedAlbum)
                        if tarCount > 0 {
                            totalImported += tarCount
                        } else if !isTarGz, let item = self.ingestStandaloneDocument(from: dstURL, fileName: String(fileName.dropLast(3))) {
                            pendingBatch.append(item)
                            totalImported += 1
                            flushBatch()
                        } else {
                            try? FileManager.default.removeItem(at: dstURL)
                        }
                    } else {
                        try? FileManager.default.removeItem(at: dstURL)
                        PicShelfMediaStore.shared.unmarkImporting(sourceId)
                    }
                    continue
                }

                // 3. ZIP / CBZ archive
                if lower.hasSuffix(".zip") || lower.hasSuffix(".cbz") {
                    self.showWebToast("Opening archive '\(fileName)'...", durationMs: 2500)
                    if let stored = PicShelfMediaStore.shared.storeFileByCopying(from: fileURL, ext: "zip") {
                        self.registerKnownSourceId(stored.sourceId)
                        storedIdsToUnmark.append(stored.sourceId)
                        let count = self.indexZipArchive(fileURL: stored.fileURL, sourceId: stored.sourceId, targetAlbum: capturedAlbum)
                        totalImported += count
                    }
                    continue
                }

                // 4. Individual media files (Image, HEIC, PDF, Video, Audio)
                if let item = autoreleasepool(invoking: { self.ingestStandaloneDocument(from: fileURL, fileName: fileName) }) {
                    if let tar = item["tarEntry"] as? [String: Any], let sid = tar["nativeSourceId"] as? String {
                        storedIdsToUnmark.append(sid)
                    }
                    pendingBatch.append(item)
                    totalImported += 1
                    if pendingBatch.count >= 20 || totalImported == 1 {
                        flushBatch()
                    }
                }
            }

            flushBatch()

            if totalImported > 0 {
                self.emitImportFinished(totalCount: totalImported, targetAlbum: capturedAlbum)
            } else {
                self.showWebToast("No supported media files found in the selected item(s).", durationMs: 4000)
            }

            for sid in storedIdsToUnmark {
                PicShelfMediaStore.shared.unmarkImporting(sid)
            }
        }
    }

    // MARK: - File Ingestion Helpers (Images, HEIC, PDF, Videos, Audio)

    private func ingestStandaloneDocument(from fileURL: URL, fileName: String) -> [String: Any]? {
        let ext = (fileName as NSString).pathExtension.lowercased()
        if ext == "pdf" {
            return ingestPDFFile(from: fileURL, displayName: fileName)
        }
        guard let category = PicShelfMediaStore.mediaCategory(for: fileName) else { return nil }
        switch category {
        case "video":
            return ingestVideoFile(from: fileURL, displayName: fileName)
        case "audio":
            return ingestAudioFile(from: fileURL, displayName: fileName)
        default:
            return ingestImageFile(from: fileURL, displayName: fileName)
        }
    }

    private func ingestImageFile(from srcURL: URL, displayName: String) -> [String: Any]? {
        var metaLocation: [String: Any]? = nil
        var metaCreatedAt: Double? = nil
        var metaCamera: String? = nil

        if let src = CGImageSourceCreateWithURL(srcURL as CFURL, nil) {
            let meta = PicShelfMediaStore.extractImageMetadata(from: src, includeGps: isGpsMetadataEnabled)
            metaLocation = meta.location
            metaCreatedAt = meta.createdAt
            metaCamera = meta.cameraModel
        }

        let srcExt = srcURL.pathExtension.lowercased()
        let webSafeExts: Set<String> = ["jpg", "jpeg", "png", "gif", "webp", "bmp"]
        let isWebSafe = webSafeExts.contains(srcExt)

        let storedResult: (sourceId: String, fileURL: URL, size: Int64)?
        let finalBaseName: String
        let cleanTitle = (displayName as NSString).deletingPathExtension
        let safeTitle = cleanTitle.isEmpty ? displayName : cleanTitle

        if isWebSafe {
            storedResult = PicShelfMediaStore.shared.storeFileByCopying(from: srcURL, ext: srcExt)
            finalBaseName = "\(safeTitle).\(srcExt)"
        } else {
            // Convert HEIC / HEIF / RAW / DNG / TIFF to oriented JPEG on disk so WKWebView <img> & <canvas> always render & edit cleanly
            var convertedData: Data? = nil
            if let img = UIImage(contentsOfFile: srcURL.path) {
                let oriented = normalizeOrientation(img)
                convertedData = oriented.jpegData(compressionQuality: 0.90)
            } else if let src = CGImageSourceCreateWithURL(srcURL as CFURL, nil),
                      let cgImg = CGImageSourceCreateImageAtIndex(src, 0, nil) {
                convertedData = UIImage(cgImage: cgImg).jpegData(compressionQuality: 0.90)
            }
            guard let jpeg = convertedData else { return nil }
            storedResult = PicShelfMediaStore.shared.storeData(jpeg, ext: "jpg")
            finalBaseName = "\(safeTitle).jpg"
        }

        guard let stored = storedResult else { return nil }
        registerKnownSourceId(stored.sourceId)

        let modMs = ((try? FileManager.default.attributesOfItem(atPath: srcURL.path)[.modificationDate] as? Date)?.timeIntervalSince1970 ?? Date().timeIntervalSince1970) * 1000.0

        var item: [String: Any] = [
            "displayName": safeTitle,
            "mediaType": "image",
            "fileSize": stored.size,
            "createdAt": metaCreatedAt ?? modMs,
            "tarEntry": [
                "nativeSourceId": stored.sourceId,
                "offset": 0,
                "size": stored.size,
                "baseName": finalBaseName
            ]
        ]
        if let loc = metaLocation { item["location"] = loc }
        if let cam = metaCamera { item["cameraModel"] = cam }
        return item
    }

    private func ingestPDFFile(from srcURL: URL, displayName: String) -> [String: Any]? {
        let cleanTitle = (displayName as NSString).deletingPathExtension
        let safeTitle = cleanTitle.isEmpty ? displayName : cleanTitle
        guard let jpeg = PicShelfMediaStore.renderPDFPage1JPEG(from: srcURL, maxWidth: 1400),
              let stored = PicShelfMediaStore.shared.storeData(jpeg, ext: "jpg") else {
            return nil
        }
        registerKnownSourceId(stored.sourceId)
        return [
            "displayName": safeTitle,
            "mediaType": "image",
            "fileSize": stored.size,
            "createdAt": Date().timeIntervalSince1970 * 1000.0,
            "tarEntry": [
                "nativeSourceId": stored.sourceId,
                "offset": 0,
                "size": stored.size,
                "baseName": "\(safeTitle).jpg"
            ]
        ]
    }

    private func ingestVideoFile(from srcURL: URL, displayName: String) -> [String: Any]? {
        let ext = srcURL.pathExtension.isEmpty ? "mov" : srcURL.pathExtension.lowercased()
        guard let stored = PicShelfMediaStore.shared.storeFileByCopying(from: srcURL, ext: ext) else {
            return nil
        }
        registerKnownSourceId(stored.sourceId)

        let vmeta = PicShelfMediaStore.extractVideoMetadata(from: stored.fileURL, includeGps: isGpsMetadataEnabled)
        var item: [String: Any] = [
            "displayName": displayName,
            "mediaType": "video",
            "fileSize": stored.size,
            "duration": vmeta.duration > 0 ? round(vmeta.duration) : 6,
            "createdAt": vmeta.createdAt ?? (Date().timeIntervalSince1970 * 1000.0),
            "tarEntry": [
                "nativeSourceId": stored.sourceId,
                "offset": 0,
                "size": stored.size,
                "baseName": displayName
            ]
        ]
        if let loc = vmeta.location { item["location"] = loc }
        if let cam = vmeta.cameraModel { item["cameraModel"] = cam }
        return item
    }

    private func ingestAudioFile(from srcURL: URL, displayName: String) -> [String: Any]? {
        let ext = srcURL.pathExtension.isEmpty ? "mp3" : srcURL.pathExtension.lowercased()
        guard let stored = PicShelfMediaStore.shared.storeFileByCopying(from: srcURL, ext: ext) else {
            return nil
        }
        registerKnownSourceId(stored.sourceId)

        let asset = AVURLAsset(url: stored.fileURL)
        let durSec = CMTimeGetSeconds(asset.duration)
        let duration = (durSec.isFinite && durSec > 0) ? round(durSec) : 0

        return [
            "displayName": displayName,
            "mediaType": "audio",
            "fileSize": stored.size,
            "duration": duration,
            "createdAt": Date().timeIntervalSince1970 * 1000.0,
            "tarEntry": [
                "nativeSourceId": stored.sourceId,
                "offset": 0,
                "size": stored.size,
                "baseName": displayName
            ]
        ]
    }

    // MARK: - Streaming On-Disk TAR Archive Indexer (Zero-RAM, USTAR + PAX + GNU LongName)

    private func indexTarArchive(fileURL: URL, sourceId: String, targetAlbum: String?) -> Int {
        guard let fh = try? FileHandle(forReadingFrom: fileURL),
              let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let fileSize = (attrs[.size] as? NSNumber)?.uint64Value else {
            return 0
        }
        defer { try? fh.close() }

        var offset: UInt64 = 0
        var paxPath: String? = nil
        var paxSize: UInt64? = nil
        var gnuLongName: String? = nil
        var totalIndexed = 0
        var batch: [[String: Any]] = []
        let nowMs = Date().timeIntervalSince1970 * 1000.0

        while offset + 512 <= fileSize {
            do {
                try fh.seek(toOffset: offset)
                guard let header = try fh.read(upToCount: 512), header.count == 512 else { break }

                // Check all-zero end-of-archive block
                if header.allSatisfy({ $0 == 0 }) { break }

                let typeFlag = header[156]
                let rawSize = parseTarOctal(header, start: 124, length: 12)
                let entrySize = paxSize ?? rawSize
                let dataOffset = offset + 512

                // GNU LongName ('L')
                if typeFlag == 0x4c { // 'L'
                    if entrySize > 0 && entrySize < 65536, let nameData = try fh.read(upToCount: Int(entrySize)) {
                        gnuLongName = String(data: nameData, encoding: .utf8)?.trimmingCharacters(in: CharacterSet(charactersIn: "\0\r\n"))
                    }
                    offset = dataOffset + ((entrySize + 511) / 512) * 512
                    continue
                }

                // PAX Extended Header ('x' or 'g')
                if typeFlag == 0x78 || typeFlag == 0x67 {
                    if entrySize > 0 && entrySize < 1_048_576, let paxData = try fh.read(upToCount: Int(entrySize)),
                       let paxText = String(data: paxData, encoding: .utf8) {
                        for line in paxText.split(separator: "\n") {
                            if let sp = line.firstIndex(of: " ") {
                                let kv = String(line[line.index(after: sp)...])
                                if kv.hasPrefix("path=") {
                                    paxPath = String(kv.dropFirst(5))
                                } else if kv.hasPrefix("size="), let s = UInt64(kv.dropFirst(5)) {
                                    paxSize = s
                                }
                            }
                        }
                    }
                    offset = dataOffset + ((entrySize + 511) / 512) * 512
                    continue
                }

                // Regular file ('0' or '\0')
                let isRegularFile = (typeFlag == 0x30 || typeFlag == 0x00)
                let nameStr = parseTarString(header, start: 0, length: 100)
                let prefixStr = parseTarString(header, start: 345, length: 155)
                let combinedPath = paxPath ?? gnuLongName ?? (prefixStr.isEmpty ? nameStr : "\(prefixStr)/\(nameStr)")
                paxPath = nil
                paxSize = nil
                gnuLongName = nil

                if isRegularFile && entrySize > 0 && dataOffset + entrySize <= fileSize {
                    let baseName = (combinedPath as NSString).lastPathComponent
                    let isJunk = combinedPath.contains("__MACOSX/") || baseName.hasPrefix("._") || baseName.hasPrefix(".")
                    if !isJunk, let mediaType = PicShelfMediaStore.mediaCategory(for: baseName) {
                        let cleanDisplay = (mediaType == "image") ? ((baseName as NSString).deletingPathExtension.isEmpty ? baseName : (baseName as NSString).deletingPathExtension) : baseName
                        batch.append([
                            "displayName": cleanDisplay,
                            "mediaType": mediaType,
                            "fileSize": entrySize,
                            "createdAt": nowMs + Double(totalIndexed),
                            "tarEntry": [
                                "nativeSourceId": sourceId,
                                "offset": dataOffset,
                                "size": entrySize,
                                "baseName": baseName
                            ]
                        ])
                        totalIndexed += 1
                        if batch.count >= (totalIndexed <= 60 ? 60 : 250) {
                            emitImportBatch(batch, targetAlbum: targetAlbum)
                            batch.removeAll(keepingCapacity: true)
                            if totalIndexed % 500 == 0 {
                                showWebToast("Importing archive: \(totalIndexed) items...", durationMs: 1200)
                            }
                        }
                    }
                }

                offset = dataOffset + ((entrySize + 511) / 512) * 512
            } catch {
                break
            }
        }

        if !batch.isEmpty {
            emitImportBatch(batch, targetAlbum: targetAlbum)
        }
        return totalIndexed
    }

    private func parseTarString(_ data: Data, start: Int, length: Int) -> String {
        let slice = data.subdata(in: start..<(start + length))
        let trimmed = slice.prefix { $0 != 0 }
        return String(data: trimmed, encoding: .utf8) ?? ""
    }

    private func parseTarOctal(_ data: Data, start: Int, length: Int) -> UInt64 {
        // GNU base-256 binary size support (high bit set)
        if (data[start] & 0x80) != 0 {
            var val: UInt64 = 0
            for i in (start + 1)..<(start + length) {
                val = (val << 8) | UInt64(data[i])
            }
            return val
        }
        let s = parseTarString(data, start: start, length: length).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        return UInt64(s, radix: 8) ?? 0
    }

    // MARK: - Streaming On-Disk ZIP Archive Indexer (Standard ZIP + ZIP64, Stored + Deflate)

    private func indexZipArchive(fileURL: URL, sourceId: String, targetAlbum: String?) -> Int {
        guard let fh = try? FileHandle(forReadingFrom: fileURL),
              let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let fileSize = (attrs[.size] as? NSNumber)?.uint64Value,
              fileSize >= 22 else {
            return 0
        }
        defer { try? fh.close() }

        func readU16(_ d: Data, _ o: Int) -> UInt16 {
            return UInt16(d[o]) | (UInt16(d[o + 1]) << 8)
        }
        func readU32(_ d: Data, _ o: Int) -> UInt32 {
            return UInt32(d[o]) | (UInt32(d[o + 1]) << 8) | (UInt32(d[o + 2]) << 16) | (UInt32(d[o + 3]) << 24)
        }
        func readU64(_ d: Data, _ o: Int) -> UInt64 {
            let lo = UInt64(readU32(d, o))
            let hi = UInt64(readU32(d, o + 4))
            return lo | (hi << 32)
        }

        // Locate EOCD (PK\x05\x06) within last 65557 bytes
        let tailLen = min(fileSize, 65557)
        let tailStart = fileSize - tailLen
        guard (try? fh.seek(toOffset: tailStart)) != nil,
              let tail = try? fh.read(upToCount: Int(tailLen)),
              tail.count >= 22 else { return 0 }

        var eocdPos: Int? = nil
        for i in stride(from: tail.count - 22, through: 0, by: -1) {
            if tail[i] == 0x50 && tail[i + 1] == 0x4b && tail[i + 2] == 0x05 && tail[i + 3] == 0x06 {
                eocdPos = i
                break
            }
        }
        guard let eocdIdx = eocdPos else { return 0 }

        var cdSize = UInt64(readU32(tail, eocdIdx + 12))
        var cdOffset = UInt64(readU32(tail, eocdIdx + 16))

        // Check ZIP64 EOCD Locator (20 bytes immediately before EOCD)
        if (cdOffset == 0xFFFFFFFF || cdSize == 0xFFFFFFFF) && eocdIdx >= 20 {
            let locIdx = eocdIdx - 20
            if readU32(tail, locIdx) == 0x07064b50 {
                let z64EocdOffset = readU64(tail, locIdx + 8)
                if (try? fh.seek(toOffset: z64EocdOffset)) != nil,
                   let z64 = try? fh.read(upToCount: 56), z64.count == 56,
                   readU32(z64, 0) == 0x06064b50 {
                    cdSize = readU64(z64, 40)
                    cdOffset = readU64(z64, 48)
                }
            }
        }

        guard cdOffset + cdSize <= fileSize, cdSize > 0 else { return 0 }

        // Read Central Directory (bounded safely; stream in chunks if huge)
        guard (try? fh.seek(toOffset: cdOffset)) != nil,
              let cdData = try? fh.read(upToCount: Int(min(cdSize, 128 * 1024 * 1024))) else {
            return 0
        }

        var pos = 0
        var totalIndexed = 0
        var batch: [[String: Any]] = []
        let nowMs = Date().timeIntervalSince1970 * 1000.0

        while pos + 46 <= cdData.count {
            guard readU32(cdData, pos) == 0x02014b50 else { break }
            let method = Int(readU16(cdData, pos + 10))
            var compSize = UInt64(readU32(cdData, pos + 20))
            var uncompSize = UInt64(readU32(cdData, pos + 24))
            let fnLen = Int(readU16(cdData, pos + 28))
            let extraLen = Int(readU16(cdData, pos + 30))
            let commentLen = Int(readU16(cdData, pos + 32))
            var localOffset = UInt64(readU32(cdData, pos + 42))

            let entryEnd = pos + 46 + fnLen + extraLen + commentLen
            guard entryEnd <= cdData.count else { break }

            let fnData = cdData.subdata(in: (pos + 46)..<(pos + 46 + fnLen))
            let fn = String(data: fnData, encoding: .utf8) ?? String(data: fnData, encoding: .isoLatin1) ?? ""

            // Parse ZIP64 extra field if needed
            if compSize == 0xFFFFFFFF || uncompSize == 0xFFFFFFFF || localOffset == 0xFFFFFFFF {
                var ePos = pos + 46 + fnLen
                let eEnd = ePos + extraLen
                while ePos + 4 <= eEnd {
                    let headerId = readU16(cdData, ePos)
                    let dataSize = Int(readU16(cdData, ePos + 2))
                    if headerId == 0x0001 && ePos + 4 + dataSize <= eEnd {
                        var zPos = ePos + 4
                        if uncompSize == 0xFFFFFFFF && zPos + 8 <= ePos + 4 + dataSize {
                            uncompSize = readU64(cdData, zPos); zPos += 8
                        }
                        if compSize == 0xFFFFFFFF && zPos + 8 <= ePos + 4 + dataSize {
                            compSize = readU64(cdData, zPos); zPos += 8
                        }
                        if localOffset == 0xFFFFFFFF && zPos + 8 <= ePos + 4 + dataSize {
                            localOffset = readU64(cdData, zPos); zPos += 8
                        }
                        break
                    }
                    ePos += 4 + dataSize
                }
            }

            pos = entryEnd

            if !fn.hasSuffix("/") && compSize > 0 && (method == 0 || method == 8) {
                let baseName = (fn as NSString).lastPathComponent
                let isJunk = fn.contains("__MACOSX/") || baseName.hasPrefix("._") || baseName.hasPrefix(".")
                if !isJunk, let mediaType = PicShelfMediaStore.mediaCategory(for: baseName) {
                    let cleanDisplay = (mediaType == "image") ? ((baseName as NSString).deletingPathExtension.isEmpty ? baseName : (baseName as NSString).deletingPathExtension) : baseName
                    batch.append([
                        "displayName": cleanDisplay,
                        "mediaType": mediaType,
                        "fileSize": uncompSize > 0 ? uncompSize : compSize,
                        "createdAt": nowMs + Double(totalIndexed),
                        "zipEntry": [
                            "nativeSourceId": sourceId,
                            "localOffset": localOffset,
                            "compSize": compSize,
                            "uncompSize": uncompSize > 0 ? uncompSize : compSize,
                            "method": method,
                            "baseName": baseName,
                            "fn": fn
                        ]
                    ])
                    totalIndexed += 1
                    if batch.count >= (totalIndexed <= 60 ? 60 : 250) {
                        emitImportBatch(batch, targetAlbum: targetAlbum)
                        batch.removeAll(keepingCapacity: true)
                    }
                }
            }
        }

        if !batch.isEmpty {
            emitImportBatch(batch, targetAlbum: targetAlbum)
        }
        return totalIndexed
    }

    // MARK: - JS Bridge Dispatchers

    private func registerKnownSourceId(_ sourceId: String) {
        let escaped = sourceId.replacingOccurrences(of: "'", with: "\\'")
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("if (window.__iosKnownSourceIds) window.__iosKnownSourceIds.add('\(escaped)');", completionHandler: nil)
        }
    }

    private func showWebToast(_ message: String, durationMs: Int = 2500) {
        guard let data = try? JSONSerialization.data(withJSONObject: [message], options: []),
              let arrJson = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("if (typeof window.showToast === 'function') window.showToast((\(arrJson))[0], \(durationMs));", completionHandler: nil)
        }
    }

    private func emitImportBatch(_ batch: [[String: Any]], targetAlbum: String?) {
        guard !batch.isEmpty,
              let jsonData = try? JSONSerialization.data(withJSONObject: batch, options: []),
              let jsonStr = String(data: jsonData, encoding: .utf8) else { return }

        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let webView = self.webView else {
                sem.signal()
                return
            }
            let js: String
            if let album = targetAlbum, !album.isEmpty,
               let albumData = try? JSONSerialization.data(withJSONObject: [album], options: []),
               let albumArr = String(data: albumData, encoding: .utf8) {
                js = "if (window.onNativePhotosImportedToAlbum) { window.onNativePhotosImportedToAlbum(\(jsonStr), (\(albumArr))[0], { isStreamingBatch: true, deferSave: true, deferRender: true, originalsPrepared: true }); } else if (window.onNativePhotosImported) { window.onNativePhotosImported(\(jsonStr), { isStreamingBatch: true, deferSave: true, deferRender: false, originalsPrepared: true }); }"
            } else {
                js = "if (window.onNativePhotosImported) { window.onNativePhotosImported(\(jsonStr), { isStreamingBatch: true, deferSave: true, deferRender: false, originalsPrepared: true }); }"
            }
            webView.evaluateJavaScript(js) { _, _ in
                sem.signal()
            }
        }
        _ = sem.wait(timeout: .now() + 15)
    }

    private func emitImportFinished(totalCount: Int, targetAlbum: String?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let webView = self.webView else { return }
            let albumLiteral: String
            if let album = targetAlbum, !album.isEmpty,
               let albumData = try? JSONSerialization.data(withJSONObject: [album], options: []),
               let albumArr = String(data: albumData, encoding: .utf8) {
                albumLiteral = "(\(albumArr))[0]"
            } else {
                albumLiteral = "null"
            }
            let js = "if (typeof window._onIOSNativeImportFinished === 'function') { window._onIOSNativeImportFinished(\(totalCount), \(albumLiteral)); }"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // MARK: - Biometrics (Face ID / Touch ID / Passcode)

    private func authenticateBiometrics(mode: String = "unlock") {
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        var error: NSError?

        let reason = "Unlock PicShelf Vault to access your protected memories"
        let dispatchResult: (Bool, String?) -> Void = { [weak self] success, errMsg in
            DispatchQueue.main.async {
                if success {
                    if mode == "reset" {
                        self?.webView?.evaluateJavaScript("if (window.onNativePasscodeResetBiometricResult) { window.onNativePasscodeResetBiometricResult(true); } else if (window.onNativeBiometricResult) { window.onNativeBiometricResult(true); }", completionHandler: nil)
                    } else {
                        self?.webView?.evaluateJavaScript("if (window.onNativeBiometricResult) { window.onNativeBiometricResult(true); }", completionHandler: nil)
                    }
                } else {
                    let msg = (errMsg ?? "Authentication failed").replacingOccurrences(of: "'", with: "\\'")
                    if mode == "reset" {
                        self?.webView?.evaluateJavaScript("if (window.onNativePasscodeResetBiometricResult) { window.onNativePasscodeResetBiometricResult(false, '\(msg)'); } else if (window.onNativeBiometricResult) { window.onNativeBiometricResult(false, '\(msg)'); }", completionHandler: nil)
                    } else {
                        self?.webView?.evaluateJavaScript("if (window.onNativeBiometricResult) { window.onNativeBiometricResult(false, '\(msg)'); }", completionHandler: nil)
                    }
                }
            }
        }

        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, evalError in
                dispatchResult(success, evalError?.localizedDescription)
            }
        } else if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, evalError in
                dispatchResult(success, evalError?.localizedDescription)
            }
        } else {
            dispatchResult(false, "no_device_lock")
        }
    }

    // MARK: - Native Sharing (AirDrop, Messages, WhatsApp, Mail, Copy)

    private func sharePhoto(dataUrl: String, title: String) {
        guard let image = base64ToImage(dataUrl: dataUrl) else { return }
        let activityVC = UIActivityViewController(activityItems: [image, title], applicationActivities: nil)
        if let popover = activityVC.popoverPresentationController {
            popover.sourceView = viewController?.view
            popover.sourceRect = CGRect(x: UIScreen.main.bounds.midX, y: UIScreen.main.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        viewController?.present(activityVC, animated: true)
    }

    private func shareMultiplePhotos(photosJson: String, albumTitle: String) {
        guard let data = photosJson.data(using: .utf8),
              let jsonArray = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return
        }

        var items: [Any] = [albumTitle]
        for item in jsonArray {
            if let dataUrl = item["dataUrl"] as? String, let img = base64ToImage(dataUrl: dataUrl) {
                items.append(img)
            }
        }

        guard items.count > 1 else { return }

        let activityVC = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let popover = activityVC.popoverPresentationController {
            popover.sourceView = viewController?.view
            popover.sourceRect = CGRect(x: UIScreen.main.bounds.midX, y: UIScreen.main.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        viewController?.present(activityVC, animated: true)
    }

    // MARK: - Superfast Native iOS Download Engine (Files › On My iPhone › PicShelf + Optional Apple Photos Mirror)

    private func documentsRootDirectory() -> URL {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first!
        try? fm.createDirectory(at: docs, withIntermediateDirectories: true)
        return docs
    }

    private func resolveExportDirectory(relativePath: String) -> (dirURL: URL, displayPath: String, albumTitle: String) {
        var cleaned = relativePath.replacingOccurrences(of: "\\", with: "/")
        for prefix in ["Pictures/", "Movies/", "Music/"] {
            if cleaned.hasPrefix(prefix) {
                cleaned = String(cleaned.dropFirst(prefix.count))
            }
        }
        if cleaned == "PicShelf" || cleaned == "PicShelf/" {
            cleaned = ""
        } else if cleaned.hasPrefix("PicShelf/") {
            cleaned = String(cleaned.dropFirst("PicShelf/".count))
        }
        let segments = cleaned
            .split(separator: "/")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0 != "." && $0 != ".." }

        let root = documentsRootDirectory()
        var target = root
        for seg in segments {
            target = target.appendingPathComponent(seg, isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)

        let displaySub = segments.isEmpty ? "PicShelf/" : "PicShelf/\(segments.joined(separator: "/"))/"
        let albumTitle = segments.first ?? "PicShelf"
        return (target, "Files › On My iPhone › \(displaySub)", albumTitle)
    }

    private func resolveExportDirectoryReadOnly(relativePath: String) -> URL {
        var cleaned = relativePath.replacingOccurrences(of: "\\", with: "/")
        for prefix in ["Pictures/", "Movies/", "Music/"] {
            if cleaned.hasPrefix(prefix) {
                cleaned = String(cleaned.dropFirst(prefix.count))
            }
        }
        if cleaned == "PicShelf" || cleaned == "PicShelf/" {
            cleaned = ""
        } else if cleaned.hasPrefix("PicShelf/") {
            cleaned = String(cleaned.dropFirst("PicShelf/".count))
        }
        let segments = cleaned
            .split(separator: "/")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0 != "." && $0 != ".." }

        var target = documentsRootDirectory()
        for seg in segments {
            target = target.appendingPathComponent(seg, isDirectory: true)
        }
        return target
    }

    private func verifyDownloadedFiles(requestId: String, itemsJson: String) {
        downloadQueue.async { [weak self] in
            guard let self = self else { return }
            let fm = FileManager.default
            var flags: [Bool] = []
            if let data = itemsJson.data(using: .utf8),
               let items = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                flags.reserveCapacity(items.count)
                for entry in items {
                    var found = false
                    let relPath = (entry["exportLocation"] as? String) ?? "PicShelf/"
                    let dirURL = self.resolveExportDirectoryReadOnly(relativePath: relPath)

                    func isNonEmptyFile(_ url: URL) -> Bool {
                        var isDir: ObjCBool = false
                        guard fm.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue else { return false }
                        if let attrs = try? fm.attributesOfItem(atPath: url.path),
                           let sz = (attrs[.size] as? NSNumber)?.int64Value {
                            return sz > 0
                        }
                        return true
                    }

                    if let savedUri = entry["savedUri"] as? String, !savedUri.isEmpty {
                        if let u = URL(string: savedUri), u.isFileURL {
                            if isNonEmptyFile(u) {
                                found = true
                            } else {
                                // Handle iOS sandbox container UUID change across updates/reinstalls
                                let uriName = u.lastPathComponent
                                if !uriName.isEmpty && isNonEmptyFile(dirURL.appendingPathComponent(uriName)) {
                                    found = true
                                }
                            }
                        }
                    }

                    if !found, let rawName = entry["filename"] as? String, !rawName.isEmpty {
                        let safeName = (rawName as NSString).lastPathComponent
                        if !safeName.isEmpty && isNonEmptyFile(dirURL.appendingPathComponent(safeName)) {
                            found = true
                        }
                    }
                    flags.append(found)
                }
            }

            let resData = (try? JSONSerialization.data(withJSONObject: flags, options: [])) ?? Data("[]".utf8)
            let resJson = String(data: resData, encoding: .utf8) ?? "[]"
            let reqData = (try? JSONSerialization.data(withJSONObject: [requestId], options: [])) ?? Data("[\"\"]".utf8)
            let reqArr = String(data: reqData, encoding: .utf8) ?? "[\"\"]"

            DispatchQueue.main.async { [weak self] in
                self?.webView?.evaluateJavaScript(
                    "if (window._iosVerifyCallbacks && window._iosVerifyCallbacks[(\(reqArr))[0]]) { window._iosVerifyCallbacks[(\(reqArr))[0]](\(resJson)); }",
                    completionHandler: nil
                )
            }
        }
    }

    private func uniqueDestinationURL(in dirURL: URL, fileName: String) -> (url: URL, finalName: String) {
        let fm = FileManager.default
        let safeName = (fileName as NSString).lastPathComponent
        let cleanName = safeName.isEmpty ? "PicShelf_media.jpg" : safeName
        var candidate = dirURL.appendingPathComponent(cleanName)
        if !fm.fileExists(atPath: candidate.path) {
            return (candidate, cleanName)
        }
        let base = (cleanName as NSString).deletingPathExtension
        let ext = (cleanName as NSString).pathExtension
        var counter = 1
        while counter < 10000 {
            let nextName = ext.isEmpty ? "\(base) (\(counter))" : "\(base) (\(counter)).\(ext)"
            candidate = dirURL.appendingPathComponent(nextName)
            if !fm.fileExists(atPath: candidate.path) {
                return (candidate, nextName)
            }
            counter += 1
        }
        let fallbackName = ext.isEmpty ? "\(base)_\(Int(Date().timeIntervalSince1970))" : "\(base)_\(Int(Date().timeIntervalSince1970)).\(ext)"
        return (dirURL.appendingPathComponent(fallbackName), fallbackName)
    }

    private func beginDownloadStream(token: String) {
        downloadQueue.async { [weak self] in
            guard let self = self else { return }
            let tmpURL = FileManager.default.temporaryDirectory.appendingPathComponent("ps_dl_\(token).bin")
            FileManager.default.createFile(atPath: tmpURL.path, contents: nil)
            self.downloadStateLock.lock()
            self.stagedStreams[token] = tmpURL
            self.downloadStateLock.unlock()
        }
    }

    private func appendDownloadStream(token: String, base64: String) {
        downloadQueue.async { [weak self] in
            guard let self = self else { return }
            self.downloadStateLock.lock()
            let fileURL = self.stagedStreams[token]
            self.downloadStateLock.unlock()
            guard let url = fileURL,
                  let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
                  let fh = try? FileHandle(forWritingTo: url) else { return }
            defer { try? fh.close() }
            _ = try? fh.seekToEnd()
            fh.write(data)
        }
    }

    private func discardDownloadStream(token: String) {
        downloadQueue.async { [weak self] in
            guard let self = self else { return }
            self.downloadStateLock.lock()
            let url = self.stagedStreams.removeValue(forKey: token)
            self.downloadStateLock.unlock()
            if let url = url {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    private func isDownloadCancelled(sessionId: String, itemId: String) -> Bool {
        downloadStateLock.lock()
        let cancelled = cancelledDownloadSessions.contains(sessionId) || cancelledDownloadItems.contains(itemId)
        downloadStateLock.unlock()
        return cancelled
    }

    private func resolveBundleAssetURL(_ rawAssetPath: String) -> URL? {
        var rel = rawAssetPath
        if rel.hasPrefix("file:///android_asset/web/") {
            rel = String(rel.dropFirst("file:///android_asset/web/".count))
        } else if rel.hasPrefix("web/") {
            rel = String(rel.dropFirst("web/".count))
        }
        guard let root = Bundle.main.resourceURL else { return nil }
        let candidates = [
            root.appendingPathComponent("web").appendingPathComponent(rel),
            root.appendingPathComponent(rel)
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private func exportVideoWithEditsIfNeeded(from srcURL: URL, to dstURL: URL, videoEdit: [String: Any]) -> Bool {
        let trimStart = (videoEdit["trimStart"] as? NSNumber)?.doubleValue
        let trimEnd = (videoEdit["trimEnd"] as? NSNumber)?.doubleValue
        let mute = (videoEdit["mute"] as? Bool) ?? false
        let needsTrim = (trimStart != nil && trimStart! > 0.05) || (trimEnd != nil && trimEnd! > 0.05)
        guard needsTrim || mute else { return false }

        let asset = AVURLAsset(url: srcURL)
        let durSec = CMTimeGetSeconds(asset.duration)
        guard durSec.isFinite && durSec > 0 else { return false }

        let startSec = max(0, min(trimStart ?? 0, durSec - 0.05))
        let endSec = (trimEnd != nil && trimEnd! > startSec) ? min(trimEnd!, durSec) : durSec
        let timeRange = CMTimeRange(
            start: CMTime(seconds: startSec, preferredTimescale: 600),
            duration: CMTime(seconds: max(0.1, endSec - startSec), preferredTimescale: 600)
        )

        let composition = AVMutableComposition()
        do {
            if let vTrack = asset.tracks(withMediaType: .video).first,
               let compV = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) {
                try compV.insertTimeRange(timeRange, of: vTrack, at: .zero)
                compV.preferredTransform = vTrack.preferredTransform
            }
            if !mute,
               let aTrack = asset.tracks(withMediaType: .audio).first,
               let compA = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                try compA.insertTimeRange(timeRange, of: aTrack, at: .zero)
            }
        } catch {
            return false
        }

        let ext = dstURL.pathExtension.lowercased()
        let fileType: AVFileType = (ext == "mov") ? .mov : .mp4
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)
                ?? AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
            return false
        }
        exporter.outputURL = dstURL
        exporter.outputFileType = fileType
        exporter.shouldOptimizeForNetworkUse = true

        let sem = DispatchSemaphore(value: 0)
        exporter.exportAsynchronously { sem.signal() }
        _ = sem.wait(timeout: .now() + 180)
        return exporter.status == .completed && FileManager.default.fileExists(atPath: dstURL.path)
    }

    private func sendNativeChunkCallback(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.NativeDownloads && window.NativeDownloads.onChunk(\(json));", completionHandler: nil)
        }
    }

    private func executeDownloadChunk(payloadJson: String) {
        guard let data = payloadJson.data(using: .utf8),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let requestId = body["requestId"] as? String,
              let sessionId = body["sessionId"] as? String,
              let items = body["items"] as? [[String: Any]] else { return }

        downloadQueue.async { [weak self] in
            guard let self = self else { return }
            var results: [[String: Any]] = []
            var photosToMirror: [(url: URL, isVideo: Bool, albumName: String)] = []
            var totalExpectedBytes: Int64 = 0
            for item in items {
                totalExpectedBytes += (item["expectedSize"] as? NSNumber)?.int64Value ?? 0
            }
            var cumulativeWritten: Int64 = 0

            for item in items {
                let itemId = item["id"] as? String ?? UUID().uuidString
                if self.isDownloadCancelled(sessionId: sessionId, itemId: itemId) {
                    results.append(["id": itemId, "success": false, "cancelled": true])
                    continue
                }

                let rawFileName = item["fileName"] as? String ?? "PicShelf_media.jpg"
                let relativePath = item["relativePath"] as? String ?? "PicShelf/"
                let mime = item["mime"] as? String ?? "application/octet-stream"
                let source = item["source"] as? [String: Any] ?? [:]
                let videoEdit = item["videoEdit"] as? [String: Any]

                let destInfo = self.resolveExportDirectory(relativePath: relativePath)
                let unique = self.uniqueDestinationURL(in: destInfo.dirURL, fileName: rawFileName)
                let dstURL = unique.url

                var wroteSuccessfully = false
                var failureReason: String? = nil

                // Resolve input source file on disk (zero base64 overhead for native/asset sources!)
                var sourceFileURL: URL? = nil
                var shouldDeleteSourceTemp = false

                if let stagedToken = source["staged"] as? String {
                    self.downloadStateLock.lock()
                    sourceFileURL = self.stagedStreams[stagedToken]
                    self.downloadStateLock.unlock()
                } else if let assetPath = source["asset"] as? String {
                    sourceFileURL = self.resolveBundleAssetURL(assetPath)
                } else if let token = source["token"] as? String,
                          let kind = source["kind"] as? String,
                          let offset = (source["offset"] as? NSNumber)?.uint64Value,
                          let size = (source["size"] as? NSNumber)?.uint64Value {
                    let method = (source["method"] as? NSNumber)?.intValue ?? 0
                    let ext = (rawFileName as NSString).pathExtension.isEmpty ? "bin" : (rawFileName as NSString).pathExtension
                    if let extracted = PicShelfMediaStore.shared.extractEntryToTempFile(sourceId: token, kind: kind, offset: offset, size: size, method: method, ext: ext) {
                        sourceFileURL = extracted.url
                        shouldDeleteSourceTemp = extracted.isTemporary
                    }
                } else if let exported = source["exported"] as? [String: Any],
                          let uriStr = exported["uri"] as? String {
                    if let u = URL(string: uriStr), u.isFileURL, FileManager.default.fileExists(atPath: u.path) {
                        sourceFileURL = u
                    } else if FileManager.default.fileExists(atPath: uriStr) {
                        sourceFileURL = URL(fileURLWithPath: uriStr)
                    }
                }

                defer {
                    if shouldDeleteSourceTemp, let tmp = sourceFileURL {
                        try? FileManager.default.removeItem(at: tmp)
                    }
                }

                if let srcURL = sourceFileURL, FileManager.default.fileExists(atPath: srcURL.path) {
                    if mime.hasPrefix("video/"), let edit = videoEdit, !edit.isEmpty {
                        if self.exportVideoWithEditsIfNeeded(from: srcURL, to: dstURL, videoEdit: edit) {
                            wroteSuccessfully = true
                        }
                    }
                    if !wroteSuccessfully {
                        do {
                            if FileManager.default.fileExists(atPath: dstURL.path) {
                                try FileManager.default.removeItem(at: dstURL)
                            }
                            try FileManager.default.copyItem(at: srcURL, to: dstURL)
                            wroteSuccessfully = true
                        } catch {
                            failureReason = error.localizedDescription
                        }
                    }
                } else {
                    failureReason = "Source media unavailable"
                }

                if wroteSuccessfully,
                   let attrs = try? FileManager.default.attributesOfItem(atPath: dstURL.path),
                   let writtenSize = (attrs[.size] as? NSNumber)?.int64Value,
                   writtenSize > 0 {
                    cumulativeWritten += writtenSize
                    let isVideo = mime.hasPrefix("video/")
                    let isImage = mime.hasPrefix("image/")
                    let extLower = dstURL.pathExtension.lowercased()
                    // Queue Apple Photos mirror for images & iOS-compatible videos (.mp4/.mov/.m4v)
                    if isImage || (isVideo && (extLower == "mp4" || extLower == "mov" || extLower == "m4v")) {
                        photosToMirror.append((url: dstURL, isVideo: isVideo, albumName: destInfo.albumTitle))
                    }
                    let itemRes: [String: Any] = [
                        "id": itemId,
                        "success": true,
                        "fileSize": writtenSize,
                        "dateModified": Int(Date().timeIntervalSince1970),
                        "fileName": unique.finalName,
                        "displayPath": destInfo.displayPath,
                        "uri": dstURL.absoluteString,
                        "mime": mime
                    ]
                    results.append(itemRes)
                    if items.count > 1 {
                        self.sendNativeChunkCallback([
                            "requestId": requestId,
                            "sessionId": sessionId,
                            "progress": true,
                            "results": [itemRes],
                            "bytesWritten": cumulativeWritten,
                            "totalBytes": max(totalExpectedBytes, cumulativeWritten)
                        ])
                    }
                } else {
                    try? FileManager.default.removeItem(at: dstURL)
                    results.append([
                        "id": itemId,
                        "success": false,
                        "error": failureReason ?? "Failed to write file"
                    ])
                }
            }

            // Deliver final verified chunk result immediately (superfast UI completion!)
            self.sendNativeChunkCallback([
                "requestId": requestId,
                "sessionId": sessionId,
                "results": results
            ])

            if results.contains(where: { ($0["success"] as? Bool) == true }) {
                DispatchQueue.main.async {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                }
            }

            // Mirror saved images/videos to Apple Photos Library silently in background (never blocks, never nags!)
            if !photosToMirror.isEmpty {
                self.mirrorSavedFilesToApplePhotosSilently(photosToMirror)
            }
        }
    }

    private func mirrorSavedFilesToApplePhotosSilently(_ entries: [(url: URL, isVideo: Bool, albumName: String)]) {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .authorized || status == .limited {
            performBatchedPhotosMirror(entries)
        } else if status == .notDetermined {
            let promptKey = "picshelf_ios_photos_prompted_v1"
            if !UserDefaults.standard.bool(forKey: promptKey) {
                UserDefaults.standard.set(true, forKey: promptKey)
                PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] newStatus in
                    if newStatus == .authorized || newStatus == .limited {
                        self?.performBatchedPhotosMirror(entries)
                    }
                }
            }
        }
        // If .denied or .restricted: NEVER show a blocking popup! Files are already saved in Files › On My iPhone › PicShelf.
    }

    private func performBatchedPhotosMirror(_ entries: [(url: URL, isVideo: Bool, albumName: String)]) {
        photosMirrorQueue.async { [weak self] in
            guard let self = self else { return }
            var byAlbum: [String: [(url: URL, isVideo: Bool)]] = [:]
            for e in entries {
                let name = e.albumName.isEmpty ? "PicShelf" : e.albumName
                byAlbum[name, default: []].append((e.url, e.isVideo))
            }
            for (albumName, mediaList) in byAlbum {
                let sem = DispatchSemaphore(value: 0)
                self.findOrCreateAlbum(named: albumName) { collection in
                    PHPhotoLibrary.shared().performChanges({
                        var placeholders: [PHObjectPlaceholder] = []
                        for item in mediaList {
                            guard FileManager.default.fileExists(atPath: item.url.path) else { continue }
                            let req: PHAssetChangeRequest? = item.isVideo
                                ? PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: item.url)
                                : PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: item.url)
                            if let ph = req?.placeholderForCreatedAsset {
                                placeholders.append(ph)
                            }
                        }
                        if let collection = collection, !placeholders.isEmpty,
                           let albumReq = PHAssetCollectionChangeRequest(for: collection) {
                            albumReq.addAssets(placeholders as NSArray)
                        }
                    }) { _, _ in
                        sem.signal()
                    }
                }
                _ = sem.wait(timeout: .now() + 60)
            }
        }
    }

    // MARK: - Legacy Single Photo / Batch Fallbacks (also save to Files › On My iPhone › PicShelf, never nag!)

    private func downloadPhoto(dataUrl: String, fileName: String) {
        guard let image = base64ToImage(dataUrl: dataUrl),
              let jpeg = image.jpegData(compressionQuality: 0.92) else { return }

        downloadQueue.async { [weak self] in
            guard let self = self else { return }
            let dest = self.resolveExportDirectory(relativePath: "PicShelf/")
            let unique = self.uniqueDestinationURL(in: dest.dirURL, fileName: fileName.isEmpty ? "PicShelf_photo.jpg" : fileName)
            do {
                try jpeg.write(to: unique.url, options: .atomic)
                self.mirrorSavedFilesToApplePhotosSilently([(url: unique.url, isVideo: false, albumName: "PicShelf")])
                DispatchQueue.main.async {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                }
                self.showWebToast("Saved to \(dest.displayPath)", durationMs: 3500)
            } catch {
                self.showWebToast("Save failed: \(error.localizedDescription)", durationMs: 4000)
            }
        }
    }

    private func findOrCreateAlbum(named albumName: String, completion: @escaping (PHAssetCollection?) -> Void) {
        let fetchOptions = PHFetchOptions()
        fetchOptions.predicate = NSPredicate(format: "title = %@", albumName)
        let collections = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: fetchOptions)

        if let existing = collections.firstObject {
            completion(existing)
            return
        }

        var placeholder: PHObjectPlaceholder?
        PHPhotoLibrary.shared().performChanges({
            let createAlbumRequest = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: albumName)
            placeholder = createAlbumRequest.placeholderForCreatedAssetCollection
        }) { success, _ in
            if success, let placeholder = placeholder {
                let fetchResult = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [placeholder.localIdentifier], options: nil)
                completion(fetchResult.firstObject)
            } else {
                completion(nil)
            }
        }
    }

    private func executeDownloadBatch(body: [String: Any]) {
        guard let sessionId = body["sessionId"] as? String,
              let items = body["items"] as? [[String: Any]] else { return }

        let generalAlbumName = body["albumName"] as? String

        downloadQueue.async { [weak self] in
            guard let self = self else { return }
            var successCount = 0
            var failedCount = 0
            let total = items.count
            var toMirror: [(url: URL, isVideo: Bool, albumName: String)] = []

            for (idx, item) in items.enumerated() {
                let assetId = item["assetId"] as? String ?? "asset_\(idx)"
                let dataUrl = item["dataUrl"] as? String ?? ""
                let fileName = (item["fileName"] as? String) ?? (item["displayName"] as? String) ?? "PicShelf_\(idx + 1).jpg"
                let relPath = (item["relativePath"] as? String) ?? (generalAlbumName != nil ? "PicShelf/\(generalAlbumName!)/" : "PicShelf/")
                let dest = self.resolveExportDirectory(relativePath: relPath)
                let unique = self.uniqueDestinationURL(in: dest.dirURL, fileName: fileName)

                if let image = self.base64ToImage(dataUrl: dataUrl),
                   let jpeg = image.jpegData(compressionQuality: 0.92),
                   (try? jpeg.write(to: unique.url, options: .atomic)) != nil {
                    successCount += 1
                    toMirror.append((url: unique.url, isVideo: false, albumName: dest.albumTitle))
                    DispatchQueue.main.async {
                        self.webView?.evaluateJavaScript("window.DownloadManager && window.DownloadManager.onNativeItemProgress('\(sessionId)', '\(assetId)', true, null, \(idx + 1), \(total));", completionHandler: nil)
                    }
                } else {
                    failedCount += 1
                    DispatchQueue.main.async {
                        self.webView?.evaluateJavaScript("window.DownloadManager && window.DownloadManager.onNativeItemProgress('\(sessionId)', '\(assetId)', false, 'Invalid image data', \(idx + 1), \(total));", completionHandler: nil)
                    }
                }
            }

            DispatchQueue.main.async {
                self.webView?.evaluateJavaScript("window.DownloadManager && window.DownloadManager.onNativeSessionFinished('\(sessionId)', \(successCount), \(failedCount));", completionHandler: nil)
                if successCount > 0 {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                }
            }

            if !toMirror.isEmpty {
                self.mirrorSavedFilesToApplePhotosSilently(toMirror)
            }
        }
    }

    // MARK: - Save / Export ZIP Archive

    private func downloadZip(base64ZipData: String, zipFileName: String) {
        let cleanBase64 = base64ZipData.contains("base64,") ?
            String(base64ZipData.split(separator: ",")[1]) : base64ZipData

        guard let zipData = Data(base64Encoded: cleanBase64, options: .ignoreUnknownCharacters) else { return }

        let tempDir = FileManager.default.temporaryDirectory
        let safeName = zipFileName.replacingOccurrences(of: "/", with: "_")
        let fileURL = tempDir.appendingPathComponent(safeName)

        do {
            try zipData.write(to: fileURL)
            let activityVC = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
            if let popover = activityVC.popoverPresentationController {
                popover.sourceView = viewController?.view
                popover.sourceRect = CGRect(x: UIScreen.main.bounds.midX, y: UIScreen.main.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            viewController?.present(activityVC, animated: true)
        } catch {
            showAlert(title: "ZIP Export Error", message: error.localizedDescription)
        }
    }

    // MARK: - Location

    private func getCurrentLocation(callbackId: String) {
        pendingLocationCallbackId = callbackId
        locationManager.requestWhenInUseAuthorization()
        locationManager.startUpdatingLocation()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        lastKnownLocation = loc
        locationManager.stopUpdatingLocation()

        guard let callbackId = pendingLocationCallbackId else { return }
        pendingLocationCallbackId = nil

        let lat = loc.coordinate.latitude
        let lon = loc.coordinate.longitude
        let geocoder = CLGeocoder()

        geocoder.reverseGeocodeLocation(loc) { [weak self] placemarks, _ in
            guard let self = self else { return }
            var place = ""
            var city = ""
            var country = ""

            if let p = placemarks?.first {
                place = p.subLocality ?? p.name ?? ""
                city = p.locality ?? p.administrativeArea ?? ""
                country = p.country ?? ""
            }

            let displayCoords = String(
                format: "%.4f° %@, %.4f° %@",
                abs(lat), lat >= 0 ? "N" : "S",
                abs(lon), lon >= 0 ? "E" : "W"
            )

            let locObj: [String: Any] = [
                "latitude": lat,
                "longitude": lon,
                "displayCoords": displayCoords,
                "place": place,
                "city": city,
                "country": country
            ]

            if let data = try? JSONSerialization.data(withJSONObject: locObj),
               let jsonStr = String(data: data, encoding: .utf8) {
                let js = "if (window.onNativeLocationReceived) { window.onNativeLocationReceived('\(callbackId)', \(jsonStr)); }"
                self.webView?.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }

    // MARK: - Helpers

    private func triggerHaptic(type: String) {
        switch type {
        case "heavy":
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case "medium":
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "success":
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "error":
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        default:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }

    private func showAlert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        viewController?.present(alert, animated: true)
    }

    private func normalizeOrientation(_ image: UIImage) -> UIImage {
        if image.imageOrientation == .up { return image }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = image.scale
        let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }

    private func base64ToImage(dataUrl: String) -> UIImage? {
        let clean = dataUrl.contains("base64,") ?
            String(dataUrl.split(separator: ",")[1]) : dataUrl
        guard let data = Data(base64Encoded: clean, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }
}
