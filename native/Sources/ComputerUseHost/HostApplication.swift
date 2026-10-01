import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import HostCore

/// 服务所处的阶段；决定菜单栏图标和设置窗口里的状态。
enum ServiceState {
    case stopped, starting, ready, paused, failed, needsPermissions, installing
}

/// 设置窗口读取的宿主状态与可以执行的操作。
protocol HostContext: AnyObject {
    var paths: HostPaths { get }
    var serviceState: ServiceState { get }
    var serviceStatus: String { get }
    var isRunning: Bool { get }
    var clients: [ClientRecord] { get }
    var httpEnabled: Bool { get }
    var httpStatus: String? { get }
    var controlledAppCount: Int { get }
    var permissionsGranted: Bool { get }
    var updates: UpdateController { get }
    func pauseActions()
    func resumeActions()
    func emergencyStop()
    func restartServices()
    func revokeClient(_ id: String)
    func setHTTPEnabled(_ enabled: Bool)
    func requestPermissions()
    func installCLI()
    func copyConfiguration()
    func quitForUpdate()
}

final class HostApplication: NSObject, NSApplicationDelegate, NSMenuDelegate, HostContext {
    let paths = HostPaths(resources: HostApplication.resourceDirectory())
    private(set) lazy var updates = UpdateController(paths: paths)
    private var item: NSStatusItem!
    private let statusLine = NSMenuItem(title: tr(.statusNotStarted), action: nil, keyEquivalent: "")
    private var pauseItem: NSMenuItem!
    private var stopItem: NSMenuItem!
    private var updateItem: NSMenuItem!
    private var settings: SettingsWindowController?
    private var lock: HostLock?
    private var driver: Process?
    private var runtime: Process?
    private var liveness: FileHandle?
    private var input: FileHandle?
    private var output: FileHandle?
    private var startupTimer: Timer?
    private var generation = UUID()
    private var running = false
    private var stopping = false
    private var quittingForUpdate = false
    private var alertActive = false
    // 审批请求队列；运行时回报请求已结束时，据此撤回排队中或正在显示的弹窗。
    private var approvals = ApprovalQueue()
    private var activeAlert: NSAlert?
    private let readerQueue = DispatchQueue(label: "com.starroy.computeruse.events")
    private var controlLease = ControlLease()
    private var statusText = tr(.statusNotStarted)

    private(set) var serviceState = ServiceState.stopped
    private(set) var clients: [ClientRecord] = []
    private(set) var httpEnabled = false
    private(set) var httpStatus: String?
    var isRunning: Bool { running }
    var controlledAppCount: Int { controlLease.counts.count }
    var permissionsGranted: Bool { AXIsProcessTrusted() && CGPreflightScreenCaptureAccess() }
    var serviceStatus: String {
        if serviceState == .ready, !controlLease.counts.isEmpty { return tr(.statusControlling, controlLease.counts.count) }
        return statusText
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        NSApp.mainMenu = Self.mainMenu()
        buildMenu()
        do {
            lock = try HostLock(directory: paths.data)
        } catch {
            setStatus(error.localizedDescription, state: .failed)
            Alerts.show(tr(.failureLaunchTitle), error.localizedDescription)
            NSApp.terminate(nil)
            return
        }
        updates.host = self
        updates.onChange = { [weak self] in self?.stateChanged() }
        updates.start()
        startServices()
        // 只在需要处理时打开设置窗口（首次安装或权限缺失）；平时只在菜单栏运行。
        if !permissionsGranted { showSettings(.status) }
    }

    // 发行版只使用 App 自带的资源：同一用户的其他进程可以用 launchctl setenv 注入环境变量，
    // 若仍接受覆盖，持有辅助功能和屏幕录制权限的宿主就会启动任意程序。
    private static func resourceDirectory() -> URL {
        #if CU_RESOURCES_OVERRIDE
        if let override = ProcessInfo.processInfo.environment["CU_RESOURCES_DIR"] {
            return URL(fileURLWithPath: override)
        }
        #endif
        return Bundle.main.resourceURL!
    }

    // MARK: 菜单与状态图标

