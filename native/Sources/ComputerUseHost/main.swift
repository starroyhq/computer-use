import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import HostCore

final class HostApplication: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private let status = NSMenuItem(title: "尚未启动", action: nil, keyEquivalent: "")
    private let clientsMenu = NSMenu(title: "已配对客户端")
    private var httpItem: NSMenuItem!
    private var paths: HostPaths!
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
    private var httpEnabled = false
    private var alertActive = false
    private var pendingAlerts: [HostEvent] = []
    private var statusWindow: NSWindow?
    private var statusDetails: NSTextField?
    private let readerQueue = DispatchQueue(label: "com.starroy.computeruse.events")
    private var controlLease = ControlLease()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let resources = ProcessInfo.processInfo.environment["CU_RESOURCES_DIR"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.resourceURL!
        paths = HostPaths(resources: resources)
        buildMenu()
        do {
            lock = try HostLock(directory: paths.data)
            startServices()
            showStatusWindow()
        } catch {
            updateStatus(error.localizedDescription)
            showMessage("Computer Use 无法启动", error.localizedDescription)
            NSApp.terminate(nil)
        }
    }

    private func buildMenu() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "CU"
        let menu = NSMenu()
        menu.addItem(status)
        add("打开状态窗口", #selector(showStatusWindow), to: menu)
        menu.addItem(.separator())
        add("请求系统权限…", #selector(requestPermissions), to: menu)
        add("打开辅助功能设置", #selector(openAccessibility), to: menu)
        add("打开屏幕录制设置", #selector(openScreenRecording), to: menu)
        menu.addItem(.separator())
        add("暂停新动作", #selector(pause), to: menu)
        add("恢复接收动作", #selector(resume), to: menu)
        add("紧急停止", #selector(emergencyStop), to: menu, key: "!")
        add("重新启动服务", #selector(restart), to: menu)
        menu.addItem(.separator())
        httpItem = add("启用本机 HTTP MCP", #selector(toggleHTTP), to: menu)
        let clients = NSMenuItem(title: "撤销客户端", action: nil, keyEquivalent: "")
        clients.submenu = clientsMenu
        menu.addItem(clients)
        menu.addItem(.separator())
        add("安装 CLI 到 ~/.local/bin…", #selector(installCLI), to: menu)
        add("复制 MCP stdio 配置", #selector(copyConfiguration), to: menu)
        add("显示诊断", #selector(diagnostics), to: menu)
        menu.addItem(.separator())
        add("退出 Computer Use", #selector(quit), to: menu, key: "q")
        item.menu = menu
    }

    @discardableResult private func add(_ title: String, _ action: Selector, to menu: NSMenu, key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        menu.addItem(entry)
        return entry
    }

    private var permissionsGranted: Bool { AXIsProcessTrusted() && CGPreflightScreenCaptureAccess() }

    @objc private func requestPermissions() {
        AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        _ = CGRequestScreenCaptureAccess()
        updateStatus("授权后请完全退出并重新打开 App")
        showMessage("系统权限", "请在系统设置中允许 Computer Use 使用辅助功能和屏幕录制。授权发生变化后，请完全退出并重新打开本 App，以刷新系统缓存。CLI doctor 检查权限归属；截图是否可用还需通过 observe 验证。")
    }

    @objc private func openAccessibility() { openSettings("Privacy_Accessibility") }
    @objc private func openScreenRecording() { openSettings("Privacy_ScreenCapture") }
    private func openSettings(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }

    private func startServices() {
        guard driver == nil, runtime == nil, !stopping else { return }
        guard permissionsGranted else {
            updateStatus("需要辅助功能及屏幕录制权限")
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
                DispatchQueue.main.async { self?.childExited(token: token, child: "桌面驱动") }
            }
            try process.run()
            try? parentLiveness.fileHandleForReading.close()
            liveness = parentLiveness.fileHandleForWriting
            driver = process
            updateStatus("正在启动桌面驱动…")
            let deadline = Date().addingTimeInterval(15)
            startupTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] timer in
                guard let self, self.generation == token else { timer.invalidate(); return }
                do {
                    if try LocalSocket.acceptsConnections(path: self.paths.driverSocket) {
                        timer.invalidate(); self.startupTimer = nil
                        try self.startRuntime(token: token)
                    } else if Date() > deadline {
                        timer.invalidate(); self.fail("桌面驱动启动超时。")
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
            DispatchQueue.main.async { self?.childExited(token: token, child: "统一运行时") }
        }
        try process.run()
        runtime = process
        // The parent must not retain the worker's pipe ends, or EOF is hidden.
        try incoming.fileHandleForReading.close()
        try outgoing.fileHandleForWriting.close()
        input = incoming.fileHandleForWriting
        output = outgoing.fileHandleForReading
        updateStatus("正在启动统一运行时…")
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
                    self.fail("无法读取运行时事件：\(error.localizedDescription)")
                }
            }
        }
        startupTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in
            guard let self, self.generation == token, !self.running else { return }
            self.fail("统一运行时启动超时。")
        }
    }

    private func childExited(token: UUID, child: String) {
        guard generation == token, !stopping else { return }
        fail("\(child)已退出；服务停止，动作不会重放。")
    }

    private func handle(_ event: HostEvent) {
        switch event.event {
        case "ready":
            startupTimer?.invalidate(); startupTimer = nil
            running = true; updateStatus("就绪 · 后台模式")
        case "status": updateStatus(String((event.message ?? "").prefix(120)))
        case "fatal": fail(event.message ?? "运行时发生错误。")
        case "clients":
            clientsMenu.removeAllItems()
            for client in event.clients ?? [] {
                let entry = add(String(client.name.prefix(80)), #selector(revoke(_:)), to: clientsMenu)
                entry.representedObject = client.id
            }
        case "pair_request", "foreground_request":
            pendingAlerts.append(event)
            presentNextAlert()
        case "control_begin":
            guard let pid = event.pid else { return }
            if controlLease.begin(pid) { registerComputerControl(Int32(pid), true) }
            send("control_ready", pid: pid)
        case "control_end":
            guard let pid = event.pid else { return }
            if controlLease.end(pid) { registerComputerControl(Int32(pid), false) }
        default: break
        }
    }

    private func presentNextAlert() {
        guard !alertActive, !pendingAlerts.isEmpty, !stopping else { return }
        alertActive = true
        let event = pendingAlerts.removeFirst()
        let token = generation
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            defer { self.alertActive = false; self.presentNextAlert() }
            guard self.generation == token, !self.stopping else { return }
            let alert = NSAlert()
            if event.event == "pair_request" {
                alert.messageText = "允许客户端操作这些应用？"
                let apps = (event.appIds ?? []).joined(separator: "\n")
                alert.informativeText = "客户端：\(event.name ?? "")\n标识：\(event.clientId ?? "")\n应用标识：\n\(apps.isEmpty ? "无" : apps)\n独立受控浏览器：\(event.browser == true ? "允许" : "不允许")\n前台操作：允许（可能切换焦点、移动鼠标并模拟键盘）\n\n批准后长期有效，重启 App 也不再询问；在菜单中撤销该客户端即可收回全部权限。"
            } else {
                alert.messageText = "允许当前会话使用前台操作？"
                alert.informativeText = "客户端：\(event.clientName ?? "")\n目标：\(event.targetTitle ?? "")\n会话：\(event.sessionId ?? "")\n\n此操作可能切换焦点并移动鼠标。授权仅适用于此会话及目标应用。"
            }
            alert.addButton(withTitle: "拒绝")
            alert.addButton(withTitle: "允许")
            NSApp.activate(ignoringOtherApps: true)
            let allowed = alert.runModal() == .alertSecondButtonReturn
            guard self.generation == token, !self.stopping else { return }
            let prefix = event.event == "pair_request" ? "pair" : "foreground"
            self.send("\(prefix)_\(allowed ? "allow" : "deny")", clientID: event.clientId, sessionID: event.sessionId)
        }
    }

    private func send(_ command: String, clientID: String? = nil, sessionID: String? = nil, pid: Int? = nil) {
        guard let input else { return }
        do { try input.write(contentsOf: HostControl.encode(command, clientID: clientID, sessionID: sessionID, pid: pid)) }
        catch { if !stopping { fail("无法向运行时发送控制指令。") } }
    }

    @objc private func pause() { guard running else { return }; send("pause"); updateStatus("已暂停新动作") }
    @objc private func resume() { guard running else { return }; send("resume"); updateStatus("就绪 · 后台优先") }
    @objc private func emergencyStop() { stopServices(message: "紧急停止；请手动重启服务") }
    @objc private func restart() { stopServices(message: "正在重新启动…") { [weak self] in self?.startServices() } }
    @objc private func revoke(_ sender: NSMenuItem) { if let id = sender.representedObject as? String { send("revoke", clientID: id) } }
    @objc private func toggleHTTP() {
        guard running else { return }
        httpEnabled.toggle()
        httpItem.state = httpEnabled ? .on : .off
        send(httpEnabled ? "http_enable" : "http_disable")
    }
    private func fail(_ message: String) { stopServices(message: String(message.prefix(200))) }

    private func stopServices(message: String, completion: (() -> Void)? = nil) {
        guard !stopping else { return }
        stopping = true; running = false
        for pid in controlLease.endAll() { registerComputerControl(Int32(pid), false) }
        startupTimer?.invalidate(); startupTimer = nil
        pendingAlerts.removeAll()
        if alertActive { NSApp.abortModal() }
        updateStatus(message)
        send("stop")
        generation = UUID()
        httpEnabled = false; httpItem.state = .off
        clientsMenu.removeAllItems()
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

    @objc private func installCLI() {
        let fm = FileManager.default
        let directory = fm.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin", isDirectory: true)
        let link = directory.appendingPathComponent("computer-use")
        do {
            guard fm.isExecutableFile(atPath: paths.cli.path) else { throw HostFailure.resourcesUnavailable }
            let alert = NSAlert()
            alert.messageText = "安装命令行入口"
            alert.informativeText = "将在 \(link.path) 创建指向当前 App 的符号链接。请将 ~/.local/bin 加入 PATH。"
            alert.addButton(withTitle: "安装"); alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            if let current = try? fm.destinationOfSymbolicLink(atPath: link.path), current == paths.cli.path {
                showMessage("CLI 已安装", link.path); return
            }
            // Never overwrite an existing binary, directory, or another symlink.
            try fm.createSymbolicLink(at: link, withDestinationURL: paths.cli)
            showMessage("CLI 已安装", "\(link.path)\n运行 computer-use doctor 检查服务。")
        } catch { showMessage("CLI 安装失败", error.localizedDescription) }
    }
    @objc private func copyConfiguration() {
        do {
            let text = try paths.stdioConfiguration()
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            showMessage("已复制 MCP 配置", "先使用 computer-use pair 完成客户端授权，再将配置添加到 Agent。")
        } catch { showMessage("无法复制配置", error.localizedDescription) }
    }
    @objc private func diagnostics() { showStatusWindow() }

    private func updateStatus(_ text: String) {
        status.title = text
        if statusWindow?.isVisible == true { refreshStatus() }
    }

    // Reopening the app must work even when the menu-bar item is hidden or inaccessible.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showStatusWindow()
        return false
    }

    @objc private func refreshStatus() {
        statusDetails?.stringValue = "服务：\(status.title)\n辅助功能：\(AXIsProcessTrusted() ? "已授权" : "未授权")\n屏幕录制：\(CGPreflightScreenCaptureAccess() ? "已授权" : "未授权")\n本机 HTTP：\(httpEnabled ? "已请求启用" : "关闭")\n截图能力：需连接服务后实际验证"
    }

    @objc private func showStatusWindow() {
        if statusWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 580, height: 340),
                                  styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Computer Use — 状态与权限"
            window.isReleasedWhenClosed = false
            let stack = NSStackView()
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 16
            stack.translatesAutoresizingMaskIntoConstraints = false
            let details = NSTextField(wrappingLabelWithString: "")
            details.font = .systemFont(ofSize: 15)
            details.setAccessibilityLabel("权限和服务状态")
            statusDetails = details
            stack.addArrangedSubview(details)
            let explanation = NSTextField(wrappingLabelWithString: "授权后请退出并重新打开应用。关闭此窗口后服务仍在菜单栏运行；再次打开应用可返回此处。")
            explanation.textColor = .secondaryLabelColor
            stack.addArrangedSubview(explanation)
            for entries: [(String, Selector)] in [
                [("请求系统权限…", #selector(requestPermissions)), ("打开辅助功能设置", #selector(openAccessibility)), ("打开屏幕录制设置", #selector(openScreenRecording))],
                [("刷新状态", #selector(refreshStatus)), ("重新启动服务", #selector(restart)), ("退出 Computer Use", #selector(quit))]
            ] {
                let row = NSStackView()
                row.spacing = 8
                for (title, selector) in entries {
                    row.addArrangedSubview(NSButton(title: title, target: self, action: selector))
                }
                stack.addArrangedSubview(row)
            }
            let content = window.contentView!
            content.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
                stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
                stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
                stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
                details.widthAnchor.constraint(equalTo: stack.widthAnchor),
                explanation.widthAnchor.constraint(equalTo: stack.widthAnchor)
            ])
            window.center()
            statusWindow = window
        }
        refreshStatus()
        statusWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    private func showMessage(_ title: String, _ message: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = message
        alert.addButton(withTitle: "好"); NSApp.activate(ignoringOtherApps: true); alert.runModal()
    }
    @objc private func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if driver == nil && runtime == nil { return .terminateNow }
        if stopping {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { NSApp.reply(toApplicationShouldTerminate: true) }
        } else {
            stopServices(message: "正在退出…") { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) {
        for pid in controlLease.endAll() { registerComputerControl(Int32(pid), false) }
        terminateChildren()
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

let application = NSApplication.shared
let delegate = HostApplication()
application.delegate = delegate
application.run()
