import AppKit
import XCTest
@testable import ComputerUseHost
@testable import HostCore

/// 设置窗口的布局检查：两种语言下每个分区都放得进固定宽度，且没有歧义布局。
/// 设置 CU_SETTINGS_SNAPSHOTS=<目录> 时把每个分区渲染成 PNG，便于人工检查。
final class SettingsLayoutTests: XCTestCase {
    private var original = HostLanguage.current

    override func setUp() {
        _ = NSApplication.shared
        original = HostLanguage.current
    }

    override func tearDown() {
        HostLanguage.current = original
    }

    func testSixPanesInToolbarOrderWithAFixedTitle() {
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let controller = SettingsWindowController(context: FakeContext())
            XCTAssertEqual(controller.tabs.tabViewItems.map(\.label), SettingsPane.allCases.map(\.title))
            XCTAssertTrue(controller.tabs.tabViewItems.allSatisfy { $0.image != nil }, "Every pane needs a toolbar symbol")
            XCTAssertEqual(controller.window?.title, L10n.text(.settingsTitle, language: language))
            controller.tabs.select(.updates)
            XCTAssertEqual(controller.window?.title, L10n.text(.settingsTitle, language: language))
        }
    }

    func testReleaseNotesDropMarkdownHeadingsAndBoldMarkers() {
        XCTAssertEqual(UpdatesPane.readable("## Computer Use v0.5.0\n\n- **新增**：设置窗口\n#tag 保留"),
                       "Computer Use v0.5.0\n\n- 新增：设置窗口\n#tag 保留")
    }

    func testPersistedPauseCanBeResumedBeforeRuntimeStarts() throws {
        let context = FakeContext()
        context.isRunning = false
        context.serviceState = .paused
        let pane = StatusPane(context: context)
        _ = pane.view
        pane.refresh()
        let resume = try XCTUnwrap(Self.descendants(pane.view).compactMap { $0 as? NSButton }
            .first { $0.title == tr(.menuResume) })
        XCTAssertTrue(resume.isEnabled)
        resume.performClick(nil)
        XCTAssertEqual(context.resumeCount, 1)
    }

    func testConnectProfileDrivesPreviewAndInvalidNamesDisableArtifacts() throws {
        let suite = "ConnectPaneTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let context = FakeContext()
        var calls = [[String]]()
        let access = ConnectAccess(paths: context.paths, defaults: defaults) { arguments, completion in
            calls.append(arguments)
            completion(.failure(.unavailable))
        }
        let pane = ConnectPane(context: context, access: access)
        _ = pane.view
        pane.refresh()
        pane.refresh()
        XCTAssertTrue(calls.isEmpty, "The primary prompt flow does not need profile preflight")
        let advanced = try XCTUnwrap(Self.descendants(pane.view).compactMap { $0 as? NSButton }
            .first { $0.identifier?.rawValue == "connect-advanced-toggle" })
        XCTAssertEqual(advanced.state, .off)
        advanced.performClick(nil)
        let advancedForm = try XCTUnwrap(Self.descendants(pane.view).first { $0.identifier?.rawValue == "connect-advanced" })
        XCTAssertFalse(advancedForm.isHidden)
        XCTAssertEqual(calls, [["preflight", "--profile", "default"]])
        let profile = try XCTUnwrap(Self.descendants(pane.view).compactMap { $0 as? NSComboBox }.first)
        let preview = try XCTUnwrap(Self.descendants(pane.view).compactMap { $0 as? NSTextView }.first)
        let buttons = Self.descendants(pane.view).compactMap { $0 as? NSButton }
        profile.stringValue = "work-agent"
        pane.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: profile))
        XCTAssertEqual(access.selectedProfile, "work-agent")
        XCTAssertEqual(preview.string, ConnectAccess.pairCommand(paths: context.paths, profile: "work-agent"))
        profile.stringValue = "../credentials"
        pane.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: profile))
        XCTAssertTrue(preview.string.isEmpty)
        XCTAssertEqual(access.selectedProfile, "work-agent")
        let artifactKeys: [L10nKey] = [.connectCopyPair, .connectCopy, .connectCopyPrompt]
        for key in artifactKeys {
            XCTAssertFalse(try XCTUnwrap(buttons.first { $0.title == tr(key) }).isEnabled)
        }
        XCTAssertEqual(calls.count, 1, "Editing or timer refresh must not spawn repeated CLI tasks")
        advanced.performClick(nil)
        XCTAssertTrue(advancedForm.isHidden)
        XCTAssertEqual(access.selectedProfile, "work-agent", "Collapsing advanced access preserves the shared profile")
    }

    func testConnectPrimaryPromptAndAdvancedLayoutFitBothLanguages() throws {
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let context = FakeContext()
            let access = ConnectAccess(paths: context.paths) { _, completion in completion(.failure(.unavailable)) }
            let pane = ConnectPane(context: context, access: access)
            _ = pane.view
            let buttons = Self.descendants(pane.view).compactMap { $0 as? NSButton }
            XCTAssertEqual(buttons.filter { $0.title == tr(.connectCopyPrompt) }.count, 1)
            let advanced = try XCTUnwrap(buttons.first { $0.identifier?.rawValue == "connect-advanced-toggle" })
            for expanded in [false, true, false] {
                if (advanced.state == .on) != expanded { advanced.performClick(nil) }
                pane.view.layoutSubtreeIfNeeded()
                let content = try XCTUnwrap(pane.view.subviews.first)
                XCTAssertLessThanOrEqual(content.fittingSize.width, Form.pageWidth - 56)
                XCTAssertLessThan(pane.view.fittingSize.height, 720)
                XCTAssertTrue(Self.ambiguousViews(in: pane.view).isEmpty)
            }
        }
    }

    func testCollapsingAdvancedShrinksTheRow() throws {
        let context = FakeContext.states()[1].1
        let controller = SettingsWindowController(context: context)
        _ = controller.window
        controller.tabs.select(.clients)
        controller.tabs.refreshAll()
        controller.tabs.fitWindow(animated: false)
        let pane = try XCTUnwrap(controller.tabs.tabView.selectedTabViewItem?.viewController as? ClientsPane)
        pane.view.layoutSubtreeIfNeeded()
        let table = try XCTUnwrap(Self.descendants(pane.view).compactMap { $0 as? NSTableView }.first)
        let collapsedHeight = table.rect(ofRow: 1).height
        try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-advanced-toggle-2") as? NSButton).performClick(nil)
        pane.view.layoutSubtreeIfNeeded()
        let expandedHeight = table.rect(ofRow: 1).height
        XCTAssertGreaterThan(expandedHeight, collapsedHeight, "Expanding Advanced must grow the card row")
        try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-advanced-toggle-2") as? NSButton).performClick(nil)
        pane.view.layoutSubtreeIfNeeded()
        XCTAssertEqual(table.rect(ofRow: 1).height, collapsedHeight, accuracy: 0.5,
                       "Collapsing Advanced must shrink the row again")
    }

    func testLongClientScopesKeepRevokeInsideTheCardAndClickable() throws {
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            for (count, length) in [(8, 67), (9, 200)] {
                for state in [ClientGrantState.idle, .unconfirmed("2")] {
                    let context = FakeContext()
                    context.clients = [ClientRecord(id: "2", name: "Long Scope Agent",
                        appIds: Self.longAppIDs(count: count, length: length), browser: false, foreground: true)]
                    context.clientGrantState = state
                    var confirmations: [String] = []
                    let pane = ClientsPane(context: context, confirmRevoke: { client in
                        confirmations.append(client.id)
                        return true
                    })
                    let (window, table) = try Self.hostClientPane(pane)
                    defer { window.orderOut(nil) }
                    let card = try XCTUnwrap(pane.cardView(for: "2"))
                    try XCTUnwrap(Self.view(in: card, id: "clients-advanced-toggle-2") as? NSButton).performClick(nil)
                    let revoke = try Self.reachableRevoke(in: pane, table: table, clientID: "2")
                    if count == 8, case .unconfirmed = state,
                       let path = ProcessInfo.processInfo.environment["CU_SETTINGS_SNAPSHOTS"] {
                        let directory = URL(fileURLWithPath: path, isDirectory: true)
                        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                        let bitmap = try XCTUnwrap(card.bitmapImageRepForCachingDisplay(in: card.bounds))
                        card.cacheDisplay(in: card.bounds, to: bitmap)
                        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                            .write(to: directory.appendingPathComponent("clients-long-scope-\(language.rawValue).png"))
                    }
                    XCTAssertTrue(context.revokeRequests.isEmpty, "Laying out a long scope must not change authorization")
                    revoke.performClick(nil)
                    XCTAssertEqual(confirmations, ["2"], "The reachable action must use the existing local confirmation")
                    XCTAssertEqual(context.revokeRequests, ["2"], "The action must revoke the owning client")
                }
            }
        }
    }

    func testLongClientScopeRestoresItsHeightAfterCollapsingAndExpanding() throws {
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let context = FakeContext()
            context.clients = [ClientRecord(id: "2", name: "Long Scope Agent",
                appIds: Self.longAppIDs(count: 8, length: 67), browser: false, foreground: true)]
            context.clientGrantState = .unconfirmed("2")
            let pane = ClientsPane(context: context)
            let (window, table) = try Self.hostClientPane(pane)
            defer { window.orderOut(nil) }
            let card = try XCTUnwrap(pane.cardView(for: "2"))
            let toggle = try XCTUnwrap(Self.view(in: card, id: "clients-advanced-toggle-2") as? NSButton)
            let collapsedHeight = table.rect(ofRow: 0).height
            toggle.performClick(nil)
            _ = try Self.reachableRevoke(in: pane, table: table, clientID: "2")
            let expandedHeight = table.rect(ofRow: 0).height
            XCTAssertGreaterThan(expandedHeight, collapsedHeight)

            toggle.performClick(nil)
            pane.view.layoutSubtreeIfNeeded()
            table.layoutSubtreeIfNeeded()
            XCTAssertEqual(table.rect(ofRow: 0).height, collapsedHeight, accuracy: 0.5)
            XCTAssertTrue(try XCTUnwrap(Self.view(in: card, id: "clients-advanced-panel-2")).isHidden)

            toggle.performClick(nil)
            _ = try Self.reachableRevoke(in: pane, table: table, clientID: "2")
            XCTAssertEqual(table.rect(ofRow: 0).height, expandedHeight, accuracy: 0.5,
                           "Expanding again must restore the measured height, including visible feedback")
        }
    }

    func testExpandedClientRowRemeasuresScopeAndFeedbackChangesForTheSameIdentity() throws {
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let context = FakeContext()
            context.clients = [ClientRecord(id: "2", name: "Scope Agent", appIds: ["com.apple.TextEdit"],
                                            browser: false, foreground: true)]
            let pane = ClientsPane(context: context)
            let (window, table) = try Self.hostClientPane(pane)
            defer { window.orderOut(nil) }
            try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")),
                                   id: "clients-advanced-toggle-2") as? NSButton).performClick(nil)
            _ = try Self.reachableRevoke(in: pane, table: table, clientID: "2")
            let shortHeight = table.rect(ofRow: 0).height

            context.clients[0] = ClientRecord(id: "2", name: "Scope Agent",
                appIds: Self.longAppIDs(count: 8, length: 67), browser: false, foreground: true)
            pane.refresh()
            _ = try Self.reachableRevoke(in: pane, table: table, clientID: "2")
            let longHeight = table.rect(ofRow: 0).height
            XCTAssertGreaterThan(longHeight, shortHeight, "Changed scope data must invalidate the same client's row height")

            context.clientGrantState = .unconfirmed("2")
            pane.refresh()
            _ = try Self.reachableRevoke(in: pane, table: table, clientID: "2")
            XCTAssertGreaterThan(table.rect(ofRow: 0).height, longHeight,
                                 "Feedback becoming visible must grow an already expanded long card")

            context.clientGrantState = .idle
            pane.refresh()
            _ = try Self.reachableRevoke(in: pane, table: table, clientID: "2")
            XCTAssertEqual(table.rect(ofRow: 0).height, longHeight, accuracy: 0.5,
                           "Removing feedback must release its extra space")

            context.clients[0] = ClientRecord(id: "2", name: "Scope Agent", appIds: ["com.apple.TextEdit"],
                                            browser: false, foreground: true)
            pane.refresh()
            _ = try Self.reachableRevoke(in: pane, table: table, clientID: "2")
            XCTAssertEqual(table.rect(ofRow: 0).height, shortHeight, accuracy: 0.5,
                           "Returning to a short scope must shrink the row without losing disclosure state")
            XCTAssertEqual(try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")),
                                                id: "clients-advanced-toggle-2") as? NSButton).state, .on)
        }
    }

    private static func longAppIDs(count: Int, length: Int) -> [String] {
        (0..<count).map { index in
            let prefix = "com.example."
            let suffix = String(index)
            return prefix + String(repeating: "a", count: length - prefix.count - suffix.count) + suffix
        }
    }

    private static func hostClientPane(_ pane: ClientsPane) throws -> (NSWindow, NSTableView) {
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: Form.pageWidth, height: 640),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentViewController = pane
        pane.refresh()
        window.setContentSize(pane.view.fittingSize)
        window.orderFrontRegardless()
        pane.view.layoutSubtreeIfNeeded()
        let table = try XCTUnwrap(descendants(pane.view).compactMap { $0 as? NSTableView }.first)
        table.layoutSubtreeIfNeeded()
        return (window, table)
    }

    /// Exercise the table's actual card frame and hit testing after scrolling its destructive action into view.
    @discardableResult
    private static func reachableRevoke(in pane: ClientsPane, table: NSTableView, clientID: String,
                                        file: StaticString = #filePath, line: UInt = #line) throws -> NSButton {
        pane.view.layoutSubtreeIfNeeded()
        let row = try XCTUnwrap(pane.displayedClientIDs.firstIndex(of: clientID), file: file, line: line)
        table.scrollRowToVisible(row)
        let card = try XCTUnwrap(pane.cardView(for: clientID), file: file, line: line)
        // noteHeightOfRows updates the row rect before its view's animated frame. Wait for the
        // real table layout to settle so the regression measures clipping rather than animation.
        let deadline = Date().addingTimeInterval(2)
        repeat {
            pane.view.layoutSubtreeIfNeeded()
            table.layoutSubtreeIfNeeded()
            card.layoutSubtreeIfNeeded()
            pane.view.window?.displayIfNeeded()
            if abs(card.bounds.height - table.frameOfCell(atColumn: 0, row: row).height) <= 0.5 { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        } while Date() < deadline
        XCTAssertEqual(card.bounds.height, table.frameOfCell(atColumn: 0, row: row).height, accuracy: 0.5,
                       "The table must finish applying its row height before checking its actions", file: file, line: line)
        let revoke = try XCTUnwrap(view(in: card, id: "clients-revoke-\(clientID)") as? NSButton, file: file, line: line)
        revoke.scrollToVisible(revoke.bounds)
        let frame = revoke.convert(revoke.bounds, to: card)
        XCTAssertTrue(card.bounds.contains(frame), "Revoke \(frame) must fit entirely inside its card \(card.bounds)",
                      file: file, line: line)
        XCTAssertTrue(revoke.isEnabled, file: file, line: line)
        let center = NSPoint(x: frame.midX, y: frame.midY)
        let hit = try XCTUnwrap(card.hitTest(card.convert(center, to: card.superview)),
                               "Revoke must remain reachable through the card's bounds", file: file, line: line)
        XCTAssertTrue(hit === revoke || hit.isDescendant(of: revoke), "Hit testing the action must reach its button",
                      file: file, line: line)
        return revoke
    }

    private static func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
    }

    private static func view(in root: NSView, id: String) -> NSView? {
        descendants(root).first { $0.identifier?.rawValue == id }
    }

    func testGrantConfirmationRequiresExplicitApprovalInBothLanguages() throws {
        let policy = NSApp.activationPolicy()
        NSApp.setActivationPolicy(.accessory)
        defer { NSApp.setActivationPolicy(policy) }
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            for key in ["\r", "\u{1b}", nil] {
                let alert = Alerts.confirmation(tr(.clientsGrantTitle, "Test Agent"), tr(.clientsGrantBody),
                                                confirm: tr(.clientsGrantConfirm), defaultCancel: true)
                alert.layout()
                alert.window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
                XCTAssertEqual(alert.buttons[0].keyEquivalent, "", "Granting access must require an explicit choice")
                XCTAssertEqual(alert.buttons[1].keyEquivalent, "\r")
                XCTAssertTrue(alert.window.initialFirstResponder === alert.buttons[1])
                let input = Timer(timeInterval: 0.1, repeats: false) { _ in
                    guard let key else { alert.buttons[0].performClick(nil); return }
                    guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                        windowNumber: alert.window.windowNumber, context: nil, characters: key,
                        charactersIgnoringModifiers: key, isARepeat: false, keyCode: key == "\r" ? 36 : 53) else {
                        return XCTFail("Could not create the modal key event")
                    }
                    NSApp.postEvent(event, atStart: true)
                }
                var timedOut = false
                let timeout = Timer(timeInterval: 2, repeats: false) { _ in
                    timedOut = true
                    NSApp.stopModal(withCode: .abort)
                }
                RunLoop.main.add(input, forMode: .modalPanel)
                RunLoop.main.add(timeout, forMode: .modalPanel)
                defer { input.invalidate(); timeout.invalidate(); alert.window.orderOut(nil) }
                XCTAssertEqual(Alerts.runConfirmation(alert), key == nil, "Only an explicit click may approve")
                XCTAssertFalse(timedOut, "\(language) \(String(describing: key)) must dismiss the confirmation")
            }
        }
        let ordinary = Alerts.confirmation("Test", "Test", confirm: "Continue")
        XCTAssertEqual(ordinary.buttons[0].keyEquivalent, "\r", "Other confirmation defaults are unchanged")
    }

    func testClientCardsExposePrimaryActionWithoutSelectingARow() throws {
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let context = FakeContext.states()[1].1
            context.clients.append(ClientRecord(id: "4", name: "Old all apps", allApps: true, foreground: false))
            let pane = ClientsPane(context: context)
            _ = pane.view
            pane.refresh()

            let card2 = try XCTUnwrap(pane.cardView(for: "2"))
            let grant2 = try XCTUnwrap(Self.view(in: card2, id: "clients-grant-2") as? NSButton)
            XCTAssertFalse(grant2.isHidden)
            XCTAssertTrue(grant2.isEnabled)
            XCTAssertEqual(grant2.title, tr(.clientsGrantAllApps))
            XCTAssertTrue(try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "1")), id: "clients-grant-1") as? NSButton).isHidden)
            XCTAssertTrue(try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "3")), id: "clients-grant-3") as? NSButton).isHidden)
            XCTAssertEqual(try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "1")), id: "clients-status-1") as? NSTextField).stringValue,
                           tr(.clientsGrantAlready))
            XCTAssertEqual(try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "3")), id: "clients-status-3") as? NSTextField).stringValue,
                           tr(.clientsGrantBrowserOnly))
            let grant4 = try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "4")), id: "clients-grant-4") as? NSButton)
            XCTAssertTrue(grant4.isEnabled, "An all-app grant without foreground may still need an upgrade")

            XCTAssertTrue(context.grantRequests.isEmpty, "Showing or refreshing the page never authorizes clients")
            grant2.performClick(nil)
            XCTAssertEqual(context.grantRequests, ["2"])

            context.serviceState = .paused
            pane.refresh()
            XCTAssertTrue(grant2.isEnabled, "Authorization management remains available while paused")

            context.isRunning = false
            pane.refresh()
            XCTAssertEqual(try XCTUnwrap(Self.view(in: pane.view, id: "clients-placeholder") as? NSTextField).stringValue,
                           tr(.clientsNotRunning))
            XCTAssertTrue(pane.displayedClientIDs.isEmpty)
        }
    }

    func testClientGrantFeedbackStaysWithOwningCardAndSurvivesRemoval() throws {
        let context = FakeContext.states()[1].1
        context.clients.append(ClientRecord(id: "4", name: "Old all apps", allApps: true, foreground: false))
        let pane = ClientsPane(context: context)
        _ = pane.view
        pane.refresh()
        let grant2 = try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-grant-2") as? NSButton)
        let grant4 = try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "4")), id: "clients-grant-4") as? NSButton)
        XCTAssertTrue(grant2.isEnabled)

        var tracker = ClientGrantTracker()
        _ = tracker.begin(client: context.clients[1], generation: UUID())
        context.clientGrantState = tracker.state
        pane.refresh()
        let feedback2 = try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-feedback-2") as? NSTextField)
        XCTAssertEqual(feedback2.stringValue, tr(.clientsGrantPending))
        XCTAssertFalse(feedback2.isHidden)
        XCTAssertFalse(grant2.isEnabled)
        XCTAssertFalse(grant4.isEnabled, "A pending request blocks every upgrade button")
        XCTAssertTrue(try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "1")), id: "clients-feedback-1") as? NSTextField).isHidden,
                      "Another client's result must not appear on this card")
        for (state, key) in [(ClientGrantState.unconfirmed("2"), L10nKey.clientsGrantUnconfirmed),
                             (.failed("2", "unavailable"), .clientsGrantFailed),
                             (.succeeded("2"), .clientsGrantSucceeded)] {
            context.clientGrantState = state
            pane.refresh()
            XCTAssertEqual(feedback2.stringValue, tr(key))
        }
        context.clientGrantState = .failed("2", "not_found")
        context.clients.removeAll { $0.id == "2" }
        pane.refresh()
        let fallback = try XCTUnwrap(Self.view(in: pane.view, id: "clients-grant-feedback") as? NSTextField)
        XCTAssertEqual(fallback.stringValue, tr(.clientsGrantUnavailable),
                       "A result for a removed client remains visible on the page")
        XCTAssertFalse(fallback.isHidden)
    }

    func testPairingMessageDistinguishesAllAppsFromExistingRestrictedScope() throws {
        let all = try HostEvent.parse(Data(#"{"event":"pair_request","clientId":"all","name":"Agent","appIds":[],"allApps":true,"browser":false,"foreground":true}"#.utf8))
        let restricted = try HostEvent.parse(Data(#"{"event":"pair_request","clientId":"old","name":"Agent","appIds":["com.apple.TextEdit"],"browser":false,"foreground":true}"#.utf8))
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let allMessage = HostApplication.pairingMessage(all)
            XCTAssertTrue(allMessage.contains(tr(.approvalAllApps)))
            XCTAssertTrue(allMessage.contains(tr(.approvalNotAllowed)), "All desktop apps does not grant the isolated browser")
            XCTAssertTrue(allMessage.contains(tr(.approvalForegroundAllowed)))
            let restrictedMessage = HostApplication.pairingMessage(restricted)
            XCTAssertTrue(restrictedMessage.contains("com.apple.TextEdit"))
            XCTAssertFalse(restrictedMessage.contains(tr(.approvalAllApps)), "Older grants must not appear expanded")
        }
    }

    func testGrantRequestMessageShowsTheShortIdentityAndCurrentScope() throws {
        let event = try HostEvent.parse(Data(#"{"event":"grant_request","requestId":"6f1c2a9e-3b4d-4c5e-8f70-112233445566","clientId":"c1d2e3f4-0000-4000-8000-000000000001","name":"Codex","appIds":["com.apple.TextEdit"],"browser":true}"#.utf8))
        let empty = try HostEvent.parse(Data(#"{"event":"grant_request","requestId":"6f1c2a9e-3b4d-4c5e-8f70-112233445566","clientId":"c1d2e3f4-0000-4000-8000-000000000001","name":"Codex","appIds":[],"browser":true}"#.utf8))
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let message = HostApplication.grantRequestMessage(event)
            XCTAssertTrue(message.contains("Codex"))
            XCTAssertTrue(message.contains("c1d2e3f4"))
            XCTAssertFalse(message.contains("c1d2e3f4-0000"), "The dialog shows the same short ID as the Clients page")
            XCTAssertTrue(message.contains("com.apple.TextEdit"))
            XCTAssertTrue(HostApplication.grantRequestMessage(empty).contains(tr(.approvalNone)))
        }
    }

    func testClientCardShowsShortIdentityAndAdvancedScope() throws {
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let longID = "c1d2e3f4-0000-4000-8000-000000000001"
            let context = FakeContext.states()[1].1
            context.clients[0] = ClientRecord(id: longID, name: "Codex", appIds: [], allApps: true, browser: false, foreground: true)
            let pane = ClientsPane(context: context)
            _ = pane.view
            pane.refresh()
            let longCard = try XCTUnwrap(pane.cardView(for: longID))
            let short = try XCTUnwrap(Self.view(in: longCard, id: "clients-id-\(longID)") as? NSTextField)
            XCTAssertEqual(short.stringValue, "c1d2e3f4")
            XCTAssertEqual(short.toolTip, longID)
            let scope = try XCTUnwrap(Self.view(in: longCard, id: "clients-scope-\(longID)") as? NSTextField)
            XCTAssertTrue(scope.stringValue.contains(longID))
            XCTAssertTrue(scope.stringValue.contains(tr(.clientsAllApps)))
            let toggle = try XCTUnwrap(Self.view(in: longCard, id: "clients-advanced-toggle-\(longID)") as? NSButton)
            let panel = try XCTUnwrap(Self.view(in: longCard, id: "clients-advanced-panel-\(longID)"))
            XCTAssertTrue(panel.isHidden)
            toggle.performClick(nil)
            XCTAssertFalse(panel.isHidden)
            XCTAssertTrue(scope.stringValue.contains(tr(.clientsDesktopApps)))

            let restrictedBadge = try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-badge-2") as? NSTextField)
            XCTAssertEqual(restrictedBadge.stringValue, tr(.clientsBadgeRestricted, 2))
            let restrictedScope = try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-scope-2") as? NSTextField)
            XCTAssertTrue(restrictedScope.stringValue.contains("com.apple.TextEdit"), restrictedScope.stringValue)
            XCTAssertTrue(restrictedScope.stringValue.contains("com.apple.Notes"), restrictedScope.stringValue)
            let browserBadge = try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "3")), id: "clients-badge-3") as? NSTextField)
            XCTAssertEqual(browserBadge.stringValue, tr(.clientsBadgeBrowserOnly))
        }
    }

    func testClientSearchFiltersByNameShortIDAndAppID() throws {
        let context = FakeContext.states()[1].1
        let pane = ClientsPane(context: context)
        _ = pane.view
        pane.refresh()
        let search = try XCTUnwrap(Self.view(in: pane.view, id: "clients-search") as? NSSearchField)
        XCTAssertEqual(pane.displayedClientIDs.count, 3)
        for (query, expected) in [("browser", ["3"]), ("com.apple.notes", ["2"]), ("not-a-client", [])] {
            search.stringValue = query
            pane.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
            XCTAssertEqual(pane.displayedClientIDs, expected, query)
        }
        XCTAssertEqual(try XCTUnwrap(Self.view(in: pane.view, id: "clients-placeholder") as? NSTextField).stringValue,
                       tr(.clientsNoMatches))
        search.stringValue = ""
        pane.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        XCTAssertEqual(pane.displayedClientIDs.count, 3)
    }

    func testAdvancedDisclosureSurvivesRefreshAndSearch() throws {
        let context = FakeContext.states()[1].1
        let pane = ClientsPane(context: context)
        _ = pane.view
        pane.refresh()
        let toggle = try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-advanced-toggle-2") as? NSButton)
        let panel = try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-advanced-panel-2"))
        toggle.performClick(nil)
        XCTAssertFalse(panel.isHidden)
        pane.refresh()
        XCTAssertFalse(panel.isHidden, "Timer refresh must preserve an expanded card")

        let search = try XCTUnwrap(Self.view(in: pane.view, id: "clients-search") as? NSSearchField)
        search.stringValue = "codex"
        pane.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        search.stringValue = ""
        pane.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        XCTAssertFalse(try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-advanced-panel-2")).isHidden,
                       "Filtering out and restoring a client preserves its expanded scope")
    }

    func testRevokeRequiresConfirmationAndCallsContext() throws {
        let context = FakeContext.states()[1].1
        var confirmed: ClientRecord?
        let pane = ClientsPane(context: context, confirmRevoke: { client in confirmed = client; return true })
        _ = pane.view
        pane.refresh()
        try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-advanced-toggle-2") as? NSButton).performClick(nil)
        try XCTUnwrap(Self.view(in: try XCTUnwrap(pane.cardView(for: "2")), id: "clients-revoke-2") as? NSButton).performClick(nil)
        XCTAssertEqual(confirmed?.id, "2")
        XCTAssertEqual(context.revokeRequests, ["2"])

        let other = FakeContext.states()[1].1
        var asked = false
        let denying = ClientsPane(context: other, confirmRevoke: { _ in asked = true; return false })
        _ = denying.view
        denying.refresh()
        try XCTUnwrap(Self.view(in: try XCTUnwrap(denying.cardView(for: "2")), id: "clients-advanced-toggle-2") as? NSButton).performClick(nil)
        try XCTUnwrap(Self.view(in: try XCTUnwrap(denying.cardView(for: "2")), id: "clients-revoke-2") as? NSButton).performClick(nil)
        XCTAssertTrue(asked)
        XCTAssertTrue(other.revokeRequests.isEmpty, "Dismissing the confirmation keeps the client")
    }

    func testOfflineServiceShowsPlaceholderAndNoActions() throws {
        let context = FakeContext.states()[0].1
        let pane = ClientsPane(context: context)
        _ = pane.view
        pane.refresh()
        XCTAssertEqual(try XCTUnwrap(Self.view(in: pane.view, id: "clients-placeholder") as? NSTextField).stringValue,
                       tr(.clientsNotRunning))
        XCTAssertTrue(pane.displayedClientIDs.isEmpty)
        XCTAssertFalse(try XCTUnwrap(Self.view(in: pane.view, id: "clients-search") as? NSSearchField).isEnabled)
    }

    func testEveryPaneFitsThePageInBothLanguagesAndStates() throws {
        let directory = ProcessInfo.processInfo.environment["CU_SETTINGS_SNAPSHOTS"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        if let directory { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            for (state, context) in FakeContext.states() {
                let controller = SettingsWindowController(context: context)
                // 截图固定用浅色外观；深色模式下白字画在透明背景上看不见。
                controller.window?.appearance = NSAppearance(named: .aqua)
                for pane in SettingsPane.allCases {
                    controller.tabs.select(pane)
                    controller.tabs.refreshAll()
                    controller.tabs.fitWindow(animated: false)
                    let view = try XCTUnwrap(controller.tabs.tabView.selectedTabViewItem?.viewController?.view)
                    view.layoutSubtreeIfNeeded()
                    let name = "\(language.rawValue)-\(state)-\(pane)"
                    let content = try XCTUnwrap(view.subviews.first)
                    XCTAssertLessThanOrEqual(content.fittingSize.width, Form.pageWidth - 56, "\(name) is wider than the page")
                    XCTAssertEqual(view.fittingSize.width, Form.pageWidth, accuracy: 0.5, name)
                    XCTAssertGreaterThan(view.fittingSize.height, 80, name)
                    XCTAssertLessThan(view.fittingSize.height, 720, name)
                    let ambiguous = Self.ambiguousViews(in: view)
                    XCTAssertTrue(ambiguous.isEmpty, "\(name) has an ambiguous layout: \(ambiguous)")
                    if let directory { try Self.snapshot(view, to: directory.appendingPathComponent("\(name).png")) }
                }
            }
        }
    }

    /// 整窗截图（含标题栏与工具栏）：窗口放在屏幕之外显示，只在设置了 CU_SETTINGS_SNAPSHOTS 时运行。
    func testWholeWindowSnapshotsWithToolbar() throws {
        guard let path = ProcessInfo.processInfo.environment["CU_SETTINGS_SNAPSHOTS"] else {
            throw XCTSkip("Set CU_SETTINGS_SNAPSHOTS to render whole-window snapshots")
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let context = FakeContext.states()[1].1
            let controller = SettingsWindowController(context: context)
            let window = try XCTUnwrap(controller.window)
            window.appearance = NSAppearance(named: .aqua)
            window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
            window.orderFrontRegardless()
            defer { window.orderOut(nil) }
            for pane in SettingsPane.allCases {
                controller.tabs.select(pane)
                controller.tabs.refreshAll()
                controller.tabs.fitWindow(animated: false)
                RunLoop.current.run(until: Date().addingTimeInterval(0.2))
                XCTAssertNotNil(window.toolbar, "The tab controller installs the toolbar")
                XCTAssertEqual(window.toolbar?.items.count, SettingsPane.allCases.count)
                XCTAssertEqual(window.title, L10n.text(.settingsTitle, language: language))
                let frame = try XCTUnwrap(window.contentView?.superview)
                guard let bitmap = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { continue }
                frame.cacheDisplay(in: frame.bounds, to: bitmap)
                try bitmap.representation(using: .png, properties: [:])?
                    .write(to: directory.appendingPathComponent("window-\(language.rawValue)-\(pane).png"))
            }
        }
    }

    /// Render client cards and the non-modal confirmation; never send an authorization command.
    func testClientGrantSnapshotsAndConfirmationLayout() throws {
        guard let path = ProcessInfo.processInfo.environment["CU_SETTINGS_SNAPSHOTS"] else {
            throw XCTSkip("Set CU_SETTINGS_SNAPSHOTS to render grant management")
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let context = FakeContext.states()[1].1
            context.serviceState = .paused
            context.serviceStatus = tr(.statusPaused)
            let controller = SettingsWindowController(context: context)
            let window = try XCTUnwrap(controller.window)
            window.appearance = NSAppearance(named: .aqua)
            window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
            window.orderFrontRegardless()
            defer { window.orderOut(nil) }
            controller.tabs.select(.clients)
            controller.tabs.refreshAll()
            let view = try XCTUnwrap(controller.tabs.tabView.selectedTabViewItem?.viewController?.view)
            let clientsPane = try XCTUnwrap(controller.tabs.tabView.selectedTabViewItem?.viewController as? ClientsPane)
            controller.tabs.fitWindow(animated: false)
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            try Self.snapshot(view, to: directory.appendingPathComponent("clients-\(language.rawValue)-collapsed.png"))
            try XCTUnwrap(Self.view(in: try XCTUnwrap(clientsPane.cardView(for: "2")), id: "clients-advanced-toggle-2") as? NSButton).performClick(nil)
            controller.tabs.refreshAll()
            controller.tabs.fitWindow(animated: false)
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            var tracker = ClientGrantTracker()
            _ = tracker.begin(client: context.clients[1], generation: UUID())
            let states: [(String, ClientGrantState)] = [("ready", .idle), ("pending", tracker.state),
                ("failed", .failed("2", "unavailable")), ("unconfirmed", .unconfirmed("2")), ("success", .succeeded("2"))]
            for (name, state) in states {
                if name == "success" {
                    context.clients[1] = ClientRecord(id: "2", name: "Restricted Agent", appIds: [], allApps: true, browser: false, foreground: true)
                }
                context.clientGrantState = state
                controller.tabs.refreshAll()
                controller.tabs.fitWindow(animated: false)
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                XCTAssertLessThanOrEqual(view.subviews.first!.fittingSize.width, Form.pageWidth - 56)
                XCTAssertLessThan(view.fittingSize.height, 720)
                try Self.snapshot(view, to: directory.appendingPathComponent("clients-\(language.rawValue)-\(name).png"))
            }
            if let toggle = Self.view(in: try XCTUnwrap(clientsPane.cardView(for: "2")), id: "clients-advanced-toggle-2") as? NSButton,
               toggle.state == .on {
                toggle.performClick(nil)
            }
            context.clientGrantState = .idle
            controller.tabs.refreshAll()
            controller.tabs.fitWindow(animated: false)
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            try Self.snapshot(view, to: directory.appendingPathComponent("clients-\(language.rawValue)-collapsed-after.png"))

            let alert = Alerts.confirmation(tr(.clientsGrantTitle, "Restricted Agent"), tr(.clientsGrantBody), confirm: tr(.clientsGrantConfirm), defaultCancel: true)
            alert.window.appearance = NSAppearance(named: .aqua)
            alert.layout()
            alert.window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
            alert.window.orderFrontRegardless()
            defer { alert.window.orderOut(nil) }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            XCTAssertEqual(alert.buttons.map(\.title), [tr(.clientsGrantConfirm), tr(.commonCancel)])
            XCTAssertTrue(context.grantRequests.isEmpty, "Rendering confirmation must not send an authorization command")
            let frame = try XCTUnwrap(alert.window.contentView?.superview)
            let bitmap = try XCTUnwrap(frame.bitmapImageRepForCachingDisplay(in: frame.bounds))
            frame.cacheDisplay(in: frame.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: directory.appendingPathComponent("clients-\(language.rawValue)-confirmation.png"))
        }
    }

    /// 只检查可见的视图；NSTextView 内部由文本系统按 frame 排版，不参与自动布局。
    private static func ambiguousViews(in view: NSView) -> [String] {
        guard !view.isHidden, !(view is NSTextView) else { return [] }
        return (view.hasAmbiguousLayout ? ["\(type(of: view)) \(view.frame)"] : []) + view.subviews.flatMap(ambiguousViews)
    }

    private static func snapshot(_ view: NSView, to url: URL) throws {
        let bounds = NSRect(origin: .zero, size: view.fittingSize)
        view.setFrameSize(bounds.size)
        view.layoutSubtreeIfNeeded()
        guard let content = view.bitmapImageRepForCachingDisplay(in: bounds),
              let output = view.bitmapImageRepForCachingDisplay(in: bounds),
              let context = NSGraphicsContext(bitmapImageRep: output) else { return }
        view.cacheDisplay(in: bounds, to: content)
        // 把分区画在窗口背景色上，接近真实窗口的样子。
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        NSColor(calibratedWhite: 0.93, alpha: 1).setFill()
        bounds.fill()
        content.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
        try output.representation(using: .png, properties: [:])?.write(to: url)
    }
}

private final class FakeContext: HostContext {
    let paths = HostPaths(resources: URL(fileURLWithPath: "/ComputerUseTests-MissingResources/Contents/Resources"),
                          home: FileManager.default.temporaryDirectory)
    var serviceState = ServiceState.ready
    var serviceStatus = tr(.statusReady)
    var isRunning = true
    var clients: [ClientRecord] = []
    var clientGrantState: ClientGrantState = .idle
    var httpEnabled = false
    var httpStatus: String?
    var controlledAppCount = 0
    var permissionsGranted = true
    var teamID: String? = "A1B2C3D4E5"
    lazy var updates = UpdateController(paths: paths, info: ["CFBundleShortVersionString": "0.4.0", "CFBundleVersion": "5"], teamID: teamID)

    func pauseActions() {}
    var resumeCount = 0
    func resumeActions() { resumeCount += 1 }
    func emergencyStop() {}
    func restartServices() {}
    var revokeRequests: [String] = []
    func revokeClient(_ id: String) { revokeRequests.append(id) }
    var grantRequests: [String] = []
    func grantAllApps(_ id: String) { grantRequests.append(id) }
    func setHTTPEnabled(_ enabled: Bool) {}
    func requestPermissions() {}
    func installCLI() {}
    func copyConfiguration() {}
    func quitForUpdate() {}

    /// 空闲、运行中有数据、下载中三种典型状态。
    static func states() -> [(String, FakeContext)] {
        let idle = FakeContext()
        idle.teamID = nil
        idle.serviceState = .needsPermissions
        idle.serviceStatus = tr(.statusPermissionsNeeded)
        idle.isRunning = false

        let busy = FakeContext()
        busy.clients = [
            ClientRecord(id: "1", name: "Codex", appIds: [], allApps: true, browser: false, foreground: true),
            ClientRecord(id: "2", name: "Restricted Agent", appIds: ["com.apple.TextEdit", "com.apple.Notes"], browser: false, foreground: true),
            ClientRecord(id: "3", name: "Browser Agent", appIds: [], browser: true, foreground: true),
        ]
        busy.httpEnabled = true
        busy.httpStatus = "Local MCP: http://127.0.0.1:47631/mcp"
        let check = try! JSONDecoder().decode(UpdateCheck.self, from: Data(#"""
        {"current":"0.4.0","latest":"0.5.0","available":true,"platform":"macos-arm64","tag":"v0.5.0",
         "url":"https://github.com/starroyhq/computer-use/releases/tag/v0.5.0","publishedAt":"2026-10-01T08:00:00Z",
         "notes":"## Computer Use v0.5.0\n\n- 设置窗口改为 6 个分区\n- 检查更新与一键安装\n- Windows 设置窗口与开机启动",
         "asset":{"name":"computer-use-0.5.0-macos-arm64.zip","size":92514020}}
        """#.utf8))
        busy.updates.phase = .available(check)

        let downloading = FakeContext()
        downloading.serviceState = .paused
        downloading.serviceStatus = tr(.statusPaused)
        downloading.updates.phase = .downloading(check, downloaded: 41_000_000, total: 92_514_020)
        return [("idle", idle), ("busy", busy), ("downloading", downloading)]
    }
}
