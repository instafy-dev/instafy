import UIKit
import Capacitor
import CoreMotion
import WebKit
import AVFoundation
import Speech
import AVFAudio

private let nativeShakeEventName = "instafy:native-shake"
private let nativeVoiceInputEventName = "instafy:native-voice-input"
private let nativeVoiceInputBridgeName = "instafyVoiceInput"
private let nativeAudioSessionEventName = "instafy:native-audio-session"
private let nativeAudioSessionBridgeName = "instafyAudioSession"
private let nativeShakeDeltaThreshold = 0.9
private let nativeShakeWindow: TimeInterval = 0.6
private let nativeShakeRequiredPeaks = 2
private let nativeShakeCooldown: TimeInterval = 8.0
private let nativeShakeSampleInterval = 1.0 / 24.0
private let nativeUiTestSessionEnvironmentKey = "INSTAFY_UI_TEST_SESSION"
private let nativeOtaUiTestEnvironmentKey = "INSTAFY_UI_TEST_DISABLE_NATIVE_OTA"
private let nativeOtaUiTestJavascriptFlag = "__INSTAFY_UI_TEST_DISABLE_NATIVE_OTA__"

private func nativeOtaDisabledForUiTesting() -> Bool {
    #if DEBUG
    return ProcessInfo.processInfo.environment[nativeOtaUiTestEnvironmentKey] == "1"
    #else
    return false
    #endif
}

private func nativeUiTestSessionIsActive() -> Bool {
    #if DEBUG
    return ProcessInfo.processInfo.environment[nativeUiTestSessionEnvironmentKey] == "1"
    #else
    return false
    #endif
}

