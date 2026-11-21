import Foundation
import UIKit
import WebKit
import Vision
import ImageIO

/// Fast, 100% offline Apple Vision facial landmark detector for Selfie Beauty & Skin Retouch.
/// Uses Apple's built-in `VNDetectFaceLandmarksRequest` (zero extra IPA size, ~8ms on Neural Engine).
/// Returns normalized top-left (0..1) polygons matching Android's `FaceRetouchDetector.kt` 1:1.
final class PicShelfFaceRetouchDetector {
    static let shared = PicShelfFaceRetouchDetector()
    weak var webView: WKWebView?

    private let workerQueue = DispatchQueue(label: "com.picshelf.ios.face.retouch", qos: .userInitiated)
    private init() {}

    func detect(requestId: String, imageBase64: String) {
        workerQueue.async { [weak self] in
            self?.runDetect(requestId: requestId, imageBase64: imageBase64)
        }
    }

    private func runDetect(requestId: String, imageBase64: String) {
        let pure = imageBase64.range(of: "base64,").map { String(imageBase64[$0.upperBound...]) } ?? imageBase64
        guard let data = Data(base64Encoded: pure, options: .ignoreUnknownCharacters),
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            send(requestId: requestId, payload: ["faces": [], "error": "Could not decode image"])
            return
        }

        let request = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
        do {
            try handler.perform([request])
            let observations = request.results ?? []
            var facesOut: [[String: Any]] = []
            for obs in observations {
                facesOut.append(serializeObservation(obs))
            }
            send(requestId: requestId, payload: ["faces": facesOut])
        } catch {
            send(requestId: requestId, payload: ["faces": [], "error": error.localizedDescription])
        }
    }

    /// Converts Vision normalized points (origin bottom-left within face boundingBox)
    /// into image top-left normalized (0..1) coordinates matching HTML5 Canvas & Android ML Kit.
    private func regionPoints(_ region: VNFaceLandmarkRegion2D?, box: CGRect) -> [[Double]] {
        guard let r = region else { return [] }
        let pts = r.normalizedPoints
        var out: [[Double]] = []
        out.reserveCapacity(pts.count)
        for p in pts {
            let ix = Double(box.origin.x + p.x * box.size.width)
            let iy = Double(1.0 - (box.origin.y + p.y * box.size.height))
            out.append([min(1.0, max(0.0, ix)), min(1.0, max(0.0, iy))])
        }
        return out
    }

    private func centroid(_ pts: [[Double]]) -> [Double]? {
        guard !pts.isEmpty else { return nil }
        var sx = 0.0, sy = 0.0
        for p in pts { sx += p[0]; sy += p[1] }
        return [sx / Double(pts.count), sy / Double(pts.count)]
    }

    private func serializeObservation(_ obs: VNFaceObservation) -> [String: Any] {
        let box = obs.boundingBox
        let bx = Double(box.origin.x)
        let by = Double(1.0 - (box.origin.y + box.size.height))
        let bw = Double(box.size.width)
        let bh = Double(box.size.height)

        var dict: [String: Any] = [
            "bounds": ["x": max(0.0, bx), "y": max(0.0, by), "w": max(0.01, bw), "h": max(0.01, bh)]
        ]
        guard let lm = obs.landmarks else { return dict }

        // Build closed face contour (Vision faceContour is jawline + smooth forehead arc)
        var facePoly = regionPoints(lm.faceContour, box: box)
        if facePoly.count >= 2 {
            let topY = max(0.0, by - bh * 0.14)
            let leftToRight = (facePoly.first![0] <= facePoly.last![0])
            let forehead: [[Double]] = leftToRight ? [
                [min(1.0, bx + bw * 0.85), by + bh * 0.08],
                [min(1.0, bx + bw * 0.65), topY],
                [max(0.0, bx + bw * 0.35), topY],
                [max(0.0, bx + bw * 0.15), by + bh * 0.08]
            ] : [
                [max(0.0, bx + bw * 0.15), by + bh * 0.08],
                [max(0.0, bx + bw * 0.35), topY],
                [min(1.0, bx + bw * 0.65), topY],
                [min(1.0, bx + bw * 0.85), by + bh * 0.08]
            ]
            facePoly.append(contentsOf: forehead)
        }

        let leftEye = regionPoints(lm.leftEye, box: box)
        let rightEye = regionPoints(lm.rightEye, box: box)
        let leftBrow = regionPoints(lm.leftEyebrow, box: box)
        let rightBrow = regionPoints(lm.rightEyebrow, box: box)
        let outerLips = regionPoints(lm.outerLips, box: box)
        let innerLips = regionPoints(lm.innerLips, box: box)
        let noseBridge = regionPoints(lm.noseCrest, box: box)
        let noseBottom = regionPoints(lm.nose, box: box)

        dict["faceContour"] = facePoly
        dict["leftEye"] = leftEye
        dict["rightEye"] = rightEye
        dict["leftEyebrow"] = leftBrow
        dict["rightEyebrow"] = rightBrow
        dict["outerLips"] = outerLips
        dict["innerLips"] = innerLips
        dict["noseBridge"] = noseBridge
        dict["noseBottom"] = noseBottom

        // Estimate accurate cheekbone centers directly below eye outer/mid + aligned with nose base
        if let le = centroid(leftEye), let re = centroid(rightEye) {
            let noseY = centroid(noseBottom)?[1] ?? (by + bh * 0.60)
            let cheekY = (le[1] + noseY) * 0.5 + bh * 0.04
            dict["leftCheek"] = [max(0.0, le[0] - bw * 0.05), min(1.0, cheekY)]
            dict["rightCheek"] = [min(1.0, re[0] + bw * 0.05), min(1.0, cheekY)]
        }
        return dict
    }

    private func send(requestId: String, payload: [String: Any]) {
        var obj = payload
        obj["id"] = requestId
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(
                "window.PicShelfCreativeStudio && window.PicShelfCreativeStudio.onFaceLandmarks && window.PicShelfCreativeStudio.onFaceLandmarks(\(json));",
                completionHandler: nil
            )
        }
    }
}
