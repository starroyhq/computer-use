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

    private static func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
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

    func testGrantAllAppsButtonUsesLocalClickAndRemainsAvailableWhilePaused() throws {
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let context = FakeContext.states()[1].1
            context.clients.append(ClientRecord(id: "4", name: "Old all apps", allApps: true, foreground: false))
            let pane = ClientsPane(context: context)
            _ = pane.view
            pane.refresh()
            let table = try XCTUnwrap(Self.descendants(pane.view).compactMap { $0 as? NSTableView }.first)
            let grant = try XCTUnwrap(Self.descendants(pane.view).compactMap { $0 as? NSButton }
                .first { $0.identifier?.rawValue == "clients-grant-all-apps" })
            XCTAssertFalse(grant.isEnabled)
            XCTAssertTrue(context.grantRequests.isEmpty, "Showing or refreshing the page never authorizes clients")
            table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
            XCTAssertEqual(grant.title, tr(.clientsGrantAlready))
            XCTAssertFalse(grant.isEnabled)
            table.selectRowIndexes(IndexSet(integer: 2), byExtendingSelection: false)
            XCTAssertFalse(grant.isEnabled, "Browser-only access cannot expand through this action")
            table.selectRowIndexes(IndexSet(integer: 1), byExtendingSelection: false)
            XCTAssertTrue(grant.isEnabled)
            context.serviceState = .paused
            pane.refresh()
            XCTAssertTrue(grant.isEnabled)
            grant.performClick(nil)
            XCTAssertEqual(context.grantRequests, ["2"])
            XCTAssertEqual(context.resumeCount, 0, "Authorization management must not resume actions")
            table.selectRowIndexes(IndexSet(integer: 3), byExtendingSelection: false)
            XCTAssertTrue(grant.isEnabled, "An old all-app grant may still need foreground access")
            context.isRunning = false
            pane.refresh()
            XCTAssertFalse(grant.isEnabled)
        }
    }

    func testClientGrantFeedbackWaitsForAckAndReportsTimeoutOrFailure() throws {
        let context = FakeContext.states()[1].1
        let pane = ClientsPane(context: context)
        _ = pane.view
        pane.refresh()
        let table = try XCTUnwrap(Self.descendants(pane.view).compactMap { $0 as? NSTableView }.first)
        let grant = try XCTUnwrap(Self.descendants(pane.view).compactMap { $0 as? NSButton }
            .first { $0.identifier?.rawValue == "clients-grant-all-apps" })
        let feedback = try XCTUnwrap(Self.descendants(pane.view).compactMap { $0 as? NSTextField }
            .first { $0.identifier?.rawValue == "clients-grant-feedback" })
        table.selectRowIndexes(IndexSet(integer: 1), byExtendingSelection: false)
        var tracker = ClientGrantTracker()
        _ = tracker.begin(client: context.clients[1], generation: UUID())
        context.clientGrantState = tracker.state
        pane.refresh()
        XCTAssertFalse(grant.isEnabled)
        XCTAssertEqual(feedback.stringValue, tr(.clientsGrantPending))
        for (state, key) in [(ClientGrantState.unconfirmed("2"), L10nKey.clientsGrantUnconfirmed),
                             (.failed("2", "unavailable"), .clientsGrantFailed),
                             (.succeeded("2"), .clientsGrantSucceeded)] {
            context.clientGrantState = state
            pane.refresh()
            XCTAssertEqual(feedback.stringValue, tr(key))
        }
        table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        XCTAssertTrue(feedback.isHidden, "Another client's successful grant must not appear on the selected client")
        table.selectRowIndexes(IndexSet(integer: 1), byExtendingSelection: false)
        context.clientGrantState = .failed("2", "not_found")
        context.clients.remove(at: 1)
        pane.refresh()
        XCTAssertEqual(feedback.stringValue, tr(.clientsGrantUnavailable), "Failure stays visible when revocation removed the row")
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

    func testClientScopeCellsShowAllAppsRestrictedAppsAndBrowserOnly() throws {
        for language in HostLanguage.allCases {
            HostLanguage.current = language
            let pane = ClientsPane(context: FakeContext.states()[1].1)
            _ = pane.view
            pane.refresh()
            let table = NSTableView()
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("apps"))
            let expected = [tr(.clientsAllApps), "com.apple.TextEdit, com.apple.Notes", tr(.clientsNo)]
            XCTAssertEqual(pane.numberOfRows(in: table), expected.count)
            for (row, label) in expected.enumerated() {
                let cell = try XCTUnwrap(pane.tableView(table, viewFor: column, row: row) as? NSTableCellView)
                XCTAssertEqual(cell.textField?.stringValue, label)
            }
        }
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

    /// Render only fake clients and a non-modal confirmation; never send an authorization command.
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
            let table = try XCTUnwrap(Self.descendants(view).compactMap { $0 as? NSTableView }.first)
            table.selectRowIndexes(IndexSet(integer: 1), byExtendingSelection: false)
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
                try Self.snapshot(view, to: directory.appendingPathComponent("grant-\(language.rawValue)-\(name).png"))
            }
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
                .write(to: directory.appendingPathComponent("grant-\(language.rawValue)-confirmation.png"))
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
    func revokeClient(_ id: String) {}
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
