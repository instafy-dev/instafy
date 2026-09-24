import XCTest

final class AppUITests: XCTestCase {
  private static let triClientReadyMarker = "INSTAFY_IOS_TRI_CLIENT_READY"
  private static let triClientCaptureMarker = "INSTAFY_IOS_TRI_CLIENT_CAPTURED"

  override func setUpWithError() throws {
    continueAfterFailure = false
    addUIInterruptionMonitor(withDescription: "Instafy system alerts") { alert in
      let preferredLabels = [
        "Open",
        "Allow",
        "OK",
        "Continue",
        "While Using the App",
        "Allow While Using App",
        "Allow While Using the App",
        "Close",
      ]

      for label in preferredLabels {
        let button = alert.buttons[label]
        if button.exists {
          button.tap()
          return true
        }
      }

      let containsOpen = NSPredicate(format: "label CONTAINS[c] %@", "Open")
      let openButton = alert.buttons.matching(containsOpen).firstMatch
      if openButton.exists {
        openButton.tap()
        return true
      }

      return false
    }
  }

  private func addScreenshotAttachment(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func addScreenScreenshotAttachment(name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func addTreeAttachment(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(string: app.debugDescription)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func assertMinimumTouchTarget(
    _ element: XCUIElement,
    label: String,
    minimum: CGFloat = 44,
  ) {
    XCTAssertGreaterThanOrEqual(
      element.frame.width,
      minimum,
      "Expected \(label) to expose at least a \(minimum)-point-wide touch target.",
    )
    XCTAssertGreaterThanOrEqual(
      element.frame.height,
      minimum,
      "Expected \(label) to expose at least a \(minimum)-point-tall touch target.",
    )
  }

  private func assertFullyVisibleInWebView(
    _ element: XCUIElement,
    webView: XCUIElement,
    label: String,
  ) {
    let visibleFrame = webView.frame.intersection(element.frame)
    XCTAssertFalse(visibleFrame.isNull, "Expected \(label) to intersect the visible iPhone WebView.")
    XCTAssertGreaterThanOrEqual(
      visibleFrame.width,
      element.frame.width - 1,
      "Expected \(label) to stay within the iPhone's horizontal safe area.",
    )
    XCTAssertGreaterThanOrEqual(
      visibleFrame.height,
      element.frame.height - 1,
      "Expected \(label) to be fully visible without scrolling.",
    )
  }

  private func runningOnSimulator() -> Bool {
    #if targetEnvironment(simulator)
      return true
    #else
      return false
    #endif
  }

  private func waitForWindowOrientation(
    _ app: XCUIApplication,
    landscape: Bool,
    timeout: TimeInterval = 8,
  ) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      let frame = app.windows.firstMatch.frame
      if !frame.isEmpty && (landscape ? frame.width > frame.height : frame.height > frame.width) {
        return true
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    } while Date() < deadline

    let frame = app.windows.firstMatch.frame
    return !frame.isEmpty && (landscape ? frame.width > frame.height : frame.height > frame.width)
  }

  private func repoRootPathForUiTest() -> String {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 {
      url.deleteLastPathComponent()
    }
    return url.path
  }

  private func uiTestContextPath() -> String {
    URL(fileURLWithPath: repoRootPathForUiTest())
      .appendingPathComponent("tmp")
      .appendingPathComponent("ios-ui-test-context.json")
      .path
  }

  private func persistedUiTestContext() -> [String: String] {
    let contextPath = URL(fileURLWithPath: uiTestContextPath())
    guard let data = try? Data(contentsOf: contextPath),
          let payload = try? JSONSerialization.jsonObject(with: data) as? [String: String]
    else {
      return [:]
    }
    return payload
  }

  private func testApplication() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["INSTAFY_UI_TEST_SESSION"] = "1"
    // Physical QA must exercise the freshly embedded web bundle. The Debug-only
    // native hook consumes this flag before Capacitor resolves a retained OTA.
    app.launchEnvironment["INSTAFY_UI_TEST_DISABLE_NATIVE_OTA"] = "1"
    return app
  }

  private func launchApp() -> XCUIApplication {
    let app = testApplication()
    app.launch()
    allowSystemPermissionPromptsIfNeeded(app)
    return app
  }

  private func activateApp() -> XCUIApplication {
    let app = testApplication()
    app.activate()
    allowSystemPermissionPromptsIfNeeded(app)
    return app
  }

  private func attachToRunningApp() -> XCUIApplication {
    let app = activateApp()
    let runningStudioMarkers = [
      app.webViews.firstMatch,
      app.buttons["Toggle sidebar"],
      app.buttons["Assistant"],
      app.buttons["Open chat"],
      app.buttons["Extensions"],
    ]
    if waitForAnyElement(runningStudioMarkers, timeout: 12) != nil {
      allowSystemPermissionPromptsIfNeeded(app)
      return app
    }

    app.launch()
    allowSystemPermissionPromptsIfNeeded(app)
    return app
  }

  private func waitForStudio(_ app: XCUIApplication, timeout: TimeInterval = 20) {
    let studioMarkers = [
      app.webViews.firstMatch,
      app.buttons["Toggle sidebar"],
      app.buttons["Assistant"],
      app.buttons["Open chat"],
      app.buttons["Extensions"],
    ]
    XCTAssertNotNil(
      waitForAnyElement(studioMarkers, timeout: timeout),
      "Expected the Studio shell to expose a WebView or one of the shell controls.",
    )
    // `launchApp` already gives first-launch system prompts the full physical-
    // device timeout. Once the Studio shell is visible, only perform a quick
    // interruption check so every navigation step does not spend another
    // eight seconds polling for an alert that is not present.
    allowSystemPermissionPromptsIfNeeded(app, timeout: 0.75, repeatCount: 1)
  }

  private func trimmedEnvironmentValue(_ key: String) -> String? {
    let persistedContext = persistedUiTestContext()
    let rawValue =
      ProcessInfo.processInfo.environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ??
      persistedContext[key]?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let rawValue, !rawValue.isEmpty else {
      return nil
    }
    return rawValue
  }

  private func uiTestAccountCredentials() -> (email: String, password: String)? {
    let persistedContext = persistedUiTestContext()
    let rawEmail =
      ProcessInfo.processInfo.environment["INSTAFY_UI_TEST_EMAIL"] ??
      persistedContext["INSTAFY_UI_TEST_EMAIL"]
    let rawPassword =
      ProcessInfo.processInfo.environment["INSTAFY_UI_TEST_PASSWORD"] ??
      persistedContext["INSTAFY_UI_TEST_PASSWORD"]

    let email = rawEmail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let password = rawPassword?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !email.isEmpty, !password.isEmpty else {
      return nil
    }
    return (email, password)
  }

  private func projectIdPrefixForUiTest() -> String? {
    guard let projectId = trimmedEnvironmentValue("INSTAFY_UI_TEST_PROJECT_ID") else {
      return nil
    }
    return String(projectId.prefix(8))
  }

  private func requestedProjectNameForUiTest() -> String? {
    trimmedEnvironmentValue("INSTAFY_UI_TEST_PROJECT_NAME")
  }

  private func requestedProjectSearchTermsForUiTest(_ app: XCUIApplication) -> [String] {
    let requestedPrefix = projectIdPrefixForUiTest()?.trimmingCharacters(in: .whitespacesAndNewlines)
    let requestedName = requestedProjectNameForUiTest()?.trimmingCharacters(in: .whitespacesAndNewlines)
    let visibleFallback = visibleProjectIdPrefixFallback(app)?.trimmingCharacters(in: .whitespacesAndNewlines)

    var orderedTerms: [String] = []
    for candidate in [requestedName, requestedPrefix, visibleFallback] {
      guard let candidate, !candidate.isEmpty else {
        continue
      }
      if !orderedTerms.contains(where: { $0.caseInsensitiveCompare(candidate) == .orderedSame }) {
        orderedTerms.append(candidate)
      }
    }
    return orderedTerms
  }

  private func visibleProjectIdPrefixFallback(_ app: XCUIApplication) -> String? {
    let prefixPattern = "^[0-9a-fA-F]{8}$"
    let predicate = NSPredicate(format: "label MATCHES %@", prefixPattern)
    let candidates: [XCUIElement] =
      app.staticTexts.matching(predicate).allElementsBoundByIndex +
      app.webViews.staticTexts.matching(predicate).allElementsBoundByIndex +
      app.webViews.descendants(matching: .staticText).matching(predicate).allElementsBoundByIndex +
      app.webViews.descendants(matching: .any).matching(predicate).allElementsBoundByIndex

    return candidates.first(where: \.exists)?.label
  }

  private func logTriClientMarker(_ marker: String) {
    NSLog(marker)
  }

  private func openAnyAccessibleProjectIfNeeded(_ app: XCUIApplication) -> Bool {
    let requestedTerms = requestedProjectSearchTermsForUiTest(app).map { $0.lowercased() }
    let projectRowPredicate = NSPredicate(format: "label CONTAINS %@", "·")
    let candidateRows = app.buttons.matching(projectRowPredicate).allElementsBoundByIndex
    let fallbackRow = candidateRows.first { element in
      guard element.exists else {
        return false
      }
      let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
      if label.isEmpty {
        return false
      }
      if label == "Space actions" ||
          label == "Create a new space" ||
          label == "Close search" ||
          label == "Search spaces" ||
          label == "Report issue" ||
          label == "Open home" ||
          label == "Open chat" ||
          label == "Start new chat" ||
          label == "Open files" ||
          label == "Switch space"
      {
        return false
      }
      if requestedTerms.contains(where: { label.lowercased().contains($0) }) {
        return false
      }
      return true
    }

    guard let fallbackRow else {
      return false
    }

    NSLog("INSTAFY_IOS_FALLBACK_SPACE_ROW \(fallbackRow.label)")
    fallbackRow.tap()
    waitForStudio(app)
    return true
  }

  @discardableResult
  private func openExtensions(_ app: XCUIApplication) -> XCUIApplication {
    var extensionsButton = waitForAnyElement(buttonCandidates(app, label: "Extensions"), timeout: 2)
    if extensionsButton == nil {
      if openAnyAccessibleProjectIfNeeded(app) {
        extensionsButton = waitForAnyElement(buttonCandidates(app, label: "Extensions"), timeout: 5)
      }
    }
    if extensionsButton == nil {
      guard let sidebarToggle = waitForAnyElement(buttonCandidates(app, label: "Toggle sidebar"), timeout: 10) else {
        addScreenshotAttachment(app, name: "Screen after failing to find Extensions")
        addTreeAttachment(app, name: "Accessibility tree after failing to find Extensions")
        XCTFail("Expected the iPhone Studio shell to expose the sidebar toggle before opening Extensions.")
        return app
      }
      sidebarToggle.tap()
      extensionsButton = waitForAnyElement(buttonCandidates(app, label: "Extensions"), timeout: 5)
    }

    XCTAssertNotNil(extensionsButton, "Expected the Studio sidebar to expose Extensions on iPhone.")
    extensionsButton?.tap()
    return app
  }

  @discardableResult
  private func openChat(_ app: XCUIApplication) -> XCUIApplication {
    let openChatButton = app.buttons["Open chat"]
    if openChatButton.waitForExistence(timeout: 5) {
      openChatButton.tap()
      return app
    }

    let assistantButton = app.buttons["Assistant"]
    XCTAssertTrue(assistantButton.waitForExistence(timeout: 5))
    assistantButton.tap()
    return app
  }

  private func chatInputElement(_ app: XCUIApplication) -> XCUIElement {
    let directTextView = app.textViews["Ask Octo"]
    if directTextView.exists {
      return directTextView
    }

    let webTextView = app.webViews.textViews["Ask Octo"]
    if webTextView.exists {
      return webTextView
    }

    return app.webViews.descendants(matching: .any)["Ask Octo"]
  }

  private func chatSendControlElement(_ app: XCUIApplication) -> XCUIElement {
    let button = app.buttons["Send message"]
    if button.exists {
      return button
    }

    let webButton = app.webViews.buttons["Send message"]
    if webButton.exists {
      return webButton
    }

    let toggle = app.switches["Send message"]
    if toggle.exists {
      return toggle
    }

    let webToggle = app.webViews.switches["Send message"]
    if webToggle.exists {
      return webToggle
    }

    return app.webViews.descendants(matching: .any)["Send message"]
  }

  private func waitForTextContaining(
    _ app: XCUIApplication,
    _ text: String,
    timeout: TimeInterval,
    pollInterval: TimeInterval = 0.25,
  ) -> Bool {
    let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedText.isEmpty else {
      return true
    }

    let predicate = NSPredicate(format: "label CONTAINS[c] %@", trimmedText)
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      let candidates = [
        app.staticTexts.matching(predicate).firstMatch,
        app.webViews.staticTexts.matching(predicate).firstMatch,
        app.webViews.descendants(matching: .staticText).matching(predicate).firstMatch,
        app.webViews.descendants(matching: .any).matching(predicate).firstMatch,
      ]
      if candidates.contains(where: \.exists) {
        return true
      }
      RunLoop.current.run(until: Date().addingTimeInterval(pollInterval))
    } while Date() < deadline

    let candidates = [
      app.staticTexts.matching(predicate).firstMatch,
      app.webViews.staticTexts.matching(predicate).firstMatch,
      app.webViews.descendants(matching: .staticText).matching(predicate).firstMatch,
      app.webViews.descendants(matching: .any).matching(predicate).firstMatch,
    ]
    return candidates.contains(where: \.exists)
  }

  private func exactStaticTextElements(
    _ app: XCUIApplication,
    text: String,
  ) -> [XCUIElement] {
    let predicate = NSPredicate(format: "label == %@", text)
    let webElements = app.webViews.staticTexts
      .matching(predicate)
      .allElementsBoundByIndex
      .filter(\.exists)
    if !webElements.isEmpty {
      return webElements
    }
    return app.staticTexts
      .matching(predicate)
      .allElementsBoundByIndex
      .filter(\.exists)
  }

