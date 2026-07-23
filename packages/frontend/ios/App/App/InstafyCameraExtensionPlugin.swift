import Foundation
import Capacitor
import AVFoundation
import UIKit

@objc(InstafyCameraExtensionPlugin)
public class InstafyCameraExtensionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "InstafyCameraExtensionPlugin"
    public let jsName = "InstafyCameraExtension"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestCameraPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openCameraSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capturePhoto", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCaptureCall: CAPPluginCall?
    private var captureViewController: InstafyCameraCaptureViewController?
    private var selectedLensId = "rear"
    private var lastCapturePayload: JSObject?

    private func isSimulatorEnvironment() -> Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(buildStatusPayload())
    }

    @objc func requestCameraPermissions(_ call: CAPPluginCall) {
        if isSimulatorEnvironment() {
            call.resolve(buildStatusPayload())
            return
        }
        let currentStatus = authorizationStatus()
        NSLog("INSTAFY_IOS_CAMERA_PERMISSION_REQUEST start status=%@", permissionLabel())
        switch currentStatus {
        case .notDetermined:
            DispatchQueue.main.async {
                AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                    DispatchQueue.main.async {
                        guard let self else {
                            NSLog("INSTAFY_IOS_CAMERA_PERMISSION_REQUEST completion without plugin instance granted=%@", granted ? "true" : "false")
                            call.resolve([:])
                            return
                        }
                        NSLog(
                            "INSTAFY_IOS_CAMERA_PERMISSION_REQUEST completion granted=%@ status=%@",
                            granted ? "true" : "false",
                            self.permissionLabel(),
                        )
                        call.resolve(self.buildStatusPayload())
                    }
                }
            }
        default:
            NSLog("INSTAFY_IOS_CAMERA_PERMISSION_REQUEST skip status=%@", permissionLabel())
            call.resolve(buildStatusPayload())
        }
    }

    @objc func openCameraSettings(_ call: CAPPluginCall) {
        if isSimulatorEnvironment() {
            call.resolve(buildStatusPayload())
            return
        }
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            call.reject("Camera settings are unavailable on this iPhone.")
            return
        }

        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { _ in
                call.resolve(self.buildStatusPayload())
            }
        }
    }

    @objc func capturePhoto(_ call: CAPPluginCall) {
        guard pendingCaptureCall == nil else {
            call.reject("A camera capture is already in progress.")
            return
        }
        let lensId = normalizeLensId(call.getString("lens"))
        selectedLensId = lensId

        if isSimulatorEnvironment() {
            pendingCaptureCall = retain(call)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                self.completeSimulatorCapture(lensId: lensId)
            }
            return
        }

        guard cameraSupported() else {
            call.reject("This device does not report an available camera.")
            return
        }
        guard authorizationStatus() == .authorized else {
            call.reject("Camera permission is not granted yet.")
            return
        }
        guard let viewController = bridge?.viewController else {
            call.reject("Camera capture is unavailable because the bridge view controller is missing.")
            return
        }

        pendingCaptureCall = retain(call)
        let controller = InstafyCameraCaptureViewController()
        controller.modalPresentationStyle = .fullScreen
        controller.initialLensId = lensId
        controller.onCancel = { [weak self] message in
            guard let self else {
                return
            }
            let call = self.pendingCaptureCall
            self.pendingCaptureCall = nil
            self.captureViewController = nil
            self.resolve(
                call,
                payload: self.buildCapturePayload(
                    capture: nil,
                    cancelled: true,
                    error: message ?? "Camera capture was cancelled."
                )
            )
        }
        controller.onCapture = { [weak self] image, data, capturedLensId in
            self?.completeNativeCapture(image: image, data: data, lensId: capturedLensId)
        }
        captureViewController = controller
        DispatchQueue.main.async {
            viewController.present(controller, animated: true)
        }
    }

    private func completeNativeCapture(image: UIImage, data: Data, lensId: String) {
        let call = pendingCaptureCall
        do {
            let outputUrl = try createCaptureOutputUrl(lensId: lensId)
            try data.write(to: outputUrl, options: .atomic)
            let capturePayload = buildCapturePayload(
                outputUrl: outputUrl,
                image: image,
                data: data,
                lensId: lensId
            )
            lastCapturePayload = capturePayload
            selectedLensId = lensId
            pendingCaptureCall = nil
            captureViewController = nil
            resolve(
                call,
                payload: buildCapturePayload(capture: capturePayload, cancelled: false, error: nil)
            )
        } catch {
            pendingCaptureCall = nil
            captureViewController = nil
            reject(call, message: error.localizedDescription)
        }
    }

    private func authorizationStatus() -> AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .video)
    }

    private func cameraPermissionGranted() -> Bool {
        isSimulatorEnvironment() || authorizationStatus() == .authorized
    }

    private func cameraSupported() -> Bool {
        isSimulatorEnvironment() || availableCaptureDevices().isEmpty == false
    }

    private func permissionLabel() -> String {
        if isSimulatorEnvironment() {
            return "granted"
        }
        switch authorizationStatus() {
        case .authorized:
            return "granted"
        case .notDetermined:
            return "prompt"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        @unknown default:
            return "denied"
        }
    }

    private func normalizeLensId(_ value: String?) -> String {
        guard let value else {
            return selectedLensId
        }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized == "front" || normalized == "external" {
            return normalized
        }
        return "rear"
    }

    private func resolveDeviceId() -> String {
        if let identifier = UIDevice.current.identifierForVendor?.uuidString
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
           !identifier.isEmpty {
            return identifier
        }
        return "ios-device"
    }

    private func resolveDeviceLabel() -> String {
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty {
            return name
        }
        let model = UIDevice.current.model.trimmingCharacters(in: .whitespacesAndNewlines)
        if !model.isEmpty {
            return model
        }
        return "iPhone"
    }

    private func resolveProviderId() -> String {
        "camera:\(resolveDeviceId())"
    }

    private func buildAvailableLenses() -> JSArray {
        if isSimulatorEnvironment() {
            return [
                [
                    "id": "rear",
                    "title": "Rear camera",
                    "available": true,
                    "selected": selectedLensId == "rear"
                ],
                [
                    "id": "front",
                    "title": "Front camera",
                    "available": true,
                    "selected": selectedLensId == "front"
                ]
            ]
        }
        var lenses: JSArray = []
        if hasCaptureDevice(position: .back) {
            lenses.append([
                "id": "rear",
                "title": "Rear camera",
                "available": true,
                "selected": selectedLensId == "rear"
            ])
        }
        if hasCaptureDevice(position: .front) {
            lenses.append([
                "id": "front",
                "title": "Front camera",
                "available": true,
                "selected": selectedLensId == "front"
            ])
        }
        return lenses
    }

    private func availableCaptureDevices() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [
                .builtInWideAngleCamera,
                .builtInDualCamera,
                .builtInDualWideCamera,
                .builtInTripleCamera,
                .builtInUltraWideCamera,
                .builtInTrueDepthCamera
            ],
            mediaType: .video,
            position: .unspecified
        ).devices
    }

    private func hasCaptureDevice(position: AVCaptureDevice.Position) -> Bool {
        availableCaptureDevices().contains(where: { $0.position == position })
    }

    @discardableResult
    private func retain(_ call: CAPPluginCall) -> CAPPluginCall {
        bridge?.saveCall(call)
        return call
    }

    private func resolve(_ call: CAPPluginCall?, payload: JSObject) {
        guard let call else {
            return
        }
        call.resolve(payload)
        bridge?.releaseCall(call)
    }

    private func reject(_ call: CAPPluginCall?, message: String) {
        guard let call else {
            return
        }
        call.reject(message)
        bridge?.releaseCall(call)
    }

    private func buildStatusPayload(error: String? = nil) -> JSObject {
        var payload: JSObject = [
            "supported": cameraSupported(),
            "platform": "ios",
            "backend": "phone_camera",
            "deviceId": resolveDeviceId(),
            "deviceLabel": resolveDeviceLabel(),
            "providerId": resolveProviderId(),
            "permission": permissionLabel(),
            "permissionGranted": cameraPermissionGranted(),
            "canCapture": cameraSupported() && cameraPermissionGranted(),
            "availableLenses": buildAvailableLenses(),
            "selectedLens": selectedLensId,
            "lastCapture": lastCapturePayload ?? NSNull()
        ]
        if let error, !error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            payload["error"] = error.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return payload
    }

    private func buildCapturePayload(
        capture: JSObject?,
        cancelled: Bool,
        error: String?
    ) -> JSObject {
        var payload = buildStatusPayload(error: error)
        payload["cancelled"] = cancelled
        payload["capture"] = capture ?? NSNull()
        return payload
    }

    private func createCaptureOutputUrl(lensId: String) throws -> URL {
        let baseUrl = FileManager.default.temporaryDirectory.appendingPathComponent("instafy-camera", isDirectory: true)
        try FileManager.default.createDirectory(at: baseUrl, withIntermediateDirectories: true)
        let fileName = "camera-\(lensId)-\(Int(Date().timeIntervalSince1970 * 1000)).jpg"
        return baseUrl.appendingPathComponent(fileName)
    }

    private func completeSimulatorCapture(lensId: String) {
        let call = pendingCaptureCall
        do {
            let image = createSimulatorCaptureImage(lensId: lensId)
            guard let jpegData = image.jpegData(compressionQuality: 0.92) else {
                pendingCaptureCall = nil
                reject(call, message: "Failed to encode the simulator capture.")
                return
            }
            let outputUrl = try createCaptureOutputUrl(lensId: lensId)
            try jpegData.write(to: outputUrl, options: .atomic)
            let capturePayload = buildCapturePayload(
                outputUrl: outputUrl,
                image: image,
                data: jpegData,
                lensId: lensId
            )
            lastCapturePayload = capturePayload
            pendingCaptureCall = nil
            resolve(
                call,
                payload: buildCapturePayload(capture: capturePayload, cancelled: false, error: nil)
            )
        } catch {
            pendingCaptureCall = nil
            reject(call, message: error.localizedDescription)
        }
    }

    private func createSimulatorCaptureImage(lensId: String) -> UIImage {
        let size = CGSize(width: 1536, height: 1152)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let title = lensId == "front" ? "Front Camera" : "Rear Camera"
        let subtitle = ISO8601DateFormatter().string(from: Date())

        return renderer.image { context in
            let backgroundColor =
                lensId == "front"
                ? UIColor(red: 0.17, green: 0.33, blue: 0.73, alpha: 1)
                : UIColor(red: 0.12, green: 0.58, blue: 0.42, alpha: 1)
            backgroundColor.setFill()
            context.fill(CGRect(origin: .zero, size: size))

            let cardRect = CGRect(x: 112, y: 112, width: size.width - 224, height: size.height - 224)
            UIColor(white: 1, alpha: 0.14).setFill()
            UIBezierPath(roundedRect: cardRect, cornerRadius: 52).fill()

            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .left

            let titleAttributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 102, weight: .bold),
                .foregroundColor: UIColor.white,
                .paragraphStyle: paragraph
            ]
            let subtitleAttributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 48, weight: .medium),
                .foregroundColor: UIColor(white: 1, alpha: 0.92),
                .paragraphStyle: paragraph
            ]
            let footerAttributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.monospacedSystemFont(ofSize: 34, weight: .regular),
                .foregroundColor: UIColor(white: 1, alpha: 0.78),
                .paragraphStyle: paragraph
            ]

            NSString(string: "Instafy Camera").draw(
                in: CGRect(x: 176, y: 190, width: size.width - 352, height: 140),
                withAttributes: titleAttributes
            )
            NSString(string: title).draw(
                in: CGRect(x: 176, y: 410, width: size.width - 352, height: 80),
                withAttributes: subtitleAttributes
            )
            NSString(string: "Simulator capture · \(subtitle)").draw(
                in: CGRect(x: 176, y: 840, width: size.width - 352, height: 60),
                withAttributes: footerAttributes
            )
        }
    }

    private func buildCapturePayload(
        outputUrl: URL,
        image: UIImage,
        data: Data,
        lensId: String
    ) -> JSObject {
        [
            "captureId": "camera-\(Int(Date().timeIntervalSince1970 * 1000))",
            "backend": "phone_camera",
            "lens": lensId,
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "fileName": outputUrl.lastPathComponent,
            "filePath": outputUrl.path,
            "webPath": outputUrl.absoluteString,
            "mimeType": "image/jpeg",
            "format": "jpeg",
            "width": Int(image.size.width),
            "height": Int(image.size.height),
            "sizeBytes": data.count
        ]
    }
}