    /// 菜单栏 App 没有自己的菜单栏，但设置窗口仍需要 ⌘W、⌘Q 和复制等快捷键。
    private static func mainMenu() -> NSMenu {
        let main = NSMenu()
        let app = NSMenu()
        app.addItem(withTitle: tr(.menuSettings), action: #selector(HostApplication.openSettings), keyEquivalent: ",")
        app.addItem(.separator())
        app.addItem(withTitle: tr(.menuQuit), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        for submenu in [app, edit, window] {
            let entry = NSMenuItem()
            entry.submenu = submenu
            main.addItem(entry)
        }
        return main
    }

    private func buildMenu() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        add(tr(.menuSettings), #selector(openSettings), to: menu, key: ",")
        pauseItem = add(tr(.menuPause), #selector(togglePause), to: menu)
        stopItem = add(tr(.menuEmergencyStop), #selector(emergencyStopFromMenu), to: menu, key: "!")
        add(tr(.menuRestart), #selector(restartFromMenu), to: menu)
        menu.addItem(.separator())
        updateItem = add("", #selector(showAvailableUpdate), to: menu)
        updateItem.isHidden = true
        add(tr(.menuCheckUpdates), #selector(checkForUpdates), to: menu)
        menu.addItem(.separator())
        add(tr(.menuQuit), #selector(quit), to: menu, key: "q")
        item.menu = menu
        refreshMenu()
    }

    @discardableResult private func add(_ title: String, _ action: Selector, to menu: NSMenu, key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        menu.addItem(entry)
        return entry
    }

    func menuNeedsUpdate(_ menu: NSMenu) { refreshMenu() }

    private func refreshMenu() {
        guard item != nil else { return }
        statusLine.title = serviceStatus
        pauseItem.title = serviceState == .paused ? tr(.menuResume) : tr(.menuPause)
        pauseItem.isEnabled = running
        stopItem.isEnabled = running || serviceState == .starting
        if let check = updates.announced {
            updateItem.title = tr(.menuUpdateAvailable, check.latest)
            updateItem.isHidden = false
        } else {
            updateItem.isHidden = true
        }
        refreshIcon()
    }

    private func refreshIcon() {
        let symbol: String
        switch serviceState {
        case .starting, .installing: symbol = "hourglass"
        case .ready: symbol = controlLease.counts.isEmpty ? "cursorarrow.rays" : "cursorarrow.click.2"
        case .paused: symbol = "pause.circle"
        case .failed, .needsPermissions: symbol = "exclamationmark.triangle"
        case .stopped: symbol = "stop.circle"
        }
        let description = tr(.statusItemAccessibility, serviceStatus)
        guard let button = item.button else { return }
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: description) {
            image.isTemplate = true
            button.image = image
            button.title = ""
        } else {
            button.image = nil
            button.title = "CU"
        }
        button.toolTip = description
        button.setAccessibilityLabel(description)
    }

    private func setStatus(_ text: String, state: ServiceState? = nil) {
        statusText = text
        if let state { serviceState = state }
        stateChanged()
    }

    private func stateChanged() {
        refreshMenu()
        settings?.refresh()
    }

    // MARK: 设置窗口

    func showSettings(_ pane: SettingsPane? = nil) {
        if settings == nil { settings = SettingsWindowController(context: self) }
        settings?.show(pane)
    }

    @objc func openSettings() { showSettings() }
    @objc private func showAvailableUpdate() { showSettings(.updates) }
    @objc private func checkForUpdates() {
        showSettings(.updates)
        updates.check(manual: true)
    }

    // 再次打开 App 时回到设置窗口；菜单栏图标被隐藏或不可用时也能找到它。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showSettings()
        return false
    }

    // MARK: 系统权限

    func requestPermissions() {
        AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        _ = CGRequestScreenCaptureAccess()
        if !running { setStatus(tr(.statusReopenAfterGrant)) }
        Alerts.show(tr(.permissionsTitle), tr(.permissionsBody))
    }

    // MARK: 服务

    private func startServices() {
        guard driver == nil, runtime == nil, !stopping else { return }
        guard permissionsGranted else {
            setStatus(tr(.statusPermissionsNeeded), state: .needsPermissions)
            return
        }
        do {
            try paths.validateResources()
            // No unowned socket is unlinked: a live endpoint indicates another owner.
            for path in [paths.driverSocket, paths.runtimeSocket] {
                try LocalSocket.removeStale(path: path)
            }
            let token = UUID()
            generation = token
            let process = Process()
            process.executableURL = paths.driver
            process.arguments = paths.driverArguments
            process.environment = paths.childEnvironment(from: ProcessInfo.processInfo.environment)
            let parentLiveness = Pipe()
            process.standardInput = parentLiveness
            // Driver logs may contain UI content. Do not persist or relay them by default.
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { [weak self] _ in
                DispatchQueue.main.async { self?.childExited(token: token, child: tr(.childDriver)) }
            }
            try process.run()
            try? parentLiveness.fileHandleForReading.close()
            liveness = parentLiveness.fileHandleForWriting
            driver = process
            setStatus(tr(.statusStartingDriver), state: .starting)
            let deadline = Date().addingTimeInterval(15)
            startupTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] timer in
                guard let self, self.generation == token else { timer.invalidate(); return }
                do {
                    if try LocalSocket.acceptsConnections(path: self.paths.driverSocket) {
                        timer.invalidate(); self.startupTimer = nil
                        try self.startRuntime(token: token)
                    } else if Date() > deadline {
                        timer.invalidate(); self.fail(tr(.failureDriverTimeout))
                    }
                } catch { timer.invalidate(); self.fail(error.localizedDescription) }
            }
        } catch { fail(error.localizedDescription) }
    }

    private func startRuntime(token: UUID) throws {
        let process = Process()
        let incoming = Pipe(), outgoing = Pipe()
        process.executableURL = paths.node
        process.arguments = paths.runtimeArguments
        process.environment = paths.childEnvironment(from: ProcessInfo.processInfo.environment)
        process.standardInput = incoming
        process.standardOutput = outgoing
        process.standardError = FileHandle.standardError
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.childExited(token: token, child: tr(.childRuntime)) }
        }
        try process.run()
        runtime = process
        // The parent must not retain the worker's pipe ends, or EOF is hidden.
        try incoming.fileHandleForReading.close()
        try outgoing.fileHandleForWriting.close()
        input = incoming.fileHandleForWriting
        output = outgoing.fileHandleForReading
        setStatus(tr(.statusStartingRuntime), state: .starting)
        let handle = outgoing.fileHandleForReading
        readerQueue.async { [weak self] in
            var framer = LineFramer()
            do {
                while true {
                    let chunk = try HostEventReader.readChunk(from: handle)
                    if chunk.isEmpty { break }
                    for line in try framer.consume(chunk) {
                        let event = try HostEvent.parse(line)
                        DispatchQueue.main.async {
                            guard let self, self.generation == token, !self.stopping else { return }
                            self.handle(event)
                        }
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self, self.generation == token, !self.stopping else { return }
                    self.fail(tr(.failureReadEvents, error.localizedDescription))
                }
            }
        }
        startupTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in
            guard let self, self.generation == token, !self.running else { return }
            self.fail(tr(.failureRuntimeTimeout))
        }
    }

    private func childExited(token: UUID, child: String) {
        guard generation == token, !stopping else { return }
        fail(tr(.failureChildExited, child))
    }

    private func handle(_ event: HostEvent) {
        switch event.event {
        case "ready":
            startupTimer?.invalidate(); startupTimer = nil
            running = true
            setStatus(tr(.statusReady), state: .ready)
        case "status":
            let message = String((event.message ?? "").prefix(200))
            // 运行时的状态消息目前只报告本机 HTTP 监听结果，显示在“接入”分区。
            if message.hasPrefix("Local MCP: ") || message.hasPrefix("HTTP listener") {
                httpStatus = message
                if message.hasPrefix("HTTP listener") { httpEnabled = false }
                stateChanged()
            } else {
                setStatus(String(message.prefix(120)))
            }
        case "fatal": fail(event.message ?? tr(.failureRuntime))
        case "clients":
            clients = event.clients ?? []
            stateChanged()
        case "pair_request", "foreground_request":
            approvals.enqueue(event)
            presentNextAlert()
        case "decision_finished":
            // 请求已结束（批准、拒绝或 60 秒过期）：排队中的弹窗不再显示；正在显示的直接撤回，且不再发送决定。
            guard let id = event.requestId else { return }
            let showing = approvals.activeID == id
            let withdrawn = approvals.finish(id)
            if showing { abortActiveAlert() }
            if withdrawn && event.approved != true { setStatus(tr(.statusRequestExpired)) }
        case "control_begin":
            guard let pid = event.pid else { return }
            if controlLease.begin(pid) { registerComputerControl(Int32(pid), true) }
            send("control_ready", pid: pid)
            stateChanged()
        case "control_end":
            guard let pid = event.pid else { return }
            if controlLease.end(pid) { registerComputerControl(Int32(pid), false) }
            stateChanged()
        default: break
        }
    }

    // MARK: 审批

    private func presentNextAlert() {
        // 取出即登记为当前请求：弹窗真正显示前收到结束通知也能撤回。
        guard !alertActive, !stopping, let event = approvals.activateNext() else { return }
        alertActive = true
        let token = generation
        // runModal 不能放进 GCD 主队列块：主队列是串行的，弹窗期间撤回通知、fatal 和子进程退出
        // 都会排在这个块后面，直到用户关掉弹窗。改由 run loop 计时器回调显示，模态期间主队列照常执行。
        let timer = Timer(timeInterval: 0, repeats: false) { [weak self] _ in self?.showApproval(event, token: token) }
        RunLoop.main.add(timer, forMode: .default)
        RunLoop.main.add(timer, forMode: .modalPanel)
    }

    private func showApproval(_ event: HostEvent, token: UUID) {
        defer {
            alertActive = false
            activeAlert = nil
            approvals.deactivate()
            presentNextAlert()
        }
        guard generation == token, !stopping, !approvals.activeWithdrawn else { return }
        let alert = NSAlert()
        if event.event == "pair_request" {
            alert.messageText = tr(.approvalPairTitle)
            let apps = (event.appIds ?? []).joined(separator: "\n")
            alert.informativeText = tr(.approvalPairBody, event.name ?? "", event.clientId ?? "",
                                       apps.isEmpty ? tr(.approvalNone) : apps,
                                       event.browser == true ? tr(.approvalAllowed) : tr(.approvalNotAllowed),
                                       event.foreground == false ? tr(.approvalNotAllowed) : tr(.approvalForegroundAllowed))
        } else {
            alert.messageText = tr(.approvalForegroundTitle)
            alert.informativeText = tr(.approvalForegroundBody, event.clientName ?? "", event.targetTitle ?? "", event.sessionId ?? "")
        }
        alert.addButton(withTitle: tr(.approvalDeny))
        alert.addButton(withTitle: tr(.approvalAllow))
        activeAlert = alert
        NSApp.activate(ignoringOtherApps: true)
        let allowed = alert.runModal() == .alertSecondButtonReturn
        // 弹窗被撤回（请求已过期或已处理）时，运行时不再接受决定。
        guard generation == token, !stopping, !approvals.activeWithdrawn else { return }
        let prefix = event.event == "pair_request" ? "pair" : "foreground"
        send("\(prefix)_\(allowed ? "allow" : "deny")", clientID: event.clientId, sessionID: event.sessionId)
    }

    // 只结束审批弹窗自己的模态循环，不影响同时打开的其他提示框；
    // 弹窗尚未进入模态循环时，由 approvals.activeWithdrawn 或 generation 阻止它显示。
    private func abortActiveAlert() {
        if let alert = activeAlert, NSApp.modalWindow === alert.window { NSApp.abortModal() }
    }

    private func send(_ command: String, clientID: String? = nil, sessionID: String? = nil, pid: Int? = nil) {
        guard let input else { return }
        do { try input.write(contentsOf: HostControl.encode(command, clientID: clientID, sessionID: sessionID, pid: pid)) }
        catch { if !stopping { fail(tr(.failureSendControl)) } }
    }

    // MARK: 控制

    func pauseActions() {
        guard running, serviceState == .ready else { return }
        send("pause")
        setStatus(tr(.statusPaused), state: .paused)
    }

    func resumeActions() {
        guard running, serviceState == .paused else { return }
        send("resume")
        setStatus(tr(.statusReady), state: .ready)
    }

    func emergencyStop() { stopServices(message: tr(.statusEmergencyStopped), state: .stopped) }
    func restartServices() { stopServices(message: tr(.statusRestarting), state: .starting) { [weak self] in self?.startServices() } }
    func revokeClient(_ id: String) { send("revoke", clientID: id) }

    func setHTTPEnabled(_ enabled: Bool) {
        guard running, enabled != httpEnabled else { return }
        httpEnabled = enabled
        httpStatus = nil
        send(enabled ? "http_enable" : "http_disable")
        stateChanged()
    }

    @objc private func togglePause() { serviceState == .paused ? resumeActions() : pauseActions() }
    @objc private func emergencyStopFromMenu() { emergencyStop() }
    @objc private func restartFromMenu() { restartServices() }

    private func fail(_ message: String) { stopServices(message: String(message.prefix(200)), state: .failed) }

    private func stopServices(message: String, state: ServiceState, completion: (() -> Void)? = nil) {
        guard !stopping else { return }
        stopping = true; running = false
        for pid in controlLease.endAll() { registerComputerControl(Int32(pid), false) }
        startupTimer?.invalidate(); startupTimer = nil
        approvals.removeAll()
        abortActiveAlert()
        send("stop")
        generation = UUID()
        httpEnabled = false; httpStatus = nil
        clients = []
        setStatus(message, state: state)
        // Give the runtime a bounded opportunity to release keys and close sessions.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self else { return }
            self.terminateChildren()
            self.stopping = false
            completion?()
        }
    }

    private func terminateChildren() {
        try? liveness?.close(); liveness = nil
        try? input?.close(); input = nil
        for child in [runtime, driver].compactMap({ $0 }) where child.isRunning {
            child.terminate()
            let deadline = Date().addingTimeInterval(0.15)
            while child.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
            if child.isRunning {
                kill(child.processIdentifier, SIGKILL)
                let killDeadline = Date().addingTimeInterval(0.5)
                while child.isRunning && Date() < killDeadline { Thread.sleep(forTimeInterval: 0.01) }
            }
        }
        runtime = nil; driver = nil
        try? output?.close(); output = nil
    }

    // MARK: 接入

    func installCLI() {
        let fm = FileManager.default
        let link = CLIInstallation.link
        let directory = link.deletingLastPathComponent()
        do {
            guard fm.isExecutableFile(atPath: paths.cli.path) else { throw HostFailure.resourcesUnavailable }
            guard Alerts.confirm(tr(.cliTitle), tr(.cliBody, link.path), confirm: tr(.cliInstall)) else { return }
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            if CLIInstallation.state(paths: paths) == .installed {
                Alerts.show(tr(.cliDone), link.path)
                return
            }
            // Never overwrite an existing binary, directory, or another symlink.
            try fm.createSymbolicLink(at: link, withDestinationURL: paths.cli)
            stateChanged()
            Alerts.show(tr(.cliDone), tr(.cliDoneBody, link.path))
        } catch {
            stateChanged()
            Alerts.show(tr(.cliFailed), error.localizedDescription)
        }
    }

    func copyConfiguration() {
        do {
            let text = try paths.stdioConfiguration()
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            Alerts.show(tr(.connectCopied), tr(.connectCopiedBody))
        } catch { Alerts.show(tr(.connectCopyFailed), error.localizedDescription) }
    }

    // MARK: 退出与更新

    func quitForUpdate() {
        quittingForUpdate = true
        NSApp.terminate(nil)
    }

    @objc private func quit() { NSApp.terminate(nil) }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if driver == nil && runtime == nil { return .terminateNow }
        if stopping {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { NSApp.reply(toApplicationShouldTerminate: true) }
        } else {
            let message = quittingForUpdate ? tr(.statusInstallingUpdate) : tr(.statusQuitting)
            stopServices(message: message, state: quittingForUpdate ? .installing : .stopped) {
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        updates.stop()
        for pid in controlLease.endAll() { registerComputerControl(Int32(pid), false) }
        terminateChildren()
    }
}

/// `~/.local/bin/computer-use` 的安装状态。
enum CLIInstallation {
    enum State { case installed, missing, other }

    static var link: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/computer-use")
    }

    static func state(paths: HostPaths) -> State {
        let fm = FileManager.default
        if let destination = try? fm.destinationOfSymbolicLink(atPath: link.path) {
            return destination == paths.cli.path ? .installed : .other
        }
        return fm.fileExists(atPath: link.path) ? .other : .missing
    }
}

/// 提示框。只在 run loop 回调（按钮、菜单、计时器）里调用，不要在 GCD 主队列块里调用。
enum Alerts {
    static func show(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: tr(.commonOK))
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    static func confirm(_ title: String, _ message: String, confirm: String, destructive: Bool = false) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        let button = alert.addButton(withTitle: confirm)
        button.hasDestructiveAction = destructive
        alert.addButton(withTitle: tr(.commonCancel))
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// 在 run loop 计时器里执行，适合从 GCD 回调里弹出模态框；只在默认模式触发，不叠在其他模态框上。
    static func later(_ work: @escaping () -> Void) {
        RunLoop.main.add(Timer(timeInterval: 0, repeats: false) { _ in work() }, forMode: .default)
    }
}

// 向系统登记该进程正在被控制。1 为登记，其它值撤销。符号缺失时标记失败，会话仍然继续。
private let registerComputerControl: (Int32, Bool) -> Void = {
    let path = "/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices"
    guard let handle = dlopen(path, RTLD_LAZY),
          let symbol = dlsym(handle, "_AXRegisterControlComputerAccess") else { return { _, _ in } }
    let register = unsafeBitCast(symbol, to: (@convention(c) (Int32, Int32) -> Void).self)
    return { pid, enabled in register(pid, enabled ? 1 : 0) }
}()