  private func waitForExactStaticTextCount(
    _ app: XCUIApplication,
    text: String,
    count expectedCount: Int,
    timeout: TimeInterval,
    pollInterval: TimeInterval = 0.25,
  ) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if exactStaticTextElements(app, text: text).count == expectedCount {
        return true
      }
      RunLoop.current.run(until: Date().addingTimeInterval(pollInterval))
    } while Date() < deadline
    return exactStaticTextElements(app, text: text).count == expectedCount
  }

  private func sharedChatTimeout() -> TimeInterval {
    guard let rawValue = trimmedEnvironmentValue("INSTAFY_UI_TEST_SHARED_CHAT_TIMEOUT_SECONDS"),
          let seconds = TimeInterval(rawValue)
    else {
      return 90
    }
    return min(max(seconds, 10), 300)
  }

  private func sharedChatTypingHoldDuration() -> TimeInterval {
    guard let rawValue = trimmedEnvironmentValue("INSTAFY_UI_TEST_SHARED_CHAT_TYPING_HOLD_SECONDS"),
          let seconds = TimeInterval(rawValue)
    else {
      return 3
    }
    return min(max(seconds, 0), 15)
  }

  private func requestedConversationLogCandidates(
    _ app: XCUIApplication,
    title: String,
  ) -> [XCUIElement] {
    let label = "Conversation: \(title)"
    // WebKit exposes ARIA `role=log` by appending ", log" to the accessible
    // label on physical iOS devices. Match the stable conversation prefix so
    // an already-open chat is recognized before the harness tries to reveal
    // hidden navigation controls.
    let predicate = NSPredicate(format: "label BEGINSWITH[c] %@", label)
    return [
      app.otherElements.matching(predicate).firstMatch,
      app.webViews.otherElements.matching(predicate).firstMatch,
      app.webViews.descendants(matching: .other).matching(predicate).firstMatch,
      app.webViews.descendants(matching: .any).matching(predicate).firstMatch,
    ]
  }

  private func ensureRequestedConversationIsOpenIfNeeded(
    _ app: XCUIApplication,
    title: String,
    forbidAiOnboardingFlash: Bool = false,
  ) -> Bool {
    var reportedForbiddenAiOnboardingFlash = false

    func requestedConversationIsActive(timeout: TimeInterval) -> Bool {
      let deadline = Date().addingTimeInterval(timeout)
      repeat {
        let requestedConversationVisible = requestedConversationLogCandidates(
          app,
          title: title,
        ).contains(where: \.exists)
        if forbidAiOnboardingFlash,
           staticTextContainingCandidates(app, label: "Choose your AI").contains(where: \.exists)
        {
          if !reportedForbiddenAiOnboardingFlash {
            reportedForbiddenAiOnboardingFlash = true
            addScreenshotAttachment(app, name: "Unexpected AI onboarding flash in shared chat")
            addTreeAttachment(app, name: "Accessibility tree for unexpected AI onboarding flash")
            XCTFail(
              "Expected the requested human-only shared conversation never to flash the large AI onboarding card while activating.",
            )
          }
          return false
        }
        if requestedConversationVisible && chatInputElement(app).exists {
          return true
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
      } while Date() < deadline

      return false
    }

    if requestedConversationIsActive(timeout: 5) {
      return true
    }
    if reportedForbiddenAiOnboardingFlash {
      return false
    }

    openChat(app)
    if requestedConversationIsActive(timeout: 5) {
      return true
    }
    if reportedForbiddenAiOnboardingFlash {
      return false
    }

    let titlePredicate = NSPredicate(format: "label CONTAINS[c] %@", title)
    let directConversationButtons = [
      app.buttons.matching(titlePredicate).firstMatch,
      app.webViews.buttons.matching(titlePredicate).firstMatch,
      app.webViews.descendants(matching: .button).matching(titlePredicate).firstMatch,
    ]
    if let conversationButton = waitForAnyElement(directConversationButtons, timeout: 5) {
      _ = tapElement(conversationButton)
      if requestedConversationIsActive(timeout: 12) {
        return true
      }
      if reportedForbiddenAiOnboardingFlash {
        return false
      }
    }

    if tapFirstVisibleButton(app, labels: ["Open home"], timeout: 5) {
      let recentConversationButtons = [
        app.buttons.matching(titlePredicate).firstMatch,
        app.webViews.buttons.matching(titlePredicate).firstMatch,
        app.webViews.descendants(matching: .button).matching(titlePredicate).firstMatch,
      ]
      if let recentConversation = waitForAnyElement(recentConversationButtons, timeout: 20) {
        _ = tapElement(recentConversation)
        openChat(app)
        if requestedConversationIsActive(timeout: 20) {
          return true
        }
        if reportedForbiddenAiOnboardingFlash {
          return false
        }
      }
    }

    addScreenshotAttachment(app, name: "Screen after requested shared conversation recovery failed")
    addTreeAttachment(app, name: "Accessibility tree after requested shared conversation recovery failed")
    XCTFail("Expected the requested shared conversation \(title) to be active on iPhone.")
    return false
  }

  private func waitForNewStaticText(
    _ query: XCUIElementQuery,
    minimumCount: Int,
    timeout: TimeInterval,
    pollInterval: TimeInterval = 0.25,
  ) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if query.count >= minimumCount {
        return true
      }
      RunLoop.current.run(until: Date().addingTimeInterval(pollInterval))
    } while Date() < deadline
    return query.count >= minimumCount
  }

  private func currentLatestCaptureLabels(_ app: XCUIApplication) -> [String] {
    let predicates = [
      NSPredicate(format: "label CONTAINS %@", "Latest capture"),
      NSPredicate(format: "label CONTAINS %@", "Latest test photo"),
      NSPredicate(format: "label CONTAINS %@", "Last capture:"),
    ]

    let latestCaptureLabels = predicates.flatMap { predicate in
      app.staticTexts.matching(predicate).allElementsBoundByIndex +
        app.webViews.staticTexts.matching(predicate).allElementsBoundByIndex +
        app.webViews.descendants(matching: .staticText).matching(predicate).allElementsBoundByIndex +
        app.webViews.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
    }

    return latestCaptureLabels.compactMap { element in
      guard element.exists else {
        return nil
      }
      let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
      return label.isEmpty ? nil : label
    }
  }

  private func waitForLatestCaptureRecorded(
    _ app: XCUIApplication,
    baselineLabels: [String],
    timeout: TimeInterval,
    pollInterval: TimeInterval = 0.25,
  ) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      let labels = currentLatestCaptureLabels(app)
      if !labels.isEmpty && (baselineLabels.isEmpty || labels != baselineLabels) {
        return true
      }
      RunLoop.current.run(until: Date().addingTimeInterval(pollInterval))
    } while Date() < deadline

    let labels = currentLatestCaptureLabels(app)
    return !labels.isEmpty && (baselineLabels.isEmpty || labels != baselineLabels)
  }

  private func waitForAnyElement(
    _ candidates: [XCUIElement],
    timeout: TimeInterval,
    pollInterval: TimeInterval = 0.25,
  ) -> XCUIElement? {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      for candidate in candidates where candidate.exists {
        return candidate
      }
      RunLoop.current.run(until: Date().addingTimeInterval(pollInterval))
    } while Date() < deadline
    return candidates.first(where: \.exists)
  }

  private func firstMatch(_ query: XCUIElementQuery, label: String) -> XCUIElement {
    query.matching(NSPredicate(format: "label == %@", label)).firstMatch
  }

  private func firstContainingMatch(_ query: XCUIElementQuery, label: String) -> XCUIElement {
    query.matching(NSPredicate(format: "label CONTAINS[c] %@", label)).firstMatch
  }

  private func buttonCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstMatch(app.buttons, label: label),
      firstMatch(app.webViews.buttons, label: label),
      firstMatch(app.webViews.descendants(matching: .button), label: label),
      firstMatch(app.webViews.descendants(matching: .any), label: label),
    ]
  }

  private func buttonContainingCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstContainingMatch(app.buttons, label: label),
      firstContainingMatch(app.webViews.buttons, label: label),
      firstContainingMatch(app.webViews.descendants(matching: .button), label: label),
      firstContainingMatch(app.webViews.descendants(matching: .any), label: label),
    ]
  }

  private func switchCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstMatch(app.switches, label: label),
      firstMatch(app.webViews.switches, label: label),
      firstMatch(app.webViews.descendants(matching: .switch), label: label),
      firstMatch(app.webViews.descendants(matching: .any), label: label),
    ]
  }

  private func switchContainingCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstContainingMatch(app.switches, label: label),
      firstContainingMatch(app.webViews.switches, label: label),
      firstContainingMatch(app.webViews.descendants(matching: .switch), label: label),
      firstContainingMatch(app.webViews.descendants(matching: .any), label: label),
    ]
  }

  private func staticTextCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstMatch(app.staticTexts, label: label),
      firstMatch(app.webViews.staticTexts, label: label),
      firstMatch(app.webViews.descendants(matching: .staticText), label: label),
      firstMatch(app.webViews.descendants(matching: .any), label: label),
    ]
  }

  private func staticTextContainingCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstContainingMatch(app.staticTexts, label: label),
      firstContainingMatch(app.webViews.staticTexts, label: label),
      firstContainingMatch(app.webViews.descendants(matching: .staticText), label: label),
      firstContainingMatch(app.webViews.descendants(matching: .any), label: label),
    ]
  }

  private func imageCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstMatch(app.images, label: label),
      firstMatch(app.webViews.images, label: label),
      firstMatch(app.webViews.descendants(matching: .image), label: label),
      firstMatch(app.webViews.descendants(matching: .any), label: label),
    ]
  }

  private func deviceCodeCandidates(_ app: XCUIApplication) -> [XCUIElement] {
    let predicate = NSPredicate(
      format: "label MATCHES[c] %@",
      "^[A-Z0-9]{3,12}(-[A-Z0-9]{3,12})+$",
    )
    return [
      app.staticTexts.matching(predicate).firstMatch,
      app.webViews.staticTexts.matching(predicate).firstMatch,
      app.webViews.descendants(matching: .staticText).matching(predicate).firstMatch,
      app.webViews.descendants(matching: .any).matching(predicate).firstMatch,
    ]
  }

  private func textFieldCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstMatch(app.textFields, label: label),
      firstMatch(app.webViews.textFields, label: label),
      firstMatch(app.webViews.descendants(matching: .textField), label: label),
      firstMatch(app.webViews.descendants(matching: .any), label: label),
    ]
  }

  private func textFieldCandidates(_ app: XCUIApplication, labels: [String]) -> [XCUIElement] {
    labels.flatMap { textFieldCandidates(app, label: $0) }
  }

  private func searchFieldCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstMatch(app.searchFields, label: label),
      firstMatch(app.webViews.searchFields, label: label),
      firstMatch(app.webViews.descendants(matching: .searchField), label: label),
      firstMatch(app.textFields, label: label),
      firstMatch(app.webViews.textFields, label: label),
      firstMatch(app.webViews.descendants(matching: .textField), label: label),
    ]
  }

  private func searchFieldCandidates(_ app: XCUIApplication, labels: [String]) -> [XCUIElement] {
    labels.flatMap { searchFieldCandidates(app, label: $0) }
  }

  private func projectPickerSearchFieldCandidates(_ app: XCUIApplication) -> [XCUIElement] {
    searchFieldCandidates(app, labels: ["Search spaces", "Search spaces…"])
  }

  private func secureTextFieldCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstMatch(app.secureTextFields, label: label),
      firstMatch(app.webViews.secureTextFields, label: label),
      firstMatch(app.webViews.descendants(matching: .secureTextField), label: label),
      firstMatch(app.webViews.descendants(matching: .any), label: label),
    ]
  }

  private func secureTextFieldCandidates(_ app: XCUIApplication, labels: [String]) -> [XCUIElement] {
    labels.flatMap { secureTextFieldCandidates(app, label: $0) }
  }

  private func loginEmailFieldCandidates(_ app: XCUIApplication) -> [XCUIElement] {
    textFieldCandidates(app, labels: ["Email address", "EMAIL ADDRESS", "you@example.com"])
  }

  private func loginPasswordFieldCandidates(_ app: XCUIApplication) -> [XCUIElement] {
    secureTextFieldCandidates(app, labels: ["Password", "PASSWORD"])
  }

  private func savedAccountContinueButtonCandidates(_ app: XCUIApplication) -> [XCUIElement] {
    let predicate = NSPredicate(format: "label BEGINSWITH[c] %@", "Continue with password as")
    return [
      app.buttons.matching(predicate).firstMatch,
      app.webViews.buttons.matching(predicate).firstMatch,
      app.webViews.descendants(matching: .button).matching(predicate).firstMatch,
      app.webViews.descendants(matching: .any).matching(predicate).firstMatch,
    ]
  }

  private func menuItemCandidates(_ app: XCUIApplication, label: String) -> [XCUIElement] {
    [
      firstMatch(app.menuItems, label: label),
      firstMatch(app.webViews.menuItems, label: label),
      firstMatch(app.webViews.descendants(matching: .menuItem), label: label),
      firstMatch(app.webViews.descendants(matching: .any), label: label),
    ]
  }

  private func tapAnyVisibleElement(
    _ candidates: [XCUIElement],
    timeout: TimeInterval = 2,
  ) -> Bool {
    guard let element = waitForAnyElement(candidates, timeout: timeout) else {
      return false
    }
    return tapElement(element)
  }

  private func tapFirstVisibleButton(
    _ app: XCUIApplication,
    labels: [String],
    timeout: TimeInterval = 2,
  ) -> Bool {
    for label in labels {
      if tapButtonIfVisible(app, label: label, timeout: timeout) {
        return true
      }
    }
    return false
  }

  private func cameraAttachButtonLabels() -> [String] {
    [
      "Use this device Camera",
      "Use this device",
      "Use this phone for Camera",
      "Use this phone",
      "Use This Device for Camera",
      "Use This Device",
    ]
  }

  private func cameraSetupButtonLabels() -> [String] {
    ["Open setup Camera", "Open setup", "Setup Camera", "Setup"]
  }

  @discardableResult
  private func openCameraManageSurfaceIfNeeded(
    _ app: XCUIApplication,
    timeout: TimeInterval = 8,
  ) -> Bool {
    if buttonExists(app, labels: ["Take test photo", "Capture photo", "Hide Camera", "Hide"], timeout: min(timeout, 2)) {
      return true
    }

    return tapFirstVisibleButton(app, labels: ["Manage Camera", "Manage"], timeout: timeout) ||
      tapFirstVisibleButton(app, labels: cameraSetupButtonLabels(), timeout: timeout) ||
      buttonExists(app, labels: ["Hide Camera", "Hide"], timeout: min(timeout, 3))
  }

  private func reopenCameraManageSurface(_ app: XCUIApplication, timeout: TimeInterval = 10) -> Bool {
    waitForStudio(app)
    openExtensions(app)
    return openCameraManageSurfaceIfNeeded(app, timeout: timeout)
  }

  @discardableResult
  private func waitForCameraManageReadyState(
    _ app: XCUIApplication,
    timeout: TimeInterval = 20,
  ) -> Bool {
    let candidates = [
      app.buttons["Take test photo"],
      app.webViews.buttons["Take test photo"],
      app.buttons["Capture photo"],
      app.webViews.buttons["Capture photo"],
      app.buttons["Stop using this phone Camera"],
      app.webViews.buttons["Stop using this phone Camera"],
      app.buttons["Stop Using This Device Camera"],
      app.webViews.buttons["Stop Using This Device Camera"],
      app.staticTexts["Camera ready"],
      app.webViews.staticTexts["Camera ready"],
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Preferred phone:")).firstMatch,
      app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Preferred phone:")).firstMatch,
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "This phone")).firstMatch,
      app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "This phone")).firstMatch,
    ]
    return waitForAnyElement(candidates, timeout: timeout) != nil
  }

  @discardableResult
  private func selectAlternateCameraLensIfNeeded(
    _ app: XCUIApplication,
    baselineLatestCaptureLabels: [String],
    timeout: TimeInterval = 3,
  ) -> Bool {
    guard !baselineLatestCaptureLabels.isEmpty else {
      return false
    }

    let baselineSummary = baselineLatestCaptureLabels.joined(separator: " ").lowercased()
    let alternateLensLabel: String?
    if baselineSummary.contains("rear lens") {
      alternateLensLabel = "Front lens"
    } else if baselineSummary.contains("front lens") {
      alternateLensLabel = "Rear lens"
    } else {
      alternateLensLabel = nil
    }

    guard let alternateLensLabel else {
      return false
    }

    let switched = tapFirstVisibleButton(app, labels: [alternateLensLabel], timeout: timeout)
    if switched {
      NSLog("INSTAFY_IOS_CAMERA_SWITCH_LENS \(alternateLensLabel)")
      RunLoop.current.run(until: Date().addingTimeInterval(0.6))
    }
    return switched
  }

  private func waitForCameraCaptureButton(
    _ app: XCUIApplication,
    timeout: TimeInterval = 25,
    refreshTimeout: TimeInterval = 3,
  ) -> XCUIElement? {
    let deadline = Date().addingTimeInterval(timeout)
    var attachedCurrentDevice = false
    var requestedPermission = false
    repeat {
      if buttonExists(
        app,
        labels: ["Stop using this phone Camera", "Stop Using This Device Camera", "Front lens", "Rear lens", "Check again", "Refresh"],
        timeout: 1,
      ) {
        attachedCurrentDevice = true
      }

      if let capturePhotoButton = waitForAnyElement(
        buttonCandidates(app, label: "Take test photo") + buttonCandidates(app, label: "Capture photo"),
        timeout: 1,
      ) {
        return capturePhotoButton
      }

      if tapFirstVisibleButton(app, labels: ["Open settings", "Open Settings"], timeout: 1) {
        NSLog("INSTAFY_IOS_CAMERA_OPEN_SETTINGS")
        if enableCameraPermissionInSettingsIfNeeded(app) {
          requestedPermission = true
          _ = reopenCameraManageSurface(app, timeout: 10)
          _ = tapFirstVisibleButton(app, labels: ["Check again", "Refresh"], timeout: refreshTimeout)
        }
      } else if tapFirstVisibleButton(app, labels: ["Enable camera access", "Allow camera"], timeout: 1) {
        NSLog("INSTAFY_IOS_CAMERA_REQUEST_PERMISSION")
        requestedPermission = true
        allowSystemPermissionPromptsIfNeeded(app, timeout: 6, repeatCount: 4)
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        _ = tapFirstVisibleButton(app, labels: ["Check again", "Refresh"], timeout: refreshTimeout)
      } else if !attachedCurrentDevice &&
          tapFirstVisibleButton(app, labels: cameraAttachButtonLabels(), timeout: 1) {
        NSLog("INSTAFY_IOS_CAMERA_ATTACH_DEVICE")
        attachedCurrentDevice = true
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        _ = openCameraManageSurfaceIfNeeded(app, timeout: 6)
      } else {
        allowSystemPermissionPromptsIfNeeded(app, timeout: 1, repeatCount: 2)
      }

      if let capturePhotoButton = waitForAnyElement(
        buttonCandidates(app, label: "Take test photo") + buttonCandidates(app, label: "Capture photo"),
        timeout: 1,
      ) {
        return capturePhotoButton
      }

      if tapFirstVisibleButton(app, labels: ["Check again", "Refresh"], timeout: refreshTimeout) {
        if let capturePhotoButton = waitForAnyElement(
          buttonCandidates(app, label: "Take test photo") + buttonCandidates(app, label: "Capture photo"),
          timeout: 2,
        ) {
          return capturePhotoButton
        }
      }

      if requestedPermission &&
        buttonExists(app, labels: ["Enable camera access", "Allow camera", "Open settings", "Open Settings"], timeout: 1)
      {
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
      }

      if !buttonExists(app, labels: ["Hide Camera", "Hide"], timeout: 1) {
        _ = reopenCameraManageSurface(app, timeout: 10)
      }

      RunLoop.current.run(until: Date().addingTimeInterval(0.4))
    } while Date() < deadline

    return waitForAnyElement(
      buttonCandidates(app, label: "Take test photo") + buttonCandidates(app, label: "Capture photo"),
      timeout: 1,
    )
  }

  private func enableCameraPermissionInSettingsIfNeeded(_ app: XCUIApplication) -> Bool {
    let settingsApp = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
    guard settingsApp.waitForExistence(timeout: 10) else {
      return false
    }

    let cameraSwitch = waitForAnyElement(
      [
        settingsApp.switches["Camera"],
        settingsApp.tables.switches["Camera"],
        settingsApp.cells.switches["Camera"],
      ],
      timeout: 10,
    )
    guard let cameraSwitch else {
      return false
    }

    if let value = cameraSwitch.value as? String, value == "0" {
      cameraSwitch.tap()
    }

    app.activate()
    return true
  }

  private func tapButtonIfVisible(
    _ app: XCUIApplication,
    label: String,
    timeout: TimeInterval = 2,
  ) -> Bool {
    guard let button = waitForAnyElement(buttonCandidates(app, label: label), timeout: timeout) else {
      return false
    }
    return tapElement(button)
  }

  private func tapElement(_ element: XCUIElement) -> Bool {
    guard element.exists else {
      return false
    }
    if element.isHittable {
      element.tap()
      return true
    }
    let coordinate = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    coordinate.tap()
    return true
  }

  private func buttonExists(
    _ app: XCUIApplication,
    labels: [String],
    timeout: TimeInterval = 2,
  ) -> Bool {
    for label in labels {
      if waitForAnyElement(buttonCandidates(app, label: label), timeout: timeout) != nil {
        return true
      }
    }
    return false
  }

  private func allowSystemCameraPermissionIfNeeded(_ app: XCUIApplication) {
    allowSystemPermissionPromptsIfNeeded(app)
  }

  private func allowSystemPermissionPromptsIfNeeded(
    _ app: XCUIApplication,
    timeout: TimeInterval = 8,
    repeatCount: Int = 3,
  ) {
    if runningOnSimulator() {
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      let labels = [
        "Open",
        "Allow",
        "OK",
        "Continue",
        "While Using the App",
        "Allow While Using App",
        "Allow While Using the App",
        "Close",
      ]
      let candidates = labels.flatMap { label in
        [
          app.alerts.buttons[label],
          springboard.alerts.buttons[label],
        ]
      }

      guard let button = waitForAnyElement(candidates, timeout: min(timeout, 0.5), pollInterval: 0.1) else {
        return
      }
      button.tap()
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
      return
    }

    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let labels = [
      "Open",
      "Allow",
      "OK",
      "Continue",
      "While Using the App",
      "Allow While Using App",
      "Allow While Using the App",
      "Close",
    ]
    let candidates = labels.flatMap { label in
      [
        app.alerts.buttons[label],
        springboard.alerts.buttons[label],
      ]
    }
    for _ in 0..<repeatCount {
      guard let button = waitForAnyElement(candidates, timeout: timeout) else {
        return
      }
      button.tap()
      RunLoop.current.run(until: Date().addingTimeInterval(0.4))
    }
  }

  private func ensureLoggedInIfNeeded(_ app: XCUIApplication) {
    allowSystemPermissionPromptsIfNeeded(app, timeout: 2)

    let studioShellMarkers = [
      app.buttons["Toggle sidebar"],
      app.buttons["Assistant"],
      app.buttons["Open chat"],
      app.buttons["Extensions"],
    ]
    if waitForAnyElement(studioShellMarkers, timeout: runningOnSimulator() ? 1 : 2) != nil,
       waitForAnyElement(loginEmailFieldCandidates(app), timeout: 0.5) == nil
    {
      return
    }

    if waitForAnyElement(loginEmailFieldCandidates(app), timeout: 0.5) == nil,
       waitForAnyElement(loginPasswordFieldCandidates(app), timeout: 0.5) == nil
    {
      if let savedAccountButton = waitForAnyElement(savedAccountContinueButtonCandidates(app), timeout: 1) {
        _ = tapElement(savedAccountButton)
        allowSystemPermissionPromptsIfNeeded(app, timeout: 1)
      } else if tapFirstVisibleButton(app, labels: ["Log in to another account"], timeout: 1.5) {
        allowSystemPermissionPromptsIfNeeded(app, timeout: 1)
      }

      if waitForAnyElement(studioShellMarkers, timeout: 2) != nil,
         waitForAnyElement(loginEmailFieldCandidates(app), timeout: 0.5) == nil,
         waitForAnyElement(loginPasswordFieldCandidates(app), timeout: 0.5) == nil
      {
        return
      }
    }

    if let passwordField = waitForAnyElement(loginPasswordFieldCandidates(app), timeout: 1) {
      guard let credentials = uiTestAccountCredentials() else {
        XCTFail("Instafy is showing iPhone password login, but INSTAFY_UI_TEST_EMAIL / INSTAFY_UI_TEST_PASSWORD were not provided to the UI test.")
        return
      }

      passwordField.tap()
      passwordField.typeText(credentials.password)

      guard tapFirstVisibleButton(app, labels: ["Continue"], timeout: 5) else {
        XCTFail("Expected the iPhone login flow to show Continue after selecting the saved account.")
        return
      }

      XCTAssertTrue(
        waitForAnyElement(
          [
            app.webViews.firstMatch,
            app.buttons["Toggle sidebar"],
            app.buttons["Assistant"],
            app.buttons["Open chat"],
          ],
          timeout: 30,
        ) != nil,
        "Expected Instafy Studio to finish logging in on iPhone.",
      )
      return
    }

    guard let emailField = waitForAnyElement(loginEmailFieldCandidates(app), timeout: 3) else {
      return
    }

    guard let credentials = uiTestAccountCredentials() else {
      XCTFail("Instafy is showing login on iPhone, but INSTAFY_UI_TEST_EMAIL / INSTAFY_UI_TEST_PASSWORD were not provided to the UI test.")
      return
    }

    emailField.tap()
    emailField.typeText(credentials.email)

    guard tapFirstVisibleButton(app, labels: ["Continue"], timeout: 5) else {
      XCTFail("Expected the iPhone login flow to show Continue after entering email.")
      return
    }

    guard let passwordField = waitForAnyElement(loginPasswordFieldCandidates(app), timeout: 10) else {
      XCTFail("Expected the iPhone login flow to show Password after continuing.")
      return
    }
    passwordField.tap()
    passwordField.typeText(credentials.password)

    guard tapFirstVisibleButton(app, labels: ["Continue"], timeout: 5) else {
      XCTFail("Expected the iPhone login flow to show Continue after entering password.")
      return
    }

    XCTAssertTrue(
      waitForAnyElement(
        [
          app.webViews.firstMatch,
          app.buttons["Toggle sidebar"],
          app.buttons["Assistant"],
          app.buttons["Open chat"],
        ],
        timeout: 30,
      ) != nil,
      "Expected Instafy Studio to finish logging in on iPhone.",
    )
  }

  private func resetSessionToExpectedUiTestAccount(_ app: XCUIApplication) {
    allowSystemPermissionPromptsIfNeeded(app, timeout: 2)

    guard let credentials = uiTestAccountCredentials() else {
      let persistedKeys = Array(persistedUiTestContext().keys).sorted().joined(separator: ",")
      NSLog(
        "INSTAFY_IOS_UI_TEST_CONTEXT_MISSING path=\(uiTestContextPath()) exists=\(FileManager.default.fileExists(atPath: uiTestContextPath())) keys=\(persistedKeys)"
      )
      XCTFail("Cannot reset the iPhone session without INSTAFY_UI_TEST_EMAIL / INSTAFY_UI_TEST_PASSWORD.")
      return
    }

    NSLog("INSTAFY_IOS_UI_TEST_CONTEXT_READY email=\(credentials.email)")

    if waitForAnyElement(loginEmailFieldCandidates(app), timeout: 2) != nil {
      ensureLoggedInIfNeeded(app)
      return
    }

    func openProfileMenuIfVisible(timeout: TimeInterval = 5) -> Bool {
      if tapFirstVisibleButton(app, labels: ["Open profile menu"], timeout: timeout) {
        return true
      }

      let emailPredicate = NSPredicate(format: "label CONTAINS %@", "@")
      return tapAnyVisibleElement(
        [
          app.buttons.matching(emailPredicate).firstMatch,
          app.otherElements.matching(emailPredicate).firstMatch,
          app.webViews.buttons.matching(emailPredicate).firstMatch,
          app.webViews.otherElements.matching(emailPredicate).firstMatch,
          app.webViews.descendants(matching: .any).matching(emailPredicate).firstMatch,
        ],
        timeout: timeout,
      )
    }

    if tapFirstVisibleButton(app, labels: ["Close search"], timeout: 2) {
      waitForStudio(app)
    }

    if !openProfileMenuIfVisible(timeout: 2),
       tapFirstVisibleButton(app, labels: ["Open home"], timeout: 3)
    {
      waitForStudio(app)
    }

    if !openProfileMenuIfVisible(timeout: 2) {
      _ = openAnyAccessibleProjectIfNeeded(app)
    }

    if !openProfileMenuIfVisible(timeout: 2) {
      _ = tapButtonIfVisible(app, label: "Toggle sidebar", timeout: 5)
    }

    if !openProfileMenuIfVisible(timeout: 2),
       tapFirstVisibleButton(app, labels: ["Open home"], timeout: 3)
    {
      waitForStudio(app)
      _ = tapButtonIfVisible(app, label: "Toggle sidebar", timeout: 5)
    }

    guard openProfileMenuIfVisible(timeout: 8) else {
      addScreenshotAttachment(app, name: "Screen after failed profile recovery attempt")
      addTreeAttachment(app, name: "Accessibility tree after failed profile recovery attempt")
      XCTFail("Expected the iPhone Studio shell to expose the profile menu while recovering the test session.")
      return
    }
    guard tapAnyVisibleElement(buttonCandidates(app, label: "Sign out") + menuItemCandidates(app, label: "Sign out"), timeout: 8) else {
      XCTFail("Expected the iPhone profile menu to expose Sign out while recovering the test session.")
      return
    }
    XCTAssertTrue(
      waitForAnyElement(loginEmailFieldCandidates(app), timeout: 30) != nil,
      "Expected the iPhone app to return to login after signing out during access recovery.",
    )
    ensureLoggedInIfNeeded(app)
  }

  private func ensureRequestedProjectIsOpenIfNeeded(_ app: XCUIApplication) {
    allowSystemPermissionPromptsIfNeeded(app, timeout: 2)

    let requestedTerms = requestedProjectSearchTermsForUiTest(app)
    guard let primaryProjectTerm = requestedTerms.first else {
      return
    }

    if requestedProjectNameForUiTest() == nil, projectIdPrefixForUiTest() == nil {
      NSLog("INSTAFY_IOS_PICKER_FALLBACK_TERM \(primaryProjectTerm)")
    }

    func isProjectPickerControlLabel(_ label: String) -> Bool {
      switch label {
      case
        "Space actions",
        "Create a new space",
        "Close search",
        "Open requested space",
        "Search spaces",
        "Report issue",
        "Open home",
        "Open chat",
        "Start new chat",
        "Open files",
        "Switch space",
        "New space",
        "Space settings",
        "Team settings",
        "Back":
        return true
      default:
        return false
      }
    }

    func matchingProjectButton(for terms: [String]) -> XCUIElement? {
      for term in terms {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", term)
        let candidates: [XCUIElement] = [
          app.buttons.matching(predicate).firstMatch,
          app.menuItems.matching(predicate).firstMatch,
          app.webViews.buttons.matching(predicate).firstMatch,
          app.webViews.menuItems.matching(predicate).firstMatch,
          app.webViews.descendants(matching: .menuItem).matching(predicate).firstMatch,
          app.webViews.descendants(matching: .button).matching(predicate).firstMatch,
          app.webViews.descendants(matching: .any).matching(predicate).firstMatch,
        ]
        if let match = waitForAnyElement(candidates, timeout: 3) {
          if isProjectPickerControlLabel(match.label.trimmingCharacters(in: .whitespacesAndNewlines)) {
            continue
          }
          return match
        }
      }
      return nil
    }

    func matchingRequestedProjectText(for terms: [String]) -> XCUIElement? {
      let candidates = terms.flatMap { term -> [XCUIElement] in
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", term)
        return [
          app.staticTexts.matching(predicate).firstMatch,
          app.webViews.staticTexts.matching(predicate).firstMatch,
          app.webViews.descendants(matching: .staticText).matching(predicate).firstMatch,
          app.webViews.descendants(matching: .any).matching(predicate).firstMatch,
        ]
      }
      return waitForAnyElement(candidates, timeout: 2)
    }

    func pickerChromeVisible() -> Bool {
      app.staticTexts["All teams"].exists ||
        app.staticTexts["Space not found"].exists ||
        buttonExists(app, labels: ["Search spaces", "Create a new space", "Open requested space"], timeout: 1)
    }

    func openRequestedProjectButton() -> XCUIElement? {
      waitForAnyElement(buttonCandidates(app, label: "Open requested space"), timeout: 1)
    }

    func requestedProjectVisibleInStudioShell() -> Bool {
      for term in requestedTerms {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", term)
        let candidates =
          app.staticTexts.matching(predicate).allElementsBoundByIndex +
          app.buttons.matching(predicate).allElementsBoundByIndex +
          app.webViews.staticTexts.matching(predicate).allElementsBoundByIndex +
          app.webViews.buttons.matching(predicate).allElementsBoundByIndex +
          app.webViews.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
        if candidates.contains(where: \.exists) {
          return true
        }
      }
      return false
    }

    func openProjectPickerFromStudioShell() -> Bool {
      if tapFirstVisibleButton(app, labels: ["Switch space"], timeout: 2) {
        return true
      }

      if tapButtonIfVisible(app, label: "Toggle sidebar", timeout: 3),
         tapFirstVisibleButton(app, labels: ["Open team and spaces", "Switch space"], timeout: 5)
      {
        return true
      }

      if tapFirstVisibleButton(app, labels: ["Open home"], timeout: 3) {
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        if tapFirstVisibleButton(app, labels: ["Switch space"], timeout: 2) {
          return true
        }
        if tapButtonIfVisible(app, label: "Toggle sidebar", timeout: 3),
           tapFirstVisibleButton(app, labels: ["Open team and spaces", "Switch space"], timeout: 5)
        {
          return true
        }
      }

      return false
    }

    let deadline = Date().addingTimeInterval(60)
    var sawPickerSurface = false
    repeat {
      let searchField = waitForAnyElement(
        projectPickerSearchFieldCandidates(app),
        timeout: 1,
      )
      let projectButton = matchingProjectButton(for: requestedTerms)
      let projectText = matchingRequestedProjectText(for: requestedTerms)
      let pickerSurfaceVisible =
        projectButton != nil ||
        projectText != nil ||
        app.staticTexts["Space not found"].exists ||
        app.staticTexts["All teams"].exists ||
        buttonExists(app, labels: ["Search spaces", "Create a new space"], timeout: 1) ||
        searchField != nil

      if !pickerSurfaceVisible {
        if requestedProjectVisibleInStudioShell() {
          waitForStudio(app)
          return
        }

        if openProjectPickerFromStudioShell() {
          RunLoop.current.run(until: Date().addingTimeInterval(0.6))
          continue
        }

        if sawPickerSurface {
          waitForStudio(app)
          return
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        continue
      }
      sawPickerSurface = true
      allowSystemPermissionPromptsIfNeeded(app, timeout: 1)

      NSLog("INSTAFY_IOS_PICKER_VISIBLE \(primaryProjectTerm)")

      if let requestedButton = openRequestedProjectButton() {
        NSLog("INSTAFY_IOS_PICKER_TAPPED_OPEN_REQUESTED \(primaryProjectTerm)")
        requestedButton.tap()
        let pickerDismissDeadline = Date().addingTimeInterval(15)
        var pickerDismissed = false
        repeat {
          let chromeStillVisible = pickerChromeVisible()
          let studioControlsVisible = waitForAnyElement(
            [
              app.buttons["Extensions"],
              app.buttons["Assistant"],
              app.buttons["Open chat"],
              app.buttons["Toggle sidebar"],
            ],
            timeout: 1,
          ) != nil

          if !chromeStillVisible || studioControlsVisible {
            pickerDismissed = true
            break
          }

          RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        } while Date() < pickerDismissDeadline
        XCTAssertTrue(
          pickerDismissed,
          "Expected the Instafy space picker to dismiss after reopening the requested space \(primaryProjectTerm).",
        )
        waitForStudio(app)
        return
      }

      if searchField == nil, projectButton == nil, projectText == nil {
        NSLog("INSTAFY_IOS_PICKER_OPEN_SEARCH \(primaryProjectTerm)")
        if tapFirstVisibleButton(app, labels: ["Search spaces"], timeout: 2) {
          RunLoop.current.run(until: Date().addingTimeInterval(0.6))
          continue
        }
      }

      if let searchField {
        NSLog("INSTAFY_IOS_PICKER_SEARCH_FIELD_READY \(primaryProjectTerm)")
        var activeSearchField: XCUIElement? = searchField
        for searchTerm in requestedTerms {
          if let currentValue = activeSearchField?.value as? String,
             !currentValue.isEmpty,
             currentValue != "Search spaces",
             currentValue != searchTerm
          {
            if tapFirstVisibleButton(app, labels: ["Close search"], timeout: 1) {
              RunLoop.current.run(until: Date().addingTimeInterval(0.4))
              _ = tapFirstVisibleButton(app, labels: ["Search spaces"], timeout: 2)
              RunLoop.current.run(until: Date().addingTimeInterval(0.6))
              activeSearchField = waitForAnyElement(
                projectPickerSearchFieldCandidates(app),
                timeout: 2,
              )
            } else {
              activeSearchField?.typeText(
                String(repeating: XCUIKeyboardKey.delete.rawValue, count: currentValue.count)
              )
            }
          }
          activeSearchField?.tap()
          if (activeSearchField?.value as? String) != searchTerm {
            activeSearchField?.typeText(searchTerm)
            NSLog("INSTAFY_IOS_PICKER_TYPED_TERM \(searchTerm)")
            RunLoop.current.run(until: Date().addingTimeInterval(0.8))
          }

          if let projectButton = matchingProjectButton(for: [searchTerm]) {
            NSLog(
              "INSTAFY_IOS_PICKER_FOUND_ROW \(searchTerm) label=\(projectButton.label) hittable=\(projectButton.isHittable)"
            )
            if !projectButton.isHittable {
              app.webViews.firstMatch.swipeUp()
              RunLoop.current.run(until: Date().addingTimeInterval(0.4))
              continue
            }

            projectButton.tap()
            NSLog("INSTAFY_IOS_PICKER_TAPPED_ROW \(searchTerm)")
            let pickerDismissDeadline = Date().addingTimeInterval(15)
            var pickerDismissed = false
            repeat {
              let chromeStillVisible = pickerChromeVisible()
              let studioControlsVisible = waitForAnyElement(
                [
                  app.buttons["Extensions"],
                  app.buttons["Assistant"],
                  app.buttons["Open chat"],
                  app.buttons["Toggle sidebar"],
                ],
                timeout: 1,
              ) != nil

              if !chromeStillVisible || studioControlsVisible {
                pickerDismissed = true
                break
              }

              RunLoop.current.run(until: Date().addingTimeInterval(0.4))
            } while Date() < pickerDismissDeadline
            XCTAssertTrue(
              pickerDismissed,
              "Expected the Instafy space picker to dismiss after choosing the requested space \(searchTerm).",
            )
            NSLog("INSTAFY_IOS_PICKER_DISMISSED \(searchTerm)")
            waitForStudio(app)
            return
          }
        }
      } else if let projectButton = projectButton ?? matchingProjectButton(for: requestedTerms) {
        NSLog(
          "INSTAFY_IOS_PICKER_FOUND_ROW \(primaryProjectTerm) label=\(projectButton.label) hittable=\(projectButton.isHittable)"
        )
        if !projectButton.isHittable {
          app.webViews.firstMatch.swipeUp()
          RunLoop.current.run(until: Date().addingTimeInterval(0.4))
          continue
        }

        projectButton.tap()
        NSLog("INSTAFY_IOS_PICKER_TAPPED_ROW \(primaryProjectTerm)")
        let pickerDismissDeadline = Date().addingTimeInterval(15)
        var pickerDismissed = false
        repeat {
          let chromeStillVisible = pickerChromeVisible()
          let studioControlsVisible = waitForAnyElement(
            [
              app.buttons["Extensions"],
              app.buttons["Assistant"],
              app.buttons["Open chat"],
              app.buttons["Toggle sidebar"],
            ],
            timeout: 1,
          ) != nil

          if !chromeStillVisible || studioControlsVisible {
            pickerDismissed = true
            break
          }

          RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        } while Date() < pickerDismissDeadline
        XCTAssertTrue(
          pickerDismissed,
          "Expected the Instafy space picker to dismiss after choosing the requested space \(primaryProjectTerm).",
        )
        NSLog("INSTAFY_IOS_PICKER_DISMISSED \(primaryProjectTerm)")
        waitForStudio(app)
        return
      }

      RunLoop.current.run(until: Date().addingTimeInterval(0.4))
    } while Date() < deadline

    addScreenshotAttachment(app, name: "Screen after requested project picker recovery failed")
    addTreeAttachment(app, name: "Accessibility tree after requested project picker recovery failed")
    XCTFail("Expected the requested Instafy space \(primaryProjectTerm) to open from the picker on iPhone.")
  }

  private func capturePhotoInSystemCamera(
    timeout: TimeInterval = 20,
    baselineLatestCaptureLabels: [String] = [],
  ) {
    let app = XCUIApplication()
    if runningOnSimulator() {
      XCTAssertTrue(
        waitForLatestCaptureRecorded(
          app,
          baselineLabels: baselineLatestCaptureLabels,
          timeout: timeout,
        ),
        "Expected the iPhone simulator Camera flow to record a latest capture without opening Apple Camera.",
      )
      return
    }
    if let instafyShutter = waitForAnyElement(
      [
        app.buttons["Instafy camera shutter"],
        app.buttons["Capture"],
      ],
      timeout: timeout,
    ) {
      instafyShutter.tap()
      XCTAssertTrue(
        waitForLatestCaptureRecorded(
          app,
          baselineLabels: baselineLatestCaptureLabels,
          timeout: timeout,
        ),
        "Expected the in-app Instafy camera to record a latest capture after tapping Capture.",
      )
      return
    }
    let cameraApp = XCUIApplication(bundleIdentifier: "com.apple.camera")
    _ = waitForAnyElement(
      [
        app.buttons["PhotoCapture"],
        app.buttons["Photo capture"],
        app.buttons["Take Picture"],
        cameraApp.buttons["PhotoCapture"],
        cameraApp.buttons["Photo capture"],
        cameraApp.buttons["Take Picture"],
      ],
      timeout: timeout,
    )?.tap()

    let usePhotoButton = waitForAnyElement(
      [
        app.buttons["Use Photo"],
        app.buttons["Choose"],
        app.buttons["Done"],
        cameraApp.buttons["Use Photo"],
        cameraApp.buttons["Choose"],
        cameraApp.buttons["Done"],
      ],
      timeout: timeout,
    )
    if usePhotoButton == nil {
      addScreenshotAttachment(app, name: "Screen before iPhone camera confirm-photo assert")
      addTreeAttachment(app, name: "Accessibility tree before iPhone camera confirm-photo assert")
    }
    XCTAssertNotNil(usePhotoButton, "Expected the iPhone camera flow to offer a way to confirm the captured photo.")
    usePhotoButton?.tap()
  }

  func testWebViewLoads() throws {
    let app = launchApp()
    waitForStudio(app)

    addScreenshotAttachment(app, name: "Screen after webview load")
    addTreeAttachment(app, name: "Accessibility tree")

    let sidebarToggle = app.buttons["Toggle sidebar"]
    if sidebarToggle.waitForExistence(timeout: 2) {
      sidebarToggle.tap()

      addScreenshotAttachment(app, name: "Screen after sidebar toggle")
      addTreeAttachment(app, name: "Accessibility tree after sidebar toggle")

      let profileFooter = app.otherElements["DE dev@instafy.local"]
      if profileFooter.waitForExistence(timeout: 2) {
        profileFooter.tap()

        addScreenshotAttachment(app, name: "Screen after profile menu")
        addTreeAttachment(app, name: "Accessibility tree after profile menu")
      }
    }
  }

  func testCaptureMobileLayoutSurfaces() throws {
    let device = XCUIDevice.shared
    device.orientation = .portrait
    defer {
      device.orientation = .portrait
    }

    let app = launchApp()
    waitForStudio(app)
    XCTAssertTrue(
      waitForWindowOrientation(app, landscape: false),
      "Expected the iPhone app window to settle in portrait before mobile layout QA.",
    )

    let webView = app.webViews.firstMatch
    XCTAssertTrue(webView.waitForExistence(timeout: 5), "Expected the Studio WebView to be visible.")
    var onboardingEntry = waitForAnyElement(
      buttonCandidates(app, label: "Need ideas?"),
      timeout: 2,
    )
    if onboardingEntry == nil {
      if !tapButtonIfVisible(app, label: "Assistant", timeout: 1) {
        _ = tapButtonIfVisible(app, label: "Toggle sidebar", timeout: 3)
        _ = tapButtonIfVisible(app, label: "Assistant", timeout: 5)
      }
      onboardingEntry = waitForAnyElement(
        buttonCandidates(app, label: "Need ideas?"),
        timeout: 8,
      )
    }
    guard let onboardingEntry else {
      addScreenshotAttachment(app, name: "Screen after failing to find onboarding entry")
      addTreeAttachment(app, name: "Accessibility tree after failing to find onboarding entry")
      XCTFail("Expected the optional onboarding ideas entry to be visible without scrolling.")
      return
    }
    let visibleEntryFrame = webView.frame.intersection(onboardingEntry.frame)
    XCTAssertFalse(visibleEntryFrame.isNull, "Expected the onboarding ideas entry to intersect the visible WebView.")
    XCTAssertGreaterThanOrEqual(
      visibleEntryFrame.height,
      onboardingEntry.frame.height - 1,
      "Expected the full onboarding ideas entry to remain visible instead of being clipped above the WebView.",
    )
    assertMinimumTouchTarget(onboardingEntry, label: "Need ideas")
    guard let initialSidebarToggle = waitForAnyElement(buttonCandidates(app, label: "Toggle sidebar"), timeout: 5),
          let initialNewChat = waitForAnyElement(buttonCandidates(app, label: "New chat"), timeout: 5)
    else {
      XCTFail("Expected the initial iPhone top bar controls before touch-target QA.")
      return
    }
    assertMinimumTouchTarget(initialSidebarToggle, label: "Toggle sidebar")
    assertMinimumTouchTarget(initialNewChat, label: "New chat")
    addScreenshotAttachment(app, name: "Portrait onboarding layout")
    addTreeAttachment(app, name: "Portrait onboarding accessibility tree")

    XCTAssertTrue(tapElement(onboardingEntry), "Expected Need ideas to reveal the optional starters.")
    guard let codingStarter = waitForAnyElement(
      buttonContainingCandidates(app, label: "Coding"),
      timeout: 8,
    ) else {
      XCTFail("Expected the optional starter list to expose Coding.")
      return
    }
    XCTAssertTrue(tapElement(codingStarter), "Expected Coding to open its starter choices.")
    guard let buildWithCode = waitForAnyElement(
      buttonContainingCandidates(app, label: "Build with code"),
      timeout: 8,
    ) else {
      XCTFail("Expected Coding to expose Build with code.")
      return
    }
    XCTAssertTrue(tapElement(buildWithCode), "Expected Build with code to prefill the composer.")

    let chatInput = chatInputElement(app)
    XCTAssertTrue(chatInput.waitForExistence(timeout: 8), "Expected the chat input to be visible.")
    let starterPrompt = (chatInput.value as? String) ?? ""
    XCTAssertTrue(
      starterPrompt.contains("Help me build something in this space"),
      "Expected a starter to prefill the existing composer instead of sending or opening another flow.",
    )
    let keyboard = app.keyboards.firstMatch
    XCTAssertTrue(keyboard.waitForExistence(timeout: 8), "Expected starter selection to focus the composer.")
    RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    guard let starterComposerActions = waitForAnyElement(
      buttonCandidates(app, label: "Open composer actions"),
      timeout: 5,
    ) else {
      XCTFail("Expected the focused composer to keep its action row visible.")
      return
    }
    XCTAssertLessThanOrEqual(
      chatInput.frame.maxY,
      starterComposerActions.frame.minY,
      "Expected starter text to stop above the composer action row after the keyboard settles.",
    )
    addScreenshotAttachment(app, name: "Portrait starter prefill with native keyboard")
    addTreeAttachment(app, name: "Portrait starter prefill accessibility tree")

    chatInput.tap()

    XCTAssertTrue(keyboard.waitForExistence(timeout: 8), "Expected the native iPhone keyboard after focusing chat.")
    let keyboardMarker = "ios-layout-qa"
    chatInput.typeText(keyboardMarker)
    RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    XCTAssertLessThanOrEqual(
      chatInput.frame.maxY,
      keyboard.frame.minY + 1,
      "Expected the chat composer to remain above the native keyboard.",
    )
    guard let keyboardSidebarToggle = waitForAnyElement(
      buttonCandidates(app, label: "Toggle sidebar"),
      timeout: 5,
    ) else {
      XCTFail("Expected the Studio top bar to remain visible while the keyboard is open.")
      return
    }
    XCTAssertGreaterThanOrEqual(
      keyboardSidebarToggle.frame.minY,
      webView.frame.minY,
      "Expected WebKit not to pan the Studio top bar above the visible viewport.",
    )
    XCTAssertTrue(
      keyboardSidebarToggle.isHittable,
      "Expected the Studio top bar to remain interactive while the keyboard is open.",
    )
    addScreenshotAttachment(app, name: "Portrait chat with native keyboard")
    addTreeAttachment(app, name: "Portrait keyboard accessibility tree")
    chatInput.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: keyboardMarker.count))

    XCTAssertFalse(app.toolbars.buttons["Done"].exists, "Chat does not show the form keyboard toolbar.")
    let conversationRegion = app.otherElements.matching(NSPredicate(format: "label == %@", "Chat")).firstMatch
    XCTAssertTrue(conversationRegion.exists, "Expected the conversation area to dismiss editing.")
    conversationRegion.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap()
    let keyboardDismissDeadline = Date().addingTimeInterval(5)
    while keyboard.exists && Date() < keyboardDismissDeadline {
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    XCTAssertFalse(keyboard.exists, "Expected a conversation tap to dismiss the keyboard.")

    guard let sidebarToggle = waitForAnyElement(buttonCandidates(app, label: "Toggle sidebar"), timeout: 5) else {
      XCTFail("Expected the top bar sidebar control after dismissing the keyboard.")
      return
    }
    XCTAssertTrue(tapElement(sidebarToggle), "Expected to open mobile navigation.")

    guard tapButtonIfVisible(app, label: "Files", timeout: 8) else {
      addScreenshotAttachment(app, name: "Screen after failing to open Files")
      addTreeAttachment(app, name: "Accessibility tree after failing to open Files")
      XCTFail("Expected mobile navigation to expose Files.")
      return
    }
    XCTAssertNotNil(
      waitForAnyElement(staticTextCandidates(app, label: "Files"), timeout: 8),
      "Expected the mobile file explorer heading.",
    )
    guard let closeFiles = waitForAnyElement(buttonCandidates(app, label: "Close file explorer"), timeout: 8) else {
      XCTFail("Expected the mobile file explorer to expose its close control.")
      return
    }
    assertMinimumTouchTarget(closeFiles, label: "Close file explorer")
    guard let filesSearch = waitForAnyElement(searchFieldCandidates(app, label: "Search files"), timeout: 5) else {
      XCTFail("Expected the mobile file explorer to expose search.")
      return
    }
    assertMinimumTouchTarget(filesSearch, label: "File search")
    XCTAssertFalse(
      firstMatch(app.webViews.textViews, label: "Ask Octo").exists,
      "Expected the Files overlay to hide the obscured chat composer from accessibility.",
    )
    XCTAssertEqual(
      app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Toggle sidebar")).count,
      1,
      "Expected the Files overlay to expose only its own top bar to accessibility.",
    )
    addScreenshotAttachment(app, name: "Portrait Files panel")
    addTreeAttachment(app, name: "Portrait Files accessibility tree")
    XCTAssertTrue(tapElement(closeFiles), "Expected to close the mobile file explorer.")

    guard tapButtonIfVisible(app, label: "Toggle sidebar", timeout: 8),
          tapButtonIfVisible(app, label: "Credits", timeout: 8)
    else {
      XCTFail("Expected mobile navigation to open Credits.")
      return
    }
    XCTAssertNotNil(
      waitForAnyElement(staticTextCandidates(app, label: "Team credits"), timeout: 8),
      "Expected the Credits panel heading.",
    )
    guard let creditsUnits = waitForAnyElement(buttonCandidates(app, label: "credits"), timeout: 5),
          let creditsCurrency = waitForAnyElement(buttonCandidates(app, label: "USD"), timeout: 5),
          let creditsLog = waitForAnyElement(buttonCandidates(app, label: "Log"), timeout: 5),
          let creditsGraph = waitForAnyElement(buttonCandidates(app, label: "Graph"), timeout: 5)
    else {
      XCTFail("Expected Credits amount and activity selectors.")
      return
    }
    assertMinimumTouchTarget(creditsUnits, label: "Credits units selector")
    assertMinimumTouchTarget(creditsCurrency, label: "Credits currency selector")
    assertMinimumTouchTarget(creditsLog, label: "Credits log selector")
    assertMinimumTouchTarget(creditsGraph, label: "Credits graph selector")
    addScreenshotAttachment(app, name: "Portrait Credits activity")
    addTreeAttachment(app, name: "Portrait Credits activity accessibility tree")

    XCTAssertTrue(tapElement(creditsGraph), "Expected Graph to reveal its range selectors.")
    guard let creditsSevenDays = waitForAnyElement(buttonCandidates(app, label: "7D"), timeout: 5),
          let creditsThirtyDays = waitForAnyElement(buttonCandidates(app, label: "30D"), timeout: 5)
    else {
      XCTFail("Expected the Credits graph to expose 7D and 30D ranges.")
      return
    }
    assertMinimumTouchTarget(creditsSevenDays, label: "Credits 7-day range")
    assertMinimumTouchTarget(creditsThirtyDays, label: "Credits 30-day range")
    XCTAssertTrue(tapElement(creditsLog), "Expected Log to restore the activity list.")

    guard tapAnyVisibleElement(buttonContainingCandidates(app, label: "Sections"), timeout: 5),
          tapAnyVisibleElement(
            menuItemCandidates(app, label: "Usage") +
              buttonCandidates(app, label: "Usage") +
              staticTextCandidates(app, label: "Usage"),
            timeout: 5,
          )
    else {
      XCTFail("Expected the Credits section picker to expose Usage.")
      return
    }
    XCTAssertNotNil(
      waitForAnyElement(staticTextCandidates(app, label: "Usage rates"), timeout: 8),
      "Expected the Credits Usage section to render.",
    )
    addScreenshotAttachment(app, name: "Portrait Credits usage")
    addTreeAttachment(app, name: "Portrait Credits usage accessibility tree")

    guard let promptUsage = waitForAnyElement(staticTextCandidates(app, label: "Prompt usage"), timeout: 5),
          let creditsDockChat = waitForAnyElement(buttonCandidates(app, label: "Open chat"), timeout: 5)
    else {
      XCTFail("Expected Credits Usage content and the fixed mobile dock before scroll QA.")
      return
    }
    let promptUsageYBeforeScroll = promptUsage.frame.minY
    let creditsDockYBeforeScroll = creditsDockChat.frame.minY
    webView.swipeUp()
    let scrollDeadline = Date().addingTimeInterval(5)
    while promptUsage.frame.minY >= promptUsageYBeforeScroll - 40 && Date() < scrollDeadline {
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    XCTAssertLessThan(
      promptUsage.frame.minY,
      promptUsageYBeforeScroll - 40,
      "Expected a vertical swipe to move Credits Usage content.",
    )
    XCTAssertLessThanOrEqual(
      promptUsage.frame.maxY,
      creditsDockChat.frame.minY,
      "Expected scrolled Credits content to remain readable above the fixed mobile dock.",
    )
    XCTAssertEqual(
      creditsDockChat.frame.minY,
      creditsDockYBeforeScroll,
      accuracy: 1,
      "Expected the mobile dock to stay fixed while Credits content scrolls.",
    )
    addScreenshotAttachment(app, name: "Portrait Credits usage after vertical scroll")
    addTreeAttachment(app, name: "Portrait Credits usage after vertical scroll accessibility tree")

    webView.swipeDown()
    let scrollReturnDeadline = Date().addingTimeInterval(5)
    while promptUsage.frame.minY < promptUsageYBeforeScroll - 40 && Date() < scrollReturnDeadline {
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    XCTAssertGreaterThanOrEqual(
      promptUsage.frame.minY,
      promptUsageYBeforeScroll - 40,
      "Expected the reverse swipe to restore the Credits Usage scroll position toward the top.",
    )

    guard tapButtonIfVisible(app, label: "Toggle sidebar", timeout: 8),
          tapButtonIfVisible(app, label: "Assistant", timeout: 8)
    else {
      XCTFail("Expected mobile navigation to return to Assistant.")
      return
    }
    XCTAssertTrue(chatInputElement(app).waitForExistence(timeout: 8), "Expected chat after returning to Assistant.")

    guard tapButtonIfVisible(app, label: "Open composer actions", timeout: 8),
          tapAnyVisibleElement(
            buttonContainingCandidates(app, label: "Invite or open elsewhere") +
              buttonCandidates(app, label: "Invite teammates"),
            timeout: 8,
          )
    else {
      XCTFail("Expected the composer action menu to open the Invite modal.")
      return
    }
    guard let closeInvite = waitForAnyElement(buttonCandidates(app, label: "Close invite modal"), timeout: 8) else {
      XCTFail("Expected the Invite modal to expose its close control.")
      return
    }
    assertMinimumTouchTarget(closeInvite, label: "Close invite modal")
    guard let deviceLink = waitForAnyElement(buttonCandidates(app, label: "Copy device link"), timeout: 5),
          let deviceQr = waitForAnyElement(buttonCandidates(app, label: "Show device QR code"), timeout: 5),
          let inviteQr = waitForAnyElement(buttonCandidates(app, label: "Show QR code"), timeout: 5),
          let inviteShare = waitForAnyElement(buttonCandidates(app, label: "Share invite"), timeout: 5),
          let inviteEmail = waitForAnyElement(textFieldCandidates(app, label: "Prepare email invite"), timeout: 5)
    else {
      XCTFail("Expected device handoff plus Invite QR, share, and email controls.")
      return
    }
    assertMinimumTouchTarget(deviceLink, label: "Copy device link")
    assertMinimumTouchTarget(deviceQr, label: "Device handoff QR")
    assertMinimumTouchTarget(inviteQr, label: "Invite QR")
    assertMinimumTouchTarget(inviteShare, label: "Invite share")
    assertMinimumTouchTarget(inviteEmail, label: "Invite email")
    addScreenshotAttachment(app, name: "Portrait Invite modal")
    addTreeAttachment(app, name: "Portrait Invite modal accessibility tree")

    XCTAssertTrue(tapElement(deviceQr), "Expected the same-account device handoff QR to open.")
    XCTAssertNotNil(
      waitForAnyElement(staticTextCandidates(app, label: "Open on My Device"), timeout: 8),
      "Expected the device handoff sheet to identify itself separately from an access-granting invite.",
    )
    guard let deviceQrImage = waitForAnyElement(
      imageCandidates(app, label: "QR code to open this space on another signed-in device"),
      timeout: 5,
    ), let closeDeviceQr = waitForAnyElement(buttonCandidates(app, label: "Close QR code"), timeout: 5),
          let copyDeviceLinkFromQr = waitForAnyElement(buttonCandidates(app, label: "Copy link"), timeout: 5)
    else {
      XCTFail("Expected the device handoff QR, copy action, and close control.")
      return
    }
    XCTAssertTrue(deviceQrImage.exists, "Expected the device handoff QR image to render.")
    assertMinimumTouchTarget(closeDeviceQr, label: "Close device handoff QR")
    assertMinimumTouchTarget(copyDeviceLinkFromQr, label: "Copy device link from QR")
    addScreenshotAttachment(app, name: "Portrait same-account device handoff QR")
    addTreeAttachment(app, name: "Portrait device handoff QR accessibility tree")
    XCTAssertTrue(tapElement(closeDeviceQr), "Expected to return from the device QR to Invite.")
    XCTAssertTrue(closeInvite.waitForExistence(timeout: 8), "Expected the Invite modal after closing the device QR.")
    XCTAssertTrue(tapElement(closeInvite), "Expected to close the Invite modal without sending an invitation.")

    let runtimeButtonPredicate = NSPredicate(format: "label BEGINSWITH[c] %@", "Runtime & AI:")
    guard let runtimeButton = waitForAnyElement(
      [
        app.buttons.matching(runtimeButtonPredicate).firstMatch,
        app.webViews.buttons.matching(runtimeButtonPredicate).firstMatch,
        app.webViews.descendants(matching: .button).matching(runtimeButtonPredicate).firstMatch,
        app.webViews.descendants(matching: .any).matching(runtimeButtonPredicate).firstMatch,
      ],
      timeout: 8,
    ) else {
      XCTFail("Expected the chat composer to expose Runtime & AI.")
      return
    }
    XCTAssertTrue(tapElement(runtimeButton), "Expected to open the Runtime & AI modal.")
    guard let closeRuntime = waitForAnyElement(buttonCandidates(app, label: "Close agent menu"), timeout: 8) else {
      XCTFail("Expected the Runtime & AI modal to expose its close control.")
      return
    }
    assertMinimumTouchTarget(closeRuntime, label: "Close Runtime & AI")
    guard let agentSettings = waitForAnyElement(
      buttonCandidates(app, label: "Open settings for @octo"),
      timeout: 5,
    ), let assistantToggle = waitForAnyElement(
      switchContainingCandidates(app, label: "Enable assistant"),
      timeout: 5,
    ), let runtimeToggle = waitForAnyElement(
      switchContainingCandidates(app, label: "Per-agent runtimes"),
      timeout: 5,
    ) else {
      XCTFail("Expected Runtime & AI settings and switch controls.")
      return
    }
    assertMinimumTouchTarget(agentSettings, label: "Agent settings")
    assertMinimumTouchTarget(assistantToggle, label: "Enable assistant toggle")
    assertMinimumTouchTarget(runtimeToggle, label: "Per-agent runtimes toggle")
    addScreenshotAttachment(app, name: "Portrait Runtime and AI modal")
    addTreeAttachment(app, name: "Portrait Runtime and AI modal accessibility tree")
    XCTAssertTrue(tapElement(closeRuntime), "Expected to close Runtime & AI without changing its settings.")

    device.orientation = .landscapeLeft
    RunLoop.current.run(until: Date().addingTimeInterval(0.6))
    XCTAssertEqual(device.orientation, .landscapeLeft, "Expected the device orientation to become landscape left.")
    XCTAssertTrue(
      waitForWindowOrientation(app, landscape: true),
      "Expected the iPhone app window to rotate to landscape left.",
    )
    guard let landscapeLeftSidebarToggle = waitForAnyElement(
      buttonCandidates(app, label: "Toggle sidebar"),
      timeout: 5,
    ) else {
      XCTFail("Expected the Studio top bar to remain reachable in landscape left.")
      return
    }
    assertMinimumTouchTarget(landscapeLeftSidebarToggle, label: "Landscape-left sidebar toggle")
    XCTAssertNotNil(
      waitForAnyElement([chatInputElement(app)], timeout: 5),
      "Expected the prefilled composer to remain visible after rotating to landscape left.",
    )
    addScreenshotAttachment(app, name: "Landscape left Studio layout")
    addScreenScreenshotAttachment(name: "Landscape left full-screen layout")
    addTreeAttachment(app, name: "Landscape left Studio accessibility tree")

    device.orientation = .landscapeRight
    RunLoop.current.run(until: Date().addingTimeInterval(0.6))
    XCTAssertEqual(device.orientation, .landscapeRight, "Expected the device orientation to become landscape right.")
    XCTAssertTrue(
      waitForWindowOrientation(app, landscape: true),
      "Expected the iPhone app window to rotate to landscape right.",
    )
    guard let landscapeRightSidebarToggle = waitForAnyElement(
      buttonCandidates(app, label: "Toggle sidebar"),
      timeout: 5,
    ) else {
      XCTFail("Expected the Studio top bar to remain reachable in landscape right.")
      return
    }
    assertMinimumTouchTarget(landscapeRightSidebarToggle, label: "Landscape-right sidebar toggle")
    XCTAssertNotNil(
      waitForAnyElement([chatInputElement(app)], timeout: 5),
      "Expected the prefilled composer to remain visible after rotating to landscape right.",
    )
    addScreenshotAttachment(app, name: "Landscape right Studio layout")
    addScreenScreenshotAttachment(name: "Landscape right full-screen layout")
    addTreeAttachment(app, name: "Landscape right Studio accessibility tree")

    device.orientation = .portrait
    XCTAssertTrue(
      waitForWindowOrientation(app, landscape: false),
      "Expected the iPhone app window to return to portrait after mobile layout QA.",
    )
  }

  func testCaptureFreshAiChoiceOnboarding() throws {
    guard trimmedEnvironmentValue("INSTAFY_UI_TEST_EXPECT_FRESH_AI_ONBOARDING") == "1" else {
      throw XCTSkip("Requires an isolated, disposable account with no saved AI connection.")
    }
    guard uiTestAccountCredentials() != nil else {
      throw XCTSkip(
        "Requires INSTAFY_UI_TEST_EMAIL and INSTAFY_UI_TEST_PASSWORD for an isolated QA app identity.",
      )
    }

    let device = XCUIDevice.shared
    device.orientation = .portrait
    defer {
      device.orientation = .portrait
    }

    let app = launchApp()
    resetSessionToExpectedUiTestAccount(app)
    waitForStudio(app, timeout: 30)
    XCTAssertTrue(
      waitForWindowOrientation(app, landscape: false),
      "Expected the fresh-account iPhone onboarding flow to remain in portrait.",
    )

    if tapButtonIfVisible(app, label: "Create a new space", timeout: 8) {
      guard let spaceName = waitForAnyElement(textFieldCandidates(app, label: "Space name"), timeout: 8) else {
        addScreenshotAttachment(app, name: "Fresh onboarding before missing space name")
        addTreeAttachment(app, name: "Fresh onboarding tree before missing space name")
        XCTFail("Expected the new-user space dialog to expose a labelled name field.")
        return
      }
      assertMinimumTouchTarget(spaceName, label: "New space name")
      XCTAssertTrue(tapElement(spaceName), "Expected the new-user space name field to accept focus.")
      spaceName.typeText("iPhone onboarding QA")

      guard let createSpace = waitForAnyElement(buttonCandidates(app, label: "Create"), timeout: 8) else {
        XCTFail("Expected the new-user space dialog to expose Create.")
        return
      }
      assertMinimumTouchTarget(createSpace, label: "Create space")
      XCTAssertTrue(tapElement(createSpace), "Expected the disposable account to create its first space.")
    }

    let includedAi = waitForAnyElement(
      buttonContainingCandidates(app, label: "Start with included"),
      timeout: 30,
    )
    let connectAi = waitForAnyElement(
      buttonContainingCandidates(app, label: "Connect AI I already pay for"),
      timeout: 12,
    )
    guard let includedAi, let connectAi else {
      addScreenshotAttachment(app, name: "Fresh onboarding before missing AI choices")
      addTreeAttachment(app, name: "Fresh onboarding tree before missing AI choices")
      XCTFail("Expected a fresh iPhone account to see both explicit AI choices.")
      return
    }

    assertMinimumTouchTarget(includedAi, label: "Included Instafy AI choice")
    assertMinimumTouchTarget(connectAi, label: "Connect existing AI choice")
    XCTAssertTrue(includedAi.isHittable, "Expected included Instafy AI to be directly actionable.")
    XCTAssertTrue(connectAi.isHittable, "Expected Connect AI to be directly actionable.")

    let allowancePhrases = [
      "prompts left today",
      "included prompts each day",
      "included allowance is used",
      "No daily prompt cap",
    ]
    XCTAssertNotNil(
      waitForAnyElement(
        allowancePhrases.flatMap { phrase in
          staticTextContainingCandidates(app, label: phrase) +
            buttonContainingCandidates(app, label: phrase)
        },
        timeout: 12,
      ),
      "Expected the included-AI action to show its live allowance on the first screen.",
    )

    let webView = app.webViews.firstMatch
    XCTAssertTrue(webView.waitForExistence(timeout: 5), "Expected the fresh onboarding WebView.")
    for (element, label) in [(includedAi, "included AI"), (connectAi, "connect AI")] {
      let visibleFrame = webView.frame.intersection(element.frame)
      XCTAssertFalse(visibleFrame.isNull, "Expected the \(label) action to intersect the visible WebView.")
      XCTAssertGreaterThanOrEqual(
        visibleFrame.width,
        element.frame.width - 1,
        "Expected the \(label) action to stay within the iPhone's horizontal safe area.",
      )
      XCTAssertGreaterThanOrEqual(
        visibleFrame.height,
        element.frame.height - 1,
        "Expected the \(label) action to be fully visible without initial scrolling.",
      )
    }
    XCTAssertGreaterThanOrEqual(
      connectAi.frame.minY,
      includedAi.frame.maxY - 1,
      "Expected the two first-run AI actions to stack cleanly on the narrow iPhone viewport.",
    )
    addScreenshotAttachment(app, name: "Fresh iPhone explicit AI choices")
    addTreeAttachment(app, name: "Fresh iPhone AI choices accessibility tree")

    XCTAssertTrue(tapElement(connectAi), "Expected Connect AI to open the existing connection wizard directly.")
    XCTAssertNotNil(
      waitForAnyElement(
        staticTextCandidates(app, label: "Add AI connection") + [
          firstMatch(app.otherElements, label: "Add AI connection"),
          firstMatch(app.webViews.otherElements, label: "Add AI connection"),
          firstMatch(app.webViews.descendants(matching: .any), label: "Add AI connection"),
        ],
        timeout: 12,
      ),
      "Expected Connect AI to open the Add AI connection wizard.",
    )
    XCTAssertNotNil(
      waitForAnyElement(
        buttonContainingCandidates(app, label: "ChatGPT login") +
          buttonContainingCandidates(app, label: "DeepSeek API key"),
        timeout: 8,
      ),
      "Expected the direct connection wizard to expose its existing provider choices.",
    )
    guard let closeConnectionWizard = waitForAnyElement(buttonCandidates(app, label: "Close"), timeout: 8) else {
      XCTFail("Expected the connection wizard to expose Close.")
      return
    }
    assertMinimumTouchTarget(closeConnectionWizard, label: "Close AI connection wizard")
    addScreenshotAttachment(app, name: "Fresh iPhone AI connection wizard")
    addTreeAttachment(app, name: "Fresh iPhone AI connection wizard accessibility tree")
    XCTAssertTrue(tapElement(closeConnectionWizard), "Expected Close to return to the explicit onboarding choices.")

    guard let includedAiAfterClose = waitForAnyElement(
      buttonContainingCandidates(app, label: "Start with included"),
      timeout: 8,
    ) else {
      XCTFail("Expected the included Instafy AI choice after closing the connection wizard.")
      return
    }
    XCTAssertTrue(tapElement(includedAiAfterClose), "Expected included Instafy AI to settle first-run AI setup.")
    XCTAssertNotNil(
      waitForAnyElement(buttonCandidates(app, label: "Need ideas?"), timeout: 8),
      "Expected choosing included AI to leave only the optional ideas disclosure.",
    )
    XCTAssertNil(
      waitForAnyElement(buttonContainingCandidates(app, label: "Connect AI I already pay for"), timeout: 1),
      "Expected the required AI choice to stop repeating after the user picks included AI.",
    )
    let chatInput = chatInputElement(app)
    let keyboard = app.keyboards.firstMatch
    XCTAssertTrue(chatInput.waitForExistence(timeout: 8), "Expected the settled onboarding flow to keep the composer visible.")
    XCTAssertTrue(keyboard.waitForExistence(timeout: 8), "Expected choosing included AI to focus the composer intentionally.")
    XCTAssertLessThanOrEqual(
      chatInput.frame.maxY,
      keyboard.frame.minY + 1,
      "Expected the first-run composer to remain above the native keyboard after choosing included AI.",
    )
    addScreenshotAttachment(app, name: "Fresh iPhone after choosing included AI with keyboard")
    addTreeAttachment(app, name: "Fresh iPhone settled onboarding accessibility tree")
  }

  func testCaptureFreshChatGptDeviceCodeOnboarding() throws {
    guard trimmedEnvironmentValue("INSTAFY_UI_TEST_EXPECT_CHATGPT_DEVICE_CODE_ONBOARDING") == "1" else {
      throw XCTSkip("Requires an isolated, disposable account with no saved AI connection.")
    }
    guard uiTestAccountCredentials() != nil else {
      throw XCTSkip(
        "Requires INSTAFY_UI_TEST_EMAIL and INSTAFY_UI_TEST_PASSWORD for an isolated QA app identity.",
      )
    }

    let device = XCUIDevice.shared
    device.orientation = .portrait
    let app = launchApp()
    var pendingDeviceSessionNeedsCancellation = false
    defer {
      device.orientation = .portrait
      if pendingDeviceSessionNeedsCancellation {
        app.activate()
        if let cancel = waitForAnyElement(buttonCandidates(app, label: "Cancel"), timeout: 3) {
          _ = tapElement(cancel)
        } else if let close = waitForAnyElement(buttonCandidates(app, label: "Close"), timeout: 1) {
          _ = tapElement(close)
        }
      }
    }

    ensureLoggedInIfNeeded(app)
    waitForStudio(app, timeout: 30)
    XCTAssertTrue(
      waitForWindowOrientation(app, landscape: false),
      "Expected ChatGPT device-code onboarding to begin in portrait.",
    )

    if tapButtonIfVisible(app, label: "Create a new space", timeout: 8) {
      guard let spaceName = waitForAnyElement(textFieldCandidates(app, label: "Space name"), timeout: 8) else {
        XCTFail("Expected the disposable account's first-space dialog to expose Space name.")
        return
      }
      XCTAssertTrue(tapElement(spaceName), "Expected the disposable space name field to accept focus.")
      spaceName.typeText("iPhone ChatGPT device-code QA")

      guard let createSpace = waitForAnyElement(buttonCandidates(app, label: "Create"), timeout: 8) else {
        XCTFail("Expected the disposable account's first-space dialog to expose Create.")
        return
      }
      assertMinimumTouchTarget(createSpace, label: "Create disposable ChatGPT QA space")
      XCTAssertTrue(tapElement(createSpace), "Expected the disposable account to create its first space.")
    }

    guard let connectAi = waitForAnyElement(
      buttonContainingCandidates(app, label: "Connect AI I already pay for"),
      timeout: 30,
    ) else {
      XCTFail("Expected a fresh disposable account to expose Connect AI I already pay for.")
      return
    }
    assertMinimumTouchTarget(connectAi, label: "Connect existing AI from fresh onboarding")
    XCTAssertTrue(tapElement(connectAi), "Expected Connect AI to open the connection wizard.")

    guard let chatGptChoice = waitForAnyElement(
      buttonContainingCandidates(app, label: "ChatGPT login"),
      timeout: 12,
    ) else {
      XCTFail("Expected the connection wizard to expose ChatGPT login.")
      return
    }
    assertMinimumTouchTarget(chatGptChoice, label: "ChatGPT provider choice")
    XCTAssertTrue(chatGptChoice.isHittable, "Expected ChatGPT login to be directly actionable.")
    XCTAssertTrue(tapElement(chatGptChoice), "Expected ChatGPT login to open its device-code prerequisite.")

    let webView = app.webViews.firstMatch
    XCTAssertTrue(webView.waitForExistence(timeout: 5), "Expected the ChatGPT prerequisite inside the iPhone WebView.")
    XCTAssertNotNil(
      waitForAnyElement(staticTextContainingCandidates(app, label: "Before you get a code"), timeout: 8),
      "Expected device-code onboarding to explain the prerequisite before creating a code.",
    )
    XCTAssertNotNil(
      waitForAnyElement(staticTextContainingCandidates(app, label: "Settings → Security"), timeout: 5),
      "Expected personal ChatGPT users to be directed to Settings → Security.",
    )
    XCTAssertNotNil(
      waitForAnyElement(staticTextContainingCandidates(app, label: "device-code authorization"), timeout: 5),
      "Expected the required ChatGPT setting to be named explicitly.",
    )
    XCTAssertNotNil(
      waitForAnyElement(staticTextContainingCandidates(app, label: "workspace admin"), timeout: 5),
      "Expected managed-workspace users to see the administrator prerequisite.",
    )
    XCTAssertNotNil(
      waitForAnyElement(staticTextContainingCandidates(app, label: "workspace permissions"), timeout: 5),
      "Expected managed-workspace users to be told where the permission lives.",
    )

    guard let setupHelp = waitForAnyElement(
      buttonContainingCandidates(app, label: "OpenAI setup help"),
      timeout: 5,
    ) else {
      XCTFail("Expected the prerequisite to link to official OpenAI setup help.")
      return
    }
    assertMinimumTouchTarget(setupHelp, label: "OpenAI setup help")
    assertFullyVisibleInWebView(setupHelp, webView: webView, label: "OpenAI setup help")

    guard let generateCode = waitForAnyElement(
      buttonContainingCandidates(app, label: "I’ve enabled it — get a code"),
      timeout: 8,
    ) else {
      XCTFail("Expected device-code onboarding to require explicit confirmation before generating a code.")
      return
    }
    assertMinimumTouchTarget(generateCode, label: "Generate ChatGPT device code")
    assertFullyVisibleInWebView(generateCode, webView: webView, label: "Generate ChatGPT device code")
    XCTAssertTrue(generateCode.isHittable, "Expected the device-code confirmation to be directly actionable.")

    guard let prerequisiteBack = waitForAnyElement(buttonCandidates(app, label: "Back"), timeout: 5),
          let prerequisiteClose = waitForAnyElement(buttonCandidates(app, label: "Close"), timeout: 5)
    else {
      XCTFail("Expected the ChatGPT prerequisite to expose Back and Close.")
      return
    }
    assertMinimumTouchTarget(prerequisiteBack, label: "ChatGPT prerequisite Back")
    assertMinimumTouchTarget(prerequisiteClose, label: "ChatGPT prerequisite Close")
    XCTAssertFalse(app.keyboards.firstMatch.exists, "Expected device-code setup not to summon the native keyboard.")
    addScreenshotAttachment(app, name: "Fresh iPhone ChatGPT device-code prerequisite")
    addTreeAttachment(app, name: "Fresh iPhone ChatGPT device-code prerequisite accessibility tree")

    XCTAssertTrue(tapElement(generateCode), "Expected confirmation to request a one-time OpenAI device code.")
    pendingDeviceSessionNeedsCancellation = true

    XCTAssertNotNil(
      waitForAnyElement(staticTextCandidates(app, label: "Device login"), timeout: 15),
      "Expected a successful device-code request to expose Device login.",
    )
    guard let deviceCode = waitForAnyElement(deviceCodeCandidates(app), timeout: 15) else {
      XCTFail("Expected OpenAI to issue a visible hyphenated one-time device code.")
      return
    }
    XCTAssertGreaterThanOrEqual(deviceCode.label.count, 7, "Expected a substantive one-time device code.")

    guard let copyCode = waitForAnyElement(buttonCandidates(app, label: "Copy device code"), timeout: 8),
          let openTrustedHost = waitForAnyElement(buttonCandidates(app, label: "Open auth.openai.com"), timeout: 8),
          let cancelDeviceLogin = waitForAnyElement(buttonCandidates(app, label: "Cancel"), timeout: 8)
    else {
      XCTFail("Expected device login to expose Copy, trusted-host Open, and Cancel controls.")
      return
    }
    for (control, label) in [
      (copyCode, "Copy device code"),
      (openTrustedHost, "Open trusted OpenAI host"),
      (cancelDeviceLogin, "Cancel device login"),
    ] {
      assertMinimumTouchTarget(control, label: label)
      assertFullyVisibleInWebView(control, webView: webView, label: label)
      XCTAssertTrue(control.isHittable, "Expected \(label) to be directly actionable.")
    }

    guard let countdown = waitForAnyElement(
      staticTextContainingCandidates(app, label: "code expires in"),
      timeout: 8,
    ) else {
      XCTFail("Expected the one-time code to expose an expiry countdown.")
      return
    }
    XCTAssertNotNil(
      countdown.label.range(of: #"code expires in [0-9]+:[0-5][0-9]"#, options: .regularExpression),
      "Expected the expiry countdown to use a readable minutes:seconds value.",
    )
    XCTAssertNotNil(
      waitForAnyElement(staticTextContainingCandidates(app, label: "Only enter this code at"), timeout: 5),
      "Expected a device-code phishing warning.",
    )
    XCTAssertNotNil(
      waitForAnyElement(staticTextContainingCandidates(app, label: "never ask you to paste your ChatGPT password"), timeout: 5),
      "Expected the warning to distinguish Instafy from the trusted OpenAI login page.",
    )
    XCTAssertFalse(app.keyboards.firstMatch.exists, "Expected the device-code state not to summon the native keyboard.")

    // Do not open the OpenAI page or authorize any ChatGPT account. Cancelling
    // here verifies the complete safe boundary of this physical-device smoke.
    XCTAssertTrue(tapElement(cancelDeviceLogin), "Expected Cancel to terminate the pending device session.")
    XCTAssertNotNil(
      waitForAnyElement(staticTextContainingCandidates(app, label: "Before you get a code"), timeout: 12),
      "Expected cancellation to return to the prerequisite instead of leaving a waiting session behind.",
    )
    XCTAssertNil(
      waitForAnyElement(deviceCodeCandidates(app), timeout: 1),
      "Expected cancellation to remove the one-time device code from the UI.",
    )
    pendingDeviceSessionNeedsCancellation = false

    guard let closeConnectionWizard = waitForAnyElement(buttonCandidates(app, label: "Close"), timeout: 5) else {
      XCTFail("Expected Close after cancelling the device-code flow.")
      return
    }
    XCTAssertTrue(tapElement(closeConnectionWizard), "Expected Close to return to fresh onboarding.")
    XCTAssertNotNil(
      waitForAnyElement(buttonContainingCandidates(app, label: "Connect AI I already pay for"), timeout: 8),
      "Expected cancellation not to settle onboarding or create a ChatGPT connection.",
    )
    addScreenshotAttachment(app, name: "Fresh iPhone after cancelling ChatGPT device-code onboarding")
  }

  func testPhysicalSharedChatTwoPhones() throws {
    guard trimmedEnvironmentValue("INSTAFY_UI_TEST_EXPECT_SHARED_CHAT") == "1" else {
      throw XCTSkip("Requires an orchestrated Android + iPhone shared-chat run.")
    }
    guard uiTestAccountCredentials() != nil else {
      throw XCTSkip("Requires INSTAFY_UI_TEST_EMAIL and INSTAFY_UI_TEST_PASSWORD.")
    }
    guard requestedProjectNameForUiTest() != nil || projectIdPrefixForUiTest() != nil else {
      throw XCTSkip("Requires INSTAFY_UI_TEST_PROJECT_ID or INSTAFY_UI_TEST_PROJECT_NAME.")
    }
    guard let conversationTitle = trimmedEnvironmentValue("INSTAFY_UI_TEST_CONVERSATION_TITLE"),
          let incomingText = trimmedEnvironmentValue("INSTAFY_UI_TEST_SHARED_CHAT_INCOMING_TEXT"),
          let replyText = trimmedEnvironmentValue("INSTAFY_UI_TEST_SHARED_CHAT_REPLY_TEXT")
    else {
      throw XCTSkip(
        "Requires INSTAFY_UI_TEST_CONVERSATION_TITLE, INSTAFY_UI_TEST_SHARED_CHAT_INCOMING_TEXT, and INSTAFY_UI_TEST_SHARED_CHAT_REPLY_TEXT.",
      )
    }

    let device = XCUIDevice.shared
    device.orientation = .portrait
    defer {
      device.orientation = .portrait
    }

    let app = launchApp()
    ensureLoggedInIfNeeded(app)
    waitForStudio(app, timeout: 30)
    ensureRequestedProjectIsOpenIfNeeded(app)
    waitForStudio(app, timeout: 30)
    guard ensureRequestedConversationIsOpenIfNeeded(
      app,
      title: conversationTitle,
      forbidAiOnboardingFlash: true,
    ) else {
      return
    }
    XCTAssertTrue(
      waitForWindowOrientation(app, landscape: false),
      "Expected the two-phone shared chat to remain in portrait.",
    )

    let webView = app.webViews.firstMatch
    XCTAssertTrue(webView.waitForExistence(timeout: 8), "Expected the shared chat inside the iPhone WebView.")
    let chatInput = chatInputElement(app)
    XCTAssertTrue(chatInput.waitForExistence(timeout: 12), "Expected the shared-chat composer on iPhone.")
    assertFullyVisibleInWebView(chatInput, webView: webView, label: "Shared-chat composer")
    XCTAssertNil(
      waitForAnyElement(staticTextContainingCandidates(app, label: "Choose your AI"), timeout: 1),
      "Expected a known human-only shared conversation not to flash the large AI onboarding card.",
    )
    XCTAssertTrue(
      waitForExactStaticTextCount(app, text: incomingText, count: 0, timeout: 1),
      "Expected the orchestrated Android message text to be unique and absent before READY.",
    )
    XCTAssertTrue(
      waitForExactStaticTextCount(app, text: replyText, count: 0, timeout: 1),
      "Expected the orchestrated iPhone reply text to be unique and absent before READY.",
    )

    let controllerId = trimmedEnvironmentValue("INSTAFY_UI_TEST_CONVERSATION_CONTROLLER_ID") ?? "unknown"
    NSLog("INSTAFY_IOS_SHARED_CHAT_READY conversation=\(controllerId)")
    addScreenshotAttachment(app, name: "Shared chat ready before Android message")

    if let expectedPeerTypingText = trimmedEnvironmentValue("INSTAFY_UI_TEST_SHARED_CHAT_PEER_TYPING_TEXT") {
      XCTAssertTrue(
        waitForTextContaining(app, expectedPeerTypingText, timeout: sharedChatTimeout()),
        "Expected the iPhone to show the Android peer typing indicator before the message arrived.",
      )
      NSLog("INSTAFY_IOS_SHARED_CHAT_PEER_TYPING_SEEN")
      addScreenshotAttachment(app, name: "Shared chat Android peer typing on iPhone")
    }

    XCTAssertTrue(
      waitForExactStaticTextCount(app, text: incomingText, count: 1, timeout: sharedChatTimeout()),
      "Expected the exact Android message to arrive once through live shared-chat updates.",
    )
    let incomingElements = exactStaticTextElements(app, text: incomingText)
    XCTAssertEqual(incomingElements.count, 1, "Expected the Android message to render exactly once on iPhone.")
    guard let incomingMessage = incomingElements.first else {
      XCTFail("Expected the exact Android message element after the live update.")
      return
    }
    assertFullyVisibleInWebView(incomingMessage, webView: webView, label: "Incoming Android message")
    XCTAssertLessThanOrEqual(
      incomingMessage.frame.midX,
      webView.frame.midX + 24,
      "Expected the teammate's incoming message to retain the left-side collaboration posture.",
    )
    if let peerLabel = trimmedEnvironmentValue("INSTAFY_UI_TEST_SHARED_CHAT_PEER_LABEL") {
      XCTAssertTrue(
        waitForTextContaining(app, peerLabel, timeout: 10),
        "Expected the incoming Android message to expose the teammate identity.",
      )
    }
    addScreenshotAttachment(app, name: "Shared chat after Android message arrived")
    addTreeAttachment(app, name: "Shared chat accessibility tree after Android message arrived")

    chatInput.tap()
    let currentDraft = ((chatInput.value as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !currentDraft.isEmpty,
       currentDraft != "Ask Octo",
       currentDraft != "Ask for something…"
    {
      chatInput.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: currentDraft.count))
    }
    chatInput.typeText(replyText)

    let keyboard = app.keyboards.firstMatch
    XCTAssertTrue(keyboard.waitForExistence(timeout: 8), "Expected the native iPhone keyboard while composing a reply.")
    RunLoop.current.run(until: Date().addingTimeInterval(0.4))
    XCTAssertLessThanOrEqual(
      chatInput.frame.maxY,
      keyboard.frame.minY + 1,
      "Expected the shared-chat composer to stay above the native keyboard.",
    )
    assertFullyVisibleInWebView(chatInput, webView: webView, label: "Focused shared-chat composer")

    guard let composerActions = waitForAnyElement(
      buttonCandidates(app, label: "Open composer actions"),
      timeout: 8,
    ) else {
      XCTFail("Expected the shared-chat composer action control while the keyboard is open.")
      return
    }
    assertMinimumTouchTarget(composerActions, label: "Shared-chat composer actions")

    let sendControl = chatSendControlElement(app)
    XCTAssertTrue(sendControl.waitForExistence(timeout: 8), "Expected the iPhone shared-chat send control.")
    XCTAssertTrue(sendControl.isEnabled, "Expected the send control to enable for the exact iPhone reply.")
    assertMinimumTouchTarget(sendControl, label: "Shared-chat send")
    assertFullyVisibleInWebView(sendControl, webView: webView, label: "Shared-chat send")
    addScreenshotAttachment(app, name: "Shared chat iPhone reply with native keyboard")

    NSLog("INSTAFY_IOS_SHARED_CHAT_TYPING")
    let typingHold = sharedChatTypingHoldDuration()
    if typingHold > 0 {
      RunLoop.current.run(until: Date().addingTimeInterval(typingHold))
    }
    XCTAssertTrue(tapElement(sendControl), "Expected the iPhone send control to submit the exact reply.")
    NSLog("INSTAFY_IOS_SHARED_CHAT_SENT")

    XCTAssertTrue(
      waitForExactStaticTextCount(app, text: replyText, count: 1, timeout: 20),
      "Expected the exact iPhone reply to render once after sending.",
    )
    let replyElements = exactStaticTextElements(app, text: replyText)
    XCTAssertEqual(replyElements.count, 1, "Expected the iPhone reply to render exactly once.")
    if let replyMessage = replyElements.first {
      assertFullyVisibleInWebView(replyMessage, webView: webView, label: "Sent iPhone reply")
      XCTAssertGreaterThanOrEqual(
        replyMessage.frame.midX,
        webView.frame.midX - 24,
        "Expected the iPhone's own reply to retain the right-side collaboration posture.",
      )
    }

    if keyboard.exists {
      if let replyMessage = replyElements.first {
        XCTAssertTrue(tapElement(replyMessage), "Expected a message tap to dismiss the iPhone keyboard.")
      }
      let keyboardDismissDeadline = Date().addingTimeInterval(5)
      while keyboard.exists && Date() < keyboardDismissDeadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
      }
      XCTAssertFalse(keyboard.exists, "Expected the native keyboard to dismiss after the shared-chat send.")
    }

    if let finalIncomingText = trimmedEnvironmentValue("INSTAFY_UI_TEST_SHARED_CHAT_FINAL_INCOMING_TEXT") {
      XCTAssertTrue(
        waitForExactStaticTextCount(app, text: finalIncomingText, count: 1, timeout: sharedChatTimeout()),
        "Expected the exact post-reply Android confirmation to arrive once on iPhone.",
      )
      XCTAssertEqual(
        exactStaticTextElements(app, text: finalIncomingText).count,
        1,
        "Expected the post-reply Android confirmation not to duplicate.",
      )
      NSLog("INSTAFY_IOS_SHARED_CHAT_FINAL_INCOMING_SEEN")
    }

    guard let conversationLog = waitForAnyElement(
      requestedConversationLogCandidates(app, title: conversationTitle),
      timeout: 8,
    ) else {
      XCTFail("Expected an accessible shared-chat scroll log for scroll QA.")
      return
    }
    let composerFrameBeforeScroll = chatInput.frame
    conversationLog.swipeUp()
    RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    XCTAssertEqual(
      chatInput.frame.minY,
      composerFrameBeforeScroll.minY,
      accuracy: 3,
      "Expected message scrolling not to move the fixed iPhone composer.",
    )
    assertFullyVisibleInWebView(chatInput, webView: webView, label: "Shared-chat composer after upward scroll")
    conversationLog.swipeDown()
    RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    XCTAssertEqual(
      chatInput.frame.minY,
      composerFrameBeforeScroll.minY,
      accuracy: 3,
      "Expected reverse message scrolling to keep the fixed iPhone composer stable.",
    )
    assertFullyVisibleInWebView(chatInput, webView: webView, label: "Shared-chat composer after reverse scroll")

    addScreenshotAttachment(app, name: "Shared chat final two-phone state on iPhone")
    addTreeAttachment(app, name: "Shared chat final two-phone accessibility tree on iPhone")
    NSLog("INSTAFY_IOS_SHARED_CHAT_DONE")
  }

  func testPhysicalChatGptThenSharedChatSingleAutomationSession() throws {
    // A passcode-protected physical device may require its passcode whenever a
    // new UI-automation session starts. Keep these related physical checks in
    // one XCTest session so the operator unlocks once, not once per scenario.
    try testCaptureFreshChatGptDeviceCodeOnboarding()
    try testPhysicalSharedChatTwoPhones()
  }

  func testDiagnosticsCanSimulateShakeWhenStudioIsAvailable() throws {
    let app = launchApp()

    if app.staticTexts["Log in or sign up"].waitForExistence(timeout: 2) {
      throw XCTSkip("Requires a signed-in or auth-disabled studio state.")
    }

    let sidebarToggle = app.buttons["Toggle sidebar"]
    XCTAssertTrue(sidebarToggle.waitForExistence(timeout: 10))
    sidebarToggle.tap()

    let profileFooter = app.otherElements["DE dev@instafy.local"]
    XCTAssertTrue(profileFooter.waitForExistence(timeout: 5))
    profileFooter.tap()

    let diagnosticsItem = app.menuItems["Diagnostics"]
    XCTAssertTrue(diagnosticsItem.waitForExistence(timeout: 5))
    diagnosticsItem.tap()

    let simulateShakeButton = app.buttons["Simulate shake event"]
    XCTAssertTrue(simulateShakeButton.waitForExistence(timeout: 5))
    simulateShakeButton.tap()

    let reportIssueTitle = app.staticTexts["Report issue"]
    XCTAssertTrue(reportIssueTitle.waitForExistence(timeout: 10))

    addScreenshotAttachment(app, name: "Screen after simulated shake")
    addTreeAttachment(app, name: "Accessibility tree after simulated shake")
  }

  func testCaptureCurrentRunningState() throws {
    let app = activateApp()
    waitForStudio(app)

    addScreenshotAttachment(app, name: "Screen after attaching to running app")
    addTreeAttachment(app, name: "Accessibility tree after attaching to running app")
  }

  func testCaptureAutomationProbe() throws {
    let app = launchApp()

    let readyMarkers = [
      app.webViews.firstMatch,
      app.buttons["Toggle sidebar"],
      app.buttons["Assistant"],
      app.buttons["Open chat"],
      app.buttons["Extensions"],
      app.buttons["Log in"],
      app.staticTexts["Log in or sign up"],
      app.textFields.firstMatch,
      app.secureTextFields.firstMatch,
    ]
    XCTAssertNotNil(
      waitForAnyElement(readyMarkers, timeout: 20),
      "Expected the iPhone app to reach either the Studio shell or the auth surface during the automation probe.",
    )

    addScreenshotAttachment(app, name: "Screen after automation probe")
    addTreeAttachment(app, name: "Accessibility tree after automation probe")
  }

  func testCaptureExtensionsPanel() throws {
    let app = launchApp()
    waitForStudio(app)

    openExtensions(app)

    addScreenshotAttachment(app, name: "Screen after opening extensions")
    addTreeAttachment(app, name: "Accessibility tree after opening extensions")
  }

  func testCaptureCameraExtensionFlow() throws {
    let app = launchApp()
    ensureLoggedInIfNeeded(app)
    waitForStudio(app)
    openExtensions(app)

    let cameraLabel = app.staticTexts["Camera"]
    XCTAssertTrue(cameraLabel.waitForExistence(timeout: 10))

    _ = tapFirstVisibleButton(
      app,
      labels: cameraAttachButtonLabels(),
      timeout: 5,
    )

    let openedManageSurface = openCameraManageSurfaceIfNeeded(app, timeout: 8)

    if !openedManageSurface {
      addScreenshotAttachment(app, name: "Screen after camera attach")
      addTreeAttachment(app, name: "Accessibility tree after camera attach")
    }

    XCTAssertTrue(
      openedManageSurface,
      "Expected Camera row controls to expose Manage, Setup, or an already-open setup surface.",
    )

    let restrictedCameraSummary = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS[c] %@", "restricted on this iPhone"),
    ).firstMatch
    XCTAssertFalse(
      restrictedCameraSummary.waitForExistence(timeout: 2),
      "Camera access is restricted on this iPhone outside Instafy settings. Disable Screen Time or device policy restrictions for Camera, then rerun the smoke.",
    )

    let missingPluginSummary = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS[c] %@", "plugin is not implemented on ios"),
    ).firstMatch
    XCTAssertFalse(
      missingPluginSummary.waitForExistence(timeout: 1),
      "InstafyCameraExtension is not registered in the iPhone app, so Camera cannot work on iOS yet.",
    )

    let baselineLatestCaptureLabels = currentLatestCaptureLabels(app)
    _ = selectAlternateCameraLensIfNeeded(
      app,
      baselineLatestCaptureLabels: baselineLatestCaptureLabels,
    )
    let capturePhotoButton = waitForCameraCaptureButton(app)
    XCTAssertNotNil(capturePhotoButton, "Expected Camera manage controls to show the test-photo action.")
    capturePhotoButton?.tap()

    allowSystemCameraPermissionIfNeeded(app)
    capturePhotoInSystemCamera(
      baselineLatestCaptureLabels: baselineLatestCaptureLabels,
    )

    XCTAssertTrue(
      waitForLatestCaptureRecorded(app, baselineLabels: baselineLatestCaptureLabels, timeout: 30) ||
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "ready from the")).firstMatch.waitForExistence(timeout: 5),
      "Expected Camera to record a latest capture after taking a photo on iPhone.",
    )

    addScreenshotAttachment(app, name: "Screen after Camera capture")
    addTreeAttachment(app, name: "Accessibility tree after Camera capture")
  }

  func testCaptureRemoteCameraProviderRequestFlow() throws {
    let app = attachToRunningApp()
    waitForStudio(app)
    ensureLoggedInIfNeeded(app)
    waitForStudio(app)
    ensureRequestedProjectIsOpenIfNeeded(app)
    waitForStudio(app)
    openExtensions(app)

    let cameraLabel = app.staticTexts["Camera"]
    if !cameraLabel.waitForExistence(timeout: 5) {
      NSLog("INSTAFY_IOS_CAMERA_ROW_MISSING_BEFORE_RECOVERY")
      addScreenshotAttachment(app, name: "Screen before Camera recovery")
      addTreeAttachment(app, name: "Accessibility tree before Camera recovery")
      if app.staticTexts["Space not found"].exists {
        NSLog("INSTAFY_IOS_ACCESS_BLOCKED_RECOVERY")
        resetSessionToExpectedUiTestAccount(app)
      }
      ensureRequestedProjectIsOpenIfNeeded(app)
      waitForStudio(app)
      openExtensions(app)
    }
    XCTAssertTrue(cameraLabel.waitForExistence(timeout: 10))

    _ = tapFirstVisibleButton(
      app,
      labels: cameraAttachButtonLabels(),
      timeout: 5,
    )

    var openedManageSurface = openCameraManageSurfaceIfNeeded(app, timeout: 8)

    if !openedManageSurface {
      NSLog("INSTAFY_IOS_REMOTE_CAMERA_MANAGE_RECOVERY")
      waitForStudio(app)
      openExtensions(app)
      openedManageSurface = openCameraManageSurfaceIfNeeded(app, timeout: 10)
    }

    if !openedManageSurface {
      addScreenshotAttachment(app, name: "Screen before remote Camera manage surface assert")
      addTreeAttachment(app, name: "Accessibility tree before remote Camera manage surface assert")
    }

    XCTAssertTrue(
      openedManageSurface,
      "Expected Camera row controls to expose Manage, Setup, or an already-open setup surface before waiting for a remote request.",
    )

    let baselineLatestCaptureLabels = currentLatestCaptureLabels(app)
    _ = selectAlternateCameraLensIfNeeded(
      app,
      baselineLatestCaptureLabels: baselineLatestCaptureLabels,
    )
    let attachedCurrentDevice =
      tapFirstVisibleButton(
        app,
        labels: cameraAttachButtonLabels(),
        timeout: 5,
      )
    if attachedCurrentDevice {
      NSLog("INSTAFY_IOS_REMOTE_CAMERA_ATTACHED_THIS_DEVICE")
      RunLoop.current.run(until: Date().addingTimeInterval(1.0))
      _ = openCameraManageSurfaceIfNeeded(app, timeout: 8)
      _ = waitForCameraManageReadyState(app, timeout: 20)
    }

    var capturePhotoButton = waitForCameraCaptureButton(app, timeout: 45)
    if capturePhotoButton == nil {
      NSLog("INSTAFY_IOS_REMOTE_CAMERA_CAPTURE_RECOVERY")
      _ = reopenCameraManageSurface(app, timeout: 10)
      _ = waitForCameraManageReadyState(app, timeout: 15)
      capturePhotoButton = waitForCameraCaptureButton(app, timeout: 20)
    }
    if capturePhotoButton == nil {
      addScreenshotAttachment(app, name: "Screen before remote Camera capture-photo assert")
      addTreeAttachment(app, name: "Accessibility tree before remote Camera capture-photo assert")
    }
    XCTAssertNotNil(
      capturePhotoButton,
      "Expected Camera manage controls to show the test-photo action before remote capture waits begin.",
    )

    logTriClientMarker(Self.triClientReadyMarker)
    capturePhotoInSystemCamera(
      timeout: 180,
      baselineLatestCaptureLabels: baselineLatestCaptureLabels,
    )
    logTriClientMarker(Self.triClientCaptureMarker)

    XCTAssertTrue(
      waitForLatestCaptureRecorded(app, baselineLabels: baselineLatestCaptureLabels, timeout: 30) ||
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "ready from the")).firstMatch.waitForExistence(timeout: 5),
      "Expected Camera to record a latest capture after completing the remote photo request on iPhone.",
    )

    addScreenshotAttachment(app, name: "Screen after remote Camera capture")
    addTreeAttachment(app, name: "Accessibility tree after remote Camera capture")
  }

  func testConsumeRemoteDesktopCameraProviderRequestFlow() throws {
    let app = attachToRunningApp()
    waitForStudio(app)
    ensureLoggedInIfNeeded(app)
    waitForStudio(app)
    ensureRequestedProjectIsOpenIfNeeded(app)
    waitForStudio(app)
    openExtensions(app)

    let cameraLabel = app.staticTexts["Camera"]
    if !cameraLabel.waitForExistence(timeout: 5) {
      NSLog("INSTAFY_IOS_REVERSE_CAMERA_ROW_MISSING_BEFORE_RECOVERY")
      addScreenshotAttachment(app, name: "Screen before reverse Camera recovery")
      addTreeAttachment(app, name: "Accessibility tree before reverse Camera recovery")
      ensureRequestedProjectIsOpenIfNeeded(app)
      waitForStudio(app)
      openExtensions(app)
    }
    XCTAssertTrue(cameraLabel.waitForExistence(timeout: 10))

    var openedManageSurface = openCameraManageSurfaceIfNeeded(app, timeout: 12)
    if !openedManageSurface {
      NSLog("INSTAFY_IOS_REVERSE_CAMERA_MANAGE_RECOVERY")
      waitForStudio(app)
      openExtensions(app)
      openedManageSurface = openCameraManageSurfaceIfNeeded(app, timeout: 12)
    }
    XCTAssertTrue(
      openedManageSurface,
      "Expected Camera row controls to expose Manage for the attached desktop webcam provider.",
    )
    _ = waitForCameraManageReadyState(app, timeout: 20)

    let expectedDeviceText =
      (ProcessInfo.processInfo.environment["INSTAFY_UI_TEST_EXPECTED_CAMERA_DEVICE_TEXT"] ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if !expectedDeviceText.isEmpty {
      XCTAssertTrue(
        waitForTextContaining(app, expectedDeviceText, timeout: 30),
        "Expected Camera manage controls to mention the selected desktop webcam provider.",
      )
    }

    addScreenshotAttachment(app, name: "Screen before phone requests desktop Camera capture")
    addTreeAttachment(app, name: "Accessibility tree before phone requests desktop Camera capture")

    openChat(app)

    let prompt =
      (ProcessInfo.processInfo.environment["INSTAFY_UI_TEST_CAMERA_PROMPT"] ?? "@octo take a photo")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let chatInput = chatInputElement(app)
    XCTAssertTrue(chatInput.waitForExistence(timeout: 10), "Expected the chat input to be visible.")
    chatInput.tap()
    chatInput.typeText(prompt)

    let sendControl = chatSendControlElement(app)
    XCTAssertTrue(sendControl.waitForExistence(timeout: 5), "Expected the mobile send control to be visible.")

    logTriClientMarker(Self.triClientReadyMarker)
    sendControl.tap()

    let expectedResultText =
      (ProcessInfo.processInfo.environment["INSTAFY_UI_TEST_EXPECTED_CAMERA_RESULT_TEXT"] ?? "captured a rear photo")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    XCTAssertTrue(
      waitForTextContaining(app, expectedResultText, timeout: 120),
      "Expected phone chat to receive the desktop webcam capture result.",
    )
    if waitForTextContaining(app, "is capturing", timeout: 1) ||
      waitForTextContaining(app, "Waiting on", timeout: 1) {
      addScreenshotAttachment(app, name: "Screen with stale desktop Camera capture status")
      addTreeAttachment(app, name: "Accessibility tree with stale desktop Camera capture status")
      XCTFail("Expected final phone chat result not to keep stale Camera capture status text.")
    }

    logTriClientMarker(Self.triClientCaptureMarker)
    addScreenshotAttachment(app, name: "Screen after phone received desktop Camera capture")
    addTreeAttachment(app, name: "Accessibility tree after phone received desktop Camera capture")
  }

}