final class InstafyCameraCaptureViewController: UIViewController, AVCapturePhotoCaptureDelegate {
    var initialLensId = "rear"
    var onCancel: ((String?) -> Void)?
    var onCapture: ((UIImage, Data, String) -> Void)?

    private let captureSession = AVCaptureSession()
    private let captureQueue = DispatchQueue(label: "dev.instafy.camera.capture")
    private let photoOutput = AVCapturePhotoOutput()
    private let previewView = UIView()
    private let closeButton = UIButton(type: .system)
    private let switchButton = UIButton(type: .system)
    private let shutterButton = UIButton(type: .system)
    private let lensLabel = UILabel()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var currentInput: AVCaptureDeviceInput?
    private var currentLensId = "rear"

    override func viewDidLoad() {
        super.viewDidLoad()
        currentLensId = normalizeLensId(initialLensId)
        configureUi()
        configureSession(for: currentLensId)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        captureQueue.async {
            if !self.captureSession.isRunning {
                self.captureSession.startRunning()
            }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        captureQueue.async {
            if self.captureSession.isRunning {
                self.captureSession.stopRunning()
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = previewView.bounds
    }

    private func configureUi() {
        view.backgroundColor = .black

        previewView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(previewView)

        let topBar = UIStackView(arrangedSubviews: [closeButton, lensLabel, switchButton])
        topBar.axis = .horizontal
        topBar.alignment = .center
        topBar.spacing = 12
        topBar.translatesAutoresizingMaskIntoConstraints = false
        topBar.backgroundColor = UIColor(white: 0, alpha: 0.42)
        topBar.isLayoutMarginsRelativeArrangement = true
        topBar.layoutMargins = UIEdgeInsets(top: 12, left: 16, bottom: 12, right: 16)
        topBar.layer.cornerRadius = 20

        let bottomBar = UIStackView(arrangedSubviews: [shutterButton])
        bottomBar.axis = .vertical
        bottomBar.alignment = .center
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.backgroundColor = UIColor(white: 0, alpha: 0.42)
        bottomBar.isLayoutMarginsRelativeArrangement = true
        bottomBar.layoutMargins = UIEdgeInsets(top: 16, left: 24, bottom: 20, right: 24)
        bottomBar.layer.cornerRadius = 28

        closeButton.setTitle("Close", for: .normal)
        closeButton.tintColor = .white
        closeButton.accessibilityLabel = "Instafy camera close"
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)

        switchButton.setTitle("Flip", for: .normal)
        switchButton.tintColor = .white
        switchButton.accessibilityLabel = "Instafy camera flip"
        switchButton.addTarget(self, action: #selector(switchTapped), for: .touchUpInside)

        lensLabel.textColor = .white
        lensLabel.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
        lensLabel.textAlignment = .center

        var config = UIButton.Configuration.filled()
        config.title = "Capture"
        config.baseBackgroundColor = .white
        config.baseForegroundColor = .black
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 24, bottom: 12, trailing: 24)
        shutterButton.configuration = config
        shutterButton.accessibilityLabel = "Instafy camera shutter"
        shutterButton.isEnabled = false
        shutterButton.addTarget(self, action: #selector(shutterTapped), for: .touchUpInside)

        view.addSubview(topBar)
        view.addSubview(bottomBar)

        NSLayoutConstraint.activate([
            previewView.topAnchor.constraint(equalTo: view.topAnchor),
            previewView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            previewView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            previewView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            topBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),

            bottomBar.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            bottomBar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])

        lensLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        closeButton.setContentHuggingPriority(.required, for: .horizontal)
        switchButton.setContentHuggingPriority(.required, for: .horizontal)

        let previewLayer = AVCaptureVideoPreviewLayer(session: captureSession)
        previewLayer.videoGravity = .resizeAspectFill
        previewView.layer.addSublayer(previewLayer)
        self.previewLayer = previewLayer
    }

    private func configureSession(for lensId: String) {
        captureQueue.async {
            guard let device = self.resolveDevice(for: lensId) else {
                DispatchQueue.main.async {
                    self.dismiss(animated: true) {
                        self.onCancel?("This iPhone does not report the requested camera.")
                    }
                }
                return
            }

            do {
                let input = try AVCaptureDeviceInput(device: device)
                self.captureSession.beginConfiguration()
                self.captureSession.sessionPreset = .photo
                if let currentInput = self.currentInput {
                    self.captureSession.removeInput(currentInput)
                }
                if self.captureSession.outputs.contains(self.photoOutput) == false,
                   self.captureSession.canAddOutput(self.photoOutput) {
                    self.captureSession.addOutput(self.photoOutput)
                }
                guard self.captureSession.canAddInput(input) else {
                    self.captureSession.commitConfiguration()
                    DispatchQueue.main.async {
                        self.dismiss(animated: true) {
                            self.onCancel?("Unable to start the camera preview on this iPhone.")
                        }
                    }
                    return
                }
                self.captureSession.addInput(input)
                self.currentInput = input
                self.currentLensId = device.position == .front ? "front" : "rear"
                self.captureSession.commitConfiguration()

                if !self.captureSession.isRunning {
                    self.captureSession.startRunning()
                }

                DispatchQueue.main.async {
                    self.updateLensUi()
                    self.shutterButton.isEnabled = true
                }
            } catch {
                DispatchQueue.main.async {
                    self.dismiss(animated: true) {
                        self.onCancel?(error.localizedDescription)
                    }
                }
            }
        }
    }

    private func resolveDevice(for lensId: String) -> AVCaptureDevice? {
        let preferredPosition: AVCaptureDevice.Position = lensId == "front" ? .front : .back
        let devices = AVCaptureDevice.DiscoverySession(
            deviceTypes: [
                .builtInWideAngleCamera,
                .builtInDualCamera,
                .builtInDualWideCamera,
                .builtInTripleCamera,
                .builtInUltraWideCamera,
                .builtInTrueDepthCamera
            ],
            mediaType: .video,
            position: .unspecified
        ).devices
        if let preferred = devices.first(where: { $0.position == preferredPosition }) {
            return preferred
        }
        return devices.first(where: { $0.position == .back }) ?? devices.first(where: { $0.position == .front })
    }

    private func updateLensUi() {
        lensLabel.text = currentLensId == "front" ? "Front camera" : "Rear camera"
        let hasFront = resolveDevice(for: "front") != nil
        let hasRear = resolveDevice(for: "rear") != nil
        switchButton.isHidden = !(hasFront && hasRear)
        switchButton.isEnabled = hasFront && hasRear
    }

    @objc private func closeTapped() {
        dismiss(animated: true) {
            self.onCancel?("Camera capture was cancelled.")
        }
    }

    @objc private func switchTapped() {
        let nextLensId = currentLensId == "front" ? "rear" : "front"
        shutterButton.isEnabled = false
        configureSession(for: nextLensId)
    }

    @objc private func shutterTapped() {
        shutterButton.isEnabled = false
        switchButton.isEnabled = false
        closeButton.isEnabled = false

        let settings = AVCapturePhotoSettings()
        settings.flashMode = .off
        photoOutput.capturePhoto(with: settings, delegate: self)
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        if let error {
            dismiss(animated: true) {
                self.onCancel?(error.localizedDescription)
            }
            return
        }
        guard let data = photo.fileDataRepresentation(),
              let image = UIImage(data: data) else {
            dismiss(animated: true) {
                self.onCancel?("The in-app camera could not encode the captured photo.")
            }
            return
        }

        dismiss(animated: true) {
            self.onCapture?(image, data, self.currentLensId)
        }
    }

    private func normalizeLensId(_ value: String?) -> String {
        guard let value else {
            return "rear"
        }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized == "front" {
            return normalized
        }
        return "rear"
    }
}