private func resetNativeOtaForUiTestingIfNeeded() {
    guard nativeOtaDisabledForUiTesting() else {
        return
    }

    // Capacitor consults this persisted path before the WebView (and therefore
    // the JavaScript OTA guard) exists. Reset it first so XCTest always starts
    // from the web bundle embedded by the current physical-device build.
    KeyValueStore.standard["serverBasePath"] = nil as String?

    guard let libraryDirectory = FileManager.default.urls(
        for: .libraryDirectory,
        in: .userDomainMask
    ).first else {
        return
    }
    let downloadedBundlesDirectory = libraryDirectory
        .appendingPathComponent("NoCloud", isDirectory: true)
        .appendingPathComponent("ionic_built_snapshots", isDirectory: true)
    try? FileManager.default.removeItem(at: downloadedBundlesDirectory)
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        resetNativeOtaForUiTestingIfNeeded()
        if nativeUiTestSessionIsActive() {
            // Keep an already-unlocked physical device awake while XCTest is
            // driving it. This cannot and must not bypass the device passcode.
            application.isIdleTimerDisabled = true
        }
        application.applicationSupportsShakeToEdit = false
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

class InstafyBridgeViewController: CAPBridgeViewController, WKScriptMessageHandler, WKUIDelegate {
    private let motionManager = CMMotionManager()
    private var audioEngine: AVAudioEngine?
    private var lastMagnitude: Double?
    private var firstPeakAt: TimeInterval?
    private var peakCount = 0
    private var lastTriggeredAt = TimeInterval.leastNormalMagnitude
    private var voiceBridgeInstalled = false
    private var audioSessionBridgeInstalled = false
    private var audioSessionObserversInstalled = false
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var voiceStopRequested = false
    private var voiceStartInFlight = false
    private var voiceStartBlockedUntil = Date.distantPast
    private var voiceAuthorizationRequestId = 0
    private var deferredVoiceCleanupWorkItem: DispatchWorkItem?
    private var audioSessionInterrupted = false
    private var audioSessionInterruptionReason: String?
    private var lastAudioRouteChangeReason: String?
    private var microphonePermissionOverride: String?

    override var canBecomeFirstResponder: Bool {
        true
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        if nativeOtaDisabledForUiTesting() {
            let script = WKUserScript(
                source: "window.\(nativeOtaUiTestJavascriptFlag) = true;",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            configuration.userContentController.addUserScript(script)
        }
        return configuration
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        bridge?.registerPluginInstance(InstafyCameraExtensionPlugin())
        bridge?.registerPluginInstance(InstafyLanDiscoveryBridgePlugin())
        bridge?.registerPluginInstance(InstafySpeechHttpBridgePlugin())
        bridge?.webView?.uiDelegate = self
        UIApplication.shared.applicationSupportsShakeToEdit = false
        installVoiceInputBridgeIfNeeded()
        installAudioSessionBridgeIfNeeded()
        startAudioSessionMonitoringIfNeeded()
        publishAudioSessionSnapshot(reason: "view_did_load")
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        becomeFirstResponder()
        startShakeMonitoringIfNeeded()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
        startShakeMonitoringIfNeeded()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        resignFirstResponder()
        stopShakeMonitoring()
        stopVoiceInputRecognition(clearTranscript: false)
        publishAudioSessionSnapshot(reason: "view_did_disappear")
    }

    deinit {
        if voiceBridgeInstalled {
            bridge?.webView?.configuration.userContentController.removeScriptMessageHandler(forName: nativeVoiceInputBridgeName)
        }
        if audioSessionBridgeInstalled {
            bridge?.webView?.configuration.userContentController.removeScriptMessageHandler(forName: nativeAudioSessionBridgeName)
        }
        stopAudioSessionMonitoring()
    }

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        super.motionEnded(motion, with: event)
        guard motion == .motionShake else {
            return
        }
        dispatchShakeEvent(source: "uikit")
    }

    private func startShakeMonitoringIfNeeded() {
        guard !motionManager.isAccelerometerActive else {
            return
        }
        guard motionManager.isAccelerometerAvailable else {
            print("Instafy shake bridge: accelerometer unavailable")
            publishShakeBridgeLog("Instafy shake bridge: accelerometer unavailable", severity: "warn")
            return
        }

        motionManager.accelerometerUpdateInterval = nativeShakeSampleInterval
        publishShakeBridgeLog("Instafy shake bridge: accelerometer monitoring started")
        motionManager.startAccelerometerUpdates(to: .main) { [weak self] data, error in
            guard let self else {
                return
            }
            if let error {
                print("Instafy shake bridge: accelerometer error \(error.localizedDescription)")
                self.publishShakeBridgeLog(
                    "Instafy shake bridge: accelerometer error \(error.localizedDescription)",
                    severity: "error"
                )
                return
            }
            guard let acceleration = data?.acceleration else {
                return
            }

            let magnitude = sqrt(
                acceleration.x * acceleration.x +
                acceleration.y * acceleration.y +
                acceleration.z * acceleration.z
            )
            let timestamp = Date().timeIntervalSince1970
            self.handleAccelerationSample(magnitude: magnitude, timestamp: timestamp)
        }
    }

    private func stopShakeMonitoring() {
        if motionManager.isAccelerometerActive {
            motionManager.stopAccelerometerUpdates()
        }
        lastMagnitude = nil
        firstPeakAt = nil
        peakCount = 0
    }

    private func handleAccelerationSample(magnitude: Double, timestamp: TimeInterval) {
        guard let previousMagnitude = lastMagnitude else {
            lastMagnitude = magnitude
            return
        }

        lastMagnitude = magnitude

        if timestamp - lastTriggeredAt < nativeShakeCooldown {
            return
        }

        let delta = abs(magnitude - previousMagnitude)
        if delta < nativeShakeDeltaThreshold {
            if let firstPeakAt, timestamp - firstPeakAt > nativeShakeWindow {
                self.firstPeakAt = nil
                peakCount = 0
            }
            return
        }

        let windowExpired = firstPeakAt == nil || timestamp - (firstPeakAt ?? 0) > nativeShakeWindow
        peakCount = windowExpired ? 1 : peakCount + 1
        if windowExpired {
            firstPeakAt = timestamp
        }

        guard peakCount >= nativeShakeRequiredPeaks else {
            return
        }

        lastTriggeredAt = timestamp
        firstPeakAt = nil
        peakCount = 0
        dispatchShakeEvent(source: "accelerometer")
    }

    private func dispatchShakeEvent(source: String) {
        print("Instafy shake bridge: dispatching native shake (\(source))")
        publishShakeBridgeLog("Instafy shake bridge: dispatching native shake (\(source))")
        bridge?.triggerWindowJSEvent(
            eventName: nativeShakeEventName,
            data: "{ \"source\": \"\(source)\" }"
        )
        let js = "window.dispatchEvent(new CustomEvent('\(nativeShakeEventName)', { detail: { source: '\(source)' } }));"
        bridge?.webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    private func installVoiceInputBridgeIfNeeded() {
        guard !voiceBridgeInstalled, let userContentController = bridge?.webView?.configuration.userContentController else {
            return
        }
        userContentController.add(self, name: nativeVoiceInputBridgeName)
        voiceBridgeInstalled = true
    }

    private func installAudioSessionBridgeIfNeeded() {
        guard !audioSessionBridgeInstalled, let userContentController = bridge?.webView?.configuration.userContentController else {
            return
        }
        userContentController.add(self, name: nativeAudioSessionBridgeName)
        audioSessionBridgeInstalled = true
    }

    private func startAudioSessionMonitoringIfNeeded() {
        guard !audioSessionObserversInstalled else {
            return
        }
        audioSessionObserversInstalled = true
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(handleAudioSessionRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleAudioSessionInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleApplicationStateNotification(_:)),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleApplicationStateNotification(_:)),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleApplicationStateNotification(_:)),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleApplicationStateNotification(_:)),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
    }

    private func stopAudioSessionMonitoring() {
        guard audioSessionObserversInstalled else {
            return
        }
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIApplication.willEnterForegroundNotification, object: nil)
        audioSessionObserversInstalled = false
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == nativeAudioSessionBridgeName {
            let body = message.body as? [String: Any]
            let type = body?["type"] as? String ?? "refresh"
            let requestId = body?["requestId"] as? String

            switch type {
            case "requestMicrophonePermission":
                requestNativeMicrophonePermission(requestId: requestId)
            default:
                publishAudioSessionSnapshot(reason: "refresh", requestId: requestId)
            }
            return
        }
        guard message.name == nativeVoiceInputBridgeName else {
            return
        }
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            return
        }

        switch type {
        case "start":
            startVoiceInputRecognition()
        case "stop":
            stopVoiceInputRecognition(clearTranscript: false)
        case "cancel":
            stopVoiceInputRecognition(clearTranscript: true)
        default:
            break
        }
    }

    private func requestNativeMicrophonePermission(requestId: String?) {
        requestRecordPermission { granted in
            DispatchQueue.main.async {
                self.microphonePermissionOverride = granted ? "granted" : "denied"
                self.publishAudioSessionSnapshot(
                    reason: "request_microphone_permission",
                    requestId: requestId
                )
                self.scheduleMicrophonePermissionFollowUpSnapshots()
            }
        }
    }

    @available(iOS 15.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        let originHost = origin.host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let currentHost = webView.url?.host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard !originHost.isEmpty, currentHost.isEmpty || originHost == currentHost else {
            decisionHandler(.deny)
            return
        }

        let finish: (Bool) -> Void = { granted in
            DispatchQueue.main.async {
                if type == .microphone || type == .cameraAndMicrophone {
                    self.microphonePermissionOverride = granted ? "granted" : "denied"
                }
                self.publishAudioSessionSnapshot(reason: "webview_media_capture_permission")
                if type == .microphone || type == .cameraAndMicrophone {
                    self.scheduleMicrophonePermissionFollowUpSnapshots()
                }
                decisionHandler(granted ? .grant : .deny)
            }
        }

        switch type {
        case .microphone:
            requestRecordPermission(completion: finish)
        case .camera:
            requestCameraPermission(completion: finish)
        case .cameraAndMicrophone:
            requestCameraPermission { cameraGranted in
                guard cameraGranted else {
                    finish(false)
                    return
                }
                self.requestRecordPermission(completion: finish)
            }
        @unknown default:
            decisionHandler(.prompt)
        }
    }

    private func startVoiceInputRecognition() {
        if voiceStartInFlight {
            return
        }
        if recognitionTask != nil || recognitionRequest != nil || audioEngine?.isRunning == true || deferredVoiceCleanupWorkItem != nil {
            setVoiceStartCooldown(0.9)
            publishVoiceInputError("Voice input is resetting. Try again in a moment.")
            return
        }
        if Date() < voiceStartBlockedUntil {
            publishVoiceInputError("Voice input is resetting. Try again in a moment.")
            return
        }
        voiceStartInFlight = true
        voiceAuthorizationRequestId += 1
        let authorizationRequestId = voiceAuthorizationRequestId
        voiceStopRequested = false
        requestVoiceInputAuthorization { [weak self] granted, errorMessage in
            guard let self else {
                return
            }
            let handleAuthorizationResult = {
                guard authorizationRequestId == self.voiceAuthorizationRequestId else {
                    self.voiceStartInFlight = false
                    return
                }
                if self.voiceStopRequested {
                    self.voiceStartInFlight = false
                    self.finishVoiceInputRecognition(
                        clearTranscript: false,
                        cancelTask: true,
                        publishStoppedState: false
                    )
                    return
                }
                guard granted else {
                    self.voiceStartInFlight = false
                    self.publishVoiceInputError(errorMessage ?? "Voice input permission was denied.")
                    return
                }
                self.beginVoiceInputRecognition()
            }

            if Thread.isMainThread {
                handleAuthorizationResult()
            } else {
                DispatchQueue.main.async(execute: handleAuthorizationResult)
            }
        }
    }

    private func requestVoiceInputAuthorization(completion: @escaping (Bool, String?) -> Void) {
        SFSpeechRecognizer.requestAuthorization { speechStatus in
            guard speechStatus == .authorized else {
                let message: String
                switch speechStatus {
                case .authorized:
                    message = "Speech recognition permission was not granted."
                case .denied:
                    message = "Speech recognition permission was denied."
                case .restricted:
                    message = "Speech recognition is restricted on this device."
                case .notDetermined:
                    message = "Speech recognition permission was not granted."
                @unknown default:
                    message = "Speech recognition is unavailable right now."
                }
                completion(false, message)
                return
            }

            self.requestRecordPermission { granted in
                completion(granted, granted ? nil : "Microphone permission was denied.")
            }
        }
    }

    private func beginVoiceInputRecognition() {
        defer {
            voiceStartInFlight = false
        }
        stopVoiceInputRecognition(clearTranscript: true, publishStoppedState: false, applyCooldown: false)
        voiceStopRequested = false
        deferredVoiceCleanupWorkItem?.cancel()
        deferredVoiceCleanupWorkItem = nil

        let locale = Locale.autoupdatingCurrent
        guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer() else {
            publishVoiceInputError("Voice input is unavailable for the current language.")
            return
        }

        guard recognizer.isAvailable else {
            publishVoiceInputError("Voice input is temporarily unavailable.")
            return
        }

        speechRecognizer = recognizer

        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            recognitionRequest = request

            let engine = AVAudioEngine()
            audioEngine = engine
            let inputNode = engine.inputNode
            let recordingFormat = inputNode.outputFormat(forBus: 0)
            inputNode.removeTap(onBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
                self?.recognitionRequest?.append(buffer)
            }

            engine.prepare()
            try engine.start()
            publishAudioSessionSnapshot(reason: "voice_input_started")
            publishVoiceInputState(listening: true)

            recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self else {
                    return
                }

                if let result {
                    let transcript = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                    let stillListening = !result.isFinal && !self.voiceStopRequested
                    self.publishVoiceInputTranscript(transcript, listening: stillListening)
                    if result.isFinal || self.voiceStopRequested {
                        self.finishVoiceInputRecognition(clearTranscript: false, cancelTask: false)
                    }
                    return
                }

                if let error {
                    if self.voiceStopRequested {
                        self.finishVoiceInputRecognition(clearTranscript: false, cancelTask: false)
                        return
                    }
                    let nsError = error as NSError
                    self.setVoiceStartCooldown(self.voiceRestartCooldown(for: nsError))
                    self.publishVoiceInputError("Voice input failed: \(error.localizedDescription)")
                    self.finishVoiceInputRecognition(clearTranscript: false, cancelTask: true)
                }
            }
        } catch {
            publishVoiceInputError("Unable to start voice input: \(error.localizedDescription)")
            finishVoiceInputRecognition(clearTranscript: true, cancelTask: true)
        }
    }

    private func stopVoiceInputRecognition(
        clearTranscript: Bool,
        publishStoppedState: Bool = true,
        applyCooldown: Bool = true
    ) {
        voiceStopRequested = true
        voiceStartInFlight = false
        voiceAuthorizationRequestId += 1
        deferredVoiceCleanupWorkItem?.cancel()
        deferredVoiceCleanupWorkItem = nil
        if applyCooldown {
            setVoiceStartCooldown(clearTranscript ? 0.25 : 0.35)
        }
        if let audioEngine, audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
        if publishStoppedState {
            publishVoiceInputState(listening: false)
        }
        if clearTranscript {
            finishVoiceInputRecognition(clearTranscript: true, cancelTask: true, publishStoppedState: false)
            return
        }
        recognitionRequest?.endAudio()
        let cleanupWorkItem = DispatchWorkItem { [weak self] in
            self?.finishVoiceInputRecognition(clearTranscript: false, cancelTask: true, publishStoppedState: false)
        }
        deferredVoiceCleanupWorkItem = cleanupWorkItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: cleanupWorkItem)
        publishAudioSessionSnapshot(reason: "voice_input_stop_requested")
    }

    private func finishVoiceInputRecognition(
        clearTranscript: Bool,
        cancelTask: Bool,
        publishStoppedState: Bool = true
    ) {
        deferredVoiceCleanupWorkItem?.cancel()
        deferredVoiceCleanupWorkItem = nil

        if let audioEngine, audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
        recognitionRequest?.endAudio()
        if cancelTask {
            recognitionTask?.cancel()
        }
        recognitionTask = nil
        recognitionRequest = nil
        speechRecognizer = nil

        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // Ignore audio session cleanup failures.
        }
        publishAudioSessionSnapshot(reason: "voice_input_finished")

        if publishStoppedState {
            publishVoiceInputState(listening: false)
        }
        if clearTranscript {
            publishVoiceInputTranscript("", listening: false)
        }
        voiceStopRequested = false
    }

    private func setVoiceStartCooldown(_ duration: TimeInterval) {
        guard duration > 0 else {
            return
        }
        let blockedUntil = Date().addingTimeInterval(duration)
        if blockedUntil > voiceStartBlockedUntil {
            voiceStartBlockedUntil = blockedUntil
        }
    }

    private func voiceRestartCooldown(for error: NSError) -> TimeInterval {
        if error.domain == "kAFAssistantErrorDomain" {
            switch error.code {
            case 1107:
                return 2.5
            case 1100:
                return 1.2
            case 1110:
                return 0.35
            default:
                break
            }
        }
        return 0.5
    }

    private func publishVoiceInputState(listening: Bool) {
        publishVoiceInputEvent([
            "type": "state",
            "listening": listening,
        ])
    }

    private func publishVoiceInputTranscript(_ transcript: String, listening: Bool) {
        publishVoiceInputEvent([
            "type": "transcript",
            "transcript": transcript,
            "listening": listening,
        ])
    }

    private func publishVoiceInputError(_ message: String) {
        publishVoiceInputEvent([
            "type": "error",
            "message": message,
        ])
    }

    private func publishVoiceInputEvent(_ payload: [String: Any]) {
        publishBridgeEvent(eventName: nativeVoiceInputEventName, payload: payload)
    }

    @objc private func handleAudioSessionRouteChange(_ notification: Notification) {
        if let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt {
            lastAudioRouteChangeReason = describeAudioSessionRouteChangeReason(rawReason)
        } else {
            lastAudioRouteChangeReason = "route changed"
        }
        publishAudioSessionSnapshot(reason: "route_change")
    }

    @objc private func handleAudioSessionInterruption(_ notification: Notification) {
        guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let interruptionType = AVAudioSession.InterruptionType(rawValue: rawType) else {
            audioSessionInterrupted = true
            audioSessionInterruptionReason = "audio interruption"
            publishAudioSessionSnapshot(reason: "interruption")
            return
        }

        switch interruptionType {
        case .began:
            audioSessionInterrupted = true
            audioSessionInterruptionReason = "system interruption began"
        case .ended:
            audioSessionInterrupted = false
            if let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt,
               AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume) {
                audioSessionInterruptionReason = "interruption ended and may resume"
            } else {
                audioSessionInterruptionReason = nil
            }
        @unknown default:
            audioSessionInterrupted = true
            audioSessionInterruptionReason = "audio interruption"
        }

        publishAudioSessionSnapshot(reason: "interruption")
    }

    @objc private func handleApplicationStateNotification(_ notification: Notification) {
        publishAudioSessionSnapshot(reason: "app_state")
    }

    private func publishAudioSessionSnapshot(reason: String, requestId: String? = nil) {
        var payload: [String: Any] = [
            "type": "status",
            "snapshot": createAudioSessionSnapshot(reason: reason),
        ]
        if let requestId {
            payload["requestId"] = requestId
        }
        publishAudioSessionEvent(payload)
    }

    private func publishAudioSessionEvent(_ payload: [String: Any]) {
        publishBridgeEvent(eventName: nativeAudioSessionEventName, payload: payload)
    }

    private func requestRecordPermission(completion: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: completion)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(completion)
        }
    }

    private func requestCameraPermission(completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            completion(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video, completionHandler: completion)
        case .denied, .restricted:
            completion(false)
        @unknown default:
            completion(false)
        }
    }

    private func scheduleMicrophonePermissionFollowUpSnapshots() {
        let delays: [TimeInterval] = [0.35, 1.0, 2.0]
        for delay in delays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.publishAudioSessionSnapshot(reason: "microphone_permission_follow_up")
            }
        }
    }

    private func currentRecordPermissionDescription() -> String {
        let resolvedPermission = resolveCurrentRecordPermissionDescription()
        if resolvedPermission == "granted" || resolvedPermission == "denied" {
            microphonePermissionOverride = nil
            return resolvedPermission
        }
        return microphonePermissionOverride ?? resolvedPermission
    }

    private func resolveCurrentRecordPermissionDescription() -> String {
        let legacyPermission = describeLegacyRecordPermission(AVAudioSession.sharedInstance().recordPermission)
        if #available(iOS 17.0, *) {
            let applicationPermission = describeRecordPermission(AVAudioApplication.shared.recordPermission)
            if applicationPermission == "granted" || legacyPermission == "granted" {
                return "granted"
            }
            if applicationPermission == "denied" || legacyPermission == "denied" {
                return "denied"
            }
            if applicationPermission == "prompt" || legacyPermission == "prompt" {
                return "prompt"
            }
            return applicationPermission == "unknown" ? legacyPermission : applicationPermission
        }
        return legacyPermission
    }

    private func createAudioSessionSnapshot(reason: String) -> [String: Any] {
        let audioSession = AVAudioSession.sharedInstance()
        let route = audioSession.currentRoute
        let outputLabels = route.outputs.map(\.portName)
        let inputLabels = route.inputs.map(\.portName)
        let bluetoothLikeOutputLabels = route.outputs
            .filter { output in
                isBluetoothLikePort(output.portType) || isBluetoothLikeLabel(output.portName)
            }
            .map(\.portName)

        return [
            "platform": "ios",
            "appState": describeApplicationState(UIApplication.shared.applicationState),
            "microphonePermission": currentRecordPermissionDescription(),
            "audioSessionActive": (audioEngine?.isRunning == true) || recognitionTask != nil || recognitionRequest != nil,
            "voiceCaptureActive": audioEngine?.isRunning == true,
            "interrupted": audioSessionInterrupted,
            "interruptionReason": audioSessionInterruptionReason ?? NSNull(),
            "routeChangeReason": lastAudioRouteChangeReason ?? NSNull(),
            "inputLabels": inputLabels,
            "outputLabels": outputLabels,
            "preferredOutputLabel": outputLabels.first ?? NSNull(),
            "bluetoothLikeOutputLabels": bluetoothLikeOutputLabels,
            "routeKind": describeAudioRouteKind(for: route.outputs),
            "reason": reason,
            "updatedAt": ISO8601DateFormatter().string(from: Date()),
        ]
    }

    private func describeApplicationState(_ state: UIApplication.State) -> String {
        switch state {
        case .active:
            return "active"
        case .inactive:
            return "inactive"
        case .background:
            return "background"
        @unknown default:
            return "unknown"
        }
    }

    @available(iOS 17.0, *)
    private func describeRecordPermission(_ permission: AVAudioApplication.recordPermission) -> String {
        switch permission {
        case .granted:
            return "granted"
        case .undetermined:
            return "prompt"
        case .denied:
            return "denied"
        @unknown default:
            return "unknown"
        }
    }

    private func describeLegacyRecordPermission(_ permission: AVAudioSession.RecordPermission) -> String {
        switch permission {
        case .granted:
            return "granted"
        case .undetermined:
            return "prompt"
        case .denied:
            return "denied"
        @unknown default:
            return "unknown"
        }
    }

    private func describeAudioRouteKind(for outputs: [AVAudioSessionPortDescription]) -> String {
        if outputs.contains(where: { isBluetoothLikePort($0.portType) }) {
            return "bluetooth"
        }
        if outputs.contains(where: { $0.portType == .builtInSpeaker }) {
            return "speaker"
        }
        if outputs.contains(where: { $0.portType == .builtInReceiver }) {
            return "receiver"
        }
        if outputs.isEmpty {
            return "unknown"
        }
        return "wired_or_builtin"
    }

    private func isBluetoothLikePort(_ portType: AVAudioSession.Port) -> Bool {
        switch portType {
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
            return true
        default:
            return false
        }
    }

    private func isBluetoothLikeLabel(_ label: String) -> Bool {
        let normalized = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.contains("airpods")
            || normalized.contains("beats")
            || normalized.contains("bluetooth")
            || normalized.contains("headset")
            || normalized.contains("headphone")
            || normalized.contains("earbud")
            || normalized.contains("hands-free")
            || normalized.contains("pods")
    }

    private func describeAudioSessionRouteChangeReason(_ rawValue: UInt) -> String {
        guard let reason = AVAudioSession.RouteChangeReason(rawValue: rawValue) else {
            return "route changed"
        }
        switch reason {
        case .newDeviceAvailable:
            return "new device available"
        case .oldDeviceUnavailable:
            return "device disconnected"
        case .categoryChange:
            return "audio category changed"
        case .override:
            return "route override"
        case .wakeFromSleep:
            return "woke from sleep"
        case .noSuitableRouteForCategory:
            return "no suitable route"
        case .routeConfigurationChange:
            return "route configuration changed"
        case .unknown:
            return "route changed"
        @unknown default:
            return "route changed"
        }
    }

    private func publishBridgeEvent(eventName: String, payload: [String: Any]) {
        let sendEvent = { [weak self] in
            guard let webView = self?.bridge?.webView else {
                return
            }
            guard
                let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
                let encoded = String(data: data, encoding: .utf8)
            else {
                return
            }

            let js = "window.dispatchEvent(new CustomEvent('\(eventName)', { detail: \(encoded) }));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        if Thread.isMainThread {
            sendEvent()
        } else {
            DispatchQueue.main.async(execute: sendEvent)
        }
    }

    private func publishShakeBridgeLog(_ message: String, severity: String = "info") {
        let emitLog = { [weak self] in
            guard let webView = self?.bridge?.webView else {
                return
            }
            let payload: [String: String] = [
                "message": message,
                "severity": severity,
            ]
            guard
                let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
                let encoded = String(data: data, encoding: .utf8)
            else {
                return
            }

            let js = """
            (function() {
              const entry = \(encoded);
              const level = entry.severity === "error"
                ? "error"
                : (entry.severity === "warn" ? "warn" : "info");
              if (window.console && typeof window.console[level] === "function") {
                window.console[level](entry.message);
              }
            })();
            """
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        if Thread.isMainThread {
            emitLog()
        } else {
            DispatchQueue.main.async(execute: emitLog)
        }
    }
}
