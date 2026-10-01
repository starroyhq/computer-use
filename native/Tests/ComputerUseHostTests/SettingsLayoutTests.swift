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
    let paths = HostPaths(resources: URL(fileURLWithPath: "/Applications/Computer Use.app/Contents/Resources"),
                          home: FileManager.default.temporaryDirectory)
    var serviceState = ServiceState.ready
    var serviceStatus = tr(.statusReady)
    var isRunning = true
    var clients: [ClientRecord] = []
    var httpEnabled = false
    var httpStatus: String?
    var controlledAppCount = 0
    var permissionsGranted = true
    var teamID: String? = "A1B2C3D4E5"
    lazy var updates = UpdateController(paths: paths, info: ["CFBundleShortVersionString": "0.4.0", "CFBundleVersion": "5"], teamID: teamID)

    func pauseActions() {}
    func resumeActions() {}
    func emergencyStop() {}
    func restartServices() {}
    func revokeClient(_ id: String) {}
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
            ClientRecord(id: "1", name: "Codex", appIds: ["com.apple.TextEdit", "com.apple.Notes"], browser: false, foreground: true),
            ClientRecord(id: "2", name: "Browser Agent", appIds: [], browser: true, foreground: true),
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
