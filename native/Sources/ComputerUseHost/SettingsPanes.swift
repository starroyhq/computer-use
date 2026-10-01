import AppKit
import ApplicationServices
import CoreGraphics
import HostCore

/// 分区控制器的公共部分：持有宿主上下文，并在视图未加载时忽略刷新。
class PaneController: NSViewController {
    // 强引用：宿主与设置窗口都存活到进程结束，强引用避免任何悬空访问。
    let context: HostContext

    init(context: HostContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }
}

// MARK: 通用

final class GeneralPane: PaneController, SettingsPaneView {
    private lazy var launchAtLogin = Form.checkbox(tr(.generalLaunchAtLogin), self, #selector(toggleLaunchAtLogin))
    private lazy var openLoginItems = Form.button(tr(.generalOpenLoginItems), self, #selector(showLoginItems))
    private lazy var installCLI = Form.button(tr(.generalInstallCLI), self, #selector(install))
    private let loginHint = Form.note(tr(.generalLoginNeedsApproval))
    private let cliStatus = Form.note()
    private var approvalRows: [NSGridRow] = []

    override func loadView() {
        let form = FormBuilder()
        form.add(tr(.generalStartup), launchAtLogin)
        approvalRows = [form.add(nil, loginHint), form.add(nil, openLoginItems)]
        form.add(tr(.generalCLI), installCLI, gap: 14)
        form.add(nil, cliStatus)
        form.add(tr(.generalLanguage), Form.value(tr(.generalLanguageValue)), gap: 14)
        view = Form.page(form.grid)
    }

    func refresh() {
        launchAtLogin.state = LoginItem.isOn ? .on : .off
        for row in approvalRows { row.isHidden = LoginItem.status != .requiresApproval }
        switch CLIInstallation.state(paths: context.paths) {
        case .installed:
            cliStatus.stringValue = tr(.generalCLIInstalled, CLIInstallation.link.path)
            installCLI.isEnabled = false
        case .missing:
            cliStatus.stringValue = tr(.generalCLINotInstalled)
            installCLI.isEnabled = true
        case .other:
            cliStatus.stringValue = tr(.generalCLIOther, CLIInstallation.link.path)
            installCLI.isEnabled = false
        }
    }

    @objc private func toggleLaunchAtLogin() {
        do { try LoginItem.setEnabled(launchAtLogin.state == .on) } catch {
            Alerts.show(tr(.generalLoginFailed), error.localizedDescription)
        }
        refresh()
    }

    @objc private func showLoginItems() { LoginItem.openSystemSettings() }
    @objc private func install() { context.installCLI() }
}

// MARK: 权限与状态

/// 权限状态：图标加文字，颜色之外用文字区分。
final class PermissionIndicator: NSStackView {
    private let icon = NSImageView()
    private let text = NSTextField(labelWithString: "")

    init() {
        super.init(frame: .zero)
        orientation = .horizontal
        spacing = 4
        alignment = .centerY
        addArrangedSubview(icon)
        addArrangedSubview(text)
    }

    required init?(coder: NSCoder) { nil }

    func set(_ granted: Bool) {
        text.stringValue = granted ? tr(.statusGranted) : tr(.statusDenied)
        icon.image = NSImage(systemSymbolName: granted ? "checkmark.circle.fill" : "xmark.circle.fill", accessibilityDescription: nil)
        icon.contentTintColor = granted ? .systemGreen : .systemRed
    }
}

final class StatusPane: PaneController, SettingsPaneView {
    private let service = Form.value()
    private let accessibility = PermissionIndicator()
    private let screenRecording = PermissionIndicator()
    private lazy var pauseButton = Form.button(tr(.menuPause), self, #selector(togglePause))
    private lazy var stopButton = Form.button(tr(.menuEmergencyStop), self, #selector(stop))

    override func loadView() {
        let form = FormBuilder()
        form.add(tr(.statusService), service)
        form.add(tr(.statusAccessibility),
                 Form.row([accessibility, Form.button(tr(.statusOpenSystemSettings), self, #selector(openAccessibility))]),
                 center: true, gap: 14)
        form.add(tr(.statusScreenRecording),
                 Form.row([screenRecording, Form.button(tr(.statusOpenSystemSettings), self, #selector(openScreenRecording))]),
                 center: true)
        form.add(nil, Form.button(tr(.statusRequestPermissions), self, #selector(request)))
        form.add(nil, Form.note(tr(.statusPermissionsHint)))
        form.add(tr(.statusControl),
                 Form.row([pauseButton, stopButton, Form.button(tr(.menuRestart), self, #selector(restart))]),
                 center: true, gap: 14)
        view = Form.page(form.grid)
    }

    func refresh() {
        service.stringValue = context.serviceStatus
        accessibility.set(AXIsProcessTrusted())
        screenRecording.set(CGPreflightScreenCaptureAccess())
        pauseButton.title = context.serviceState == .paused ? tr(.menuResume) : tr(.menuPause)
        pauseButton.isEnabled = context.isRunning
        stopButton.isEnabled = context.isRunning || context.serviceState == .starting
    }

    @objc private func openAccessibility() { Self.openPrivacy("Privacy_Accessibility") }
    @objc private func openScreenRecording() { Self.openPrivacy("Privacy_ScreenCapture") }
    @objc private func request() { context.requestPermissions() }
    @objc private func togglePause() { context.serviceState == .paused ? context.resumeActions() : context.pauseActions() }
    @objc private func stop() { context.emergencyStop() }
    @objc private func restart() { context.restartServices() }

    private static func openPrivacy(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }
}

// MARK: 客户端

final class ClientsPane: PaneController, SettingsPaneView, NSTableViewDataSource, NSTableViewDelegate {
    private enum Column: String, CaseIterable {
        case name, apps, browser, foreground
    }

    private let table = NSTableView()
    private let placeholder = Form.note()
    private lazy var revokeButton = Form.button(tr(.clientsRevoke), self, #selector(revoke))
    private var rows: [ClientRecord] = []

    override func loadView() {
        for column in Column.allCases {
            let item = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(column.rawValue))
            switch column {
            case .name: item.title = tr(.clientsName); item.width = 130
            case .apps: item.title = tr(.clientsApps); item.width = 170
            case .browser: item.title = tr(.clientsBrowser); item.width = 80
            case .foreground: item.title = tr(.clientsForeground); item.width = 70
            }
            item.minWidth = 50
            table.addTableColumn(item)
        }
        table.dataSource = self
        table.delegate = self
        table.usesAlternatingRowBackgroundColors = true
        table.allowsMultipleSelection = false
        table.style = .inset
        // 列宽按比例缩放到表格宽度，最后一列不会被裁掉。
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.setAccessibilityLabel(tr(.paneClients))
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 190).isActive = true
        placeholder.preferredMaxLayoutWidth = Form.pageWidth - 56
        let hint = Form.note(tr(.clientsHint))
        hint.preferredMaxLayoutWidth = Form.pageWidth - 56
        let stack = Form.column([scroll, revokeButton, placeholder, hint])
        // 表格和说明文字铺满分区宽度，文字在这个宽度内换行。
        NSLayoutConstraint.activate([scroll, placeholder, hint].map { $0.widthAnchor.constraint(equalTo: stack.widthAnchor) })
        view = Form.page(stack, fill: true)
    }

    func refresh() {
        let selected = table.selectedRow >= 0 && table.selectedRow < rows.count ? rows[table.selectedRow].id : nil
        let next = context.isRunning ? context.clients : []
        if next != rows {
            rows = next
            table.reloadData()
            if let selected, let index = rows.firstIndex(where: { $0.id == selected }) {
                table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
            }
        }
        placeholder.stringValue = !context.isRunning ? tr(.clientsNotRunning) : rows.isEmpty ? tr(.clientsEmpty) : ""
        placeholder.isHidden = placeholder.stringValue.isEmpty
        revokeButton.isEnabled = context.isRunning && table.selectedRow >= 0
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let identifier = tableColumn?.identifier, let column = Column(rawValue: identifier.rawValue), row < rows.count else { return nil }
        let client = rows[row]
        let text: String
        switch column {
        case .name: text = client.name
        case .apps: text = (client.appIds ?? []).isEmpty ? tr(.clientsNo) : (client.appIds ?? []).joined(separator: ", ")
        case .browser: text = client.browser == true ? tr(.clientsYes) : tr(.clientsNo)
        case .foreground: text = client.foreground == true ? tr(.clientsYes) : tr(.clientsNo)
        }
        let cell = (tableView.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView) ?? {
            let cell = NSTableCellView()
            cell.identifier = identifier
            let field = NSTextField(labelWithString: "")
            field.lineBreakMode = .byTruncatingTail
            field.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(field)
            cell.textField = field
            NSLayoutConstraint.activate([
                field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
                field.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -2),
                field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
            return cell
        }()
        cell.textField?.stringValue = text
        cell.toolTip = column == .apps ? text : nil
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        revokeButton.isEnabled = context.isRunning && table.selectedRow >= 0
    }

    @objc private func revoke() {
        guard table.selectedRow >= 0, table.selectedRow < rows.count else { return }
        let client = rows[table.selectedRow]
        guard Alerts.confirm(tr(.clientsRevokeTitle, client.name), tr(.clientsRevokeBody), confirm: tr(.clientsRevoke).replacingOccurrences(of: "…", with: ""),
                             destructive: true) else { return }
        context.revokeClient(client.id)
    }
}

// MARK: 接入

final class ConnectPane: PaneController, SettingsPaneView {
    private lazy var httpToggle = Form.checkbox(tr(.connectHTTPToggle), self, #selector(toggleHTTP))
    private let httpAddress = Form.value()
    private lazy var copyAddress = Form.button(tr(.connectCopyAddress), self, #selector(copyHTTPAddress))
    private var addressRow: NSGridRow?

    override func loadView() {
        let form = FormBuilder()
        form.add(tr(.connectHTTP), httpToggle)
        form.add(nil, Form.note(tr(.connectHTTPHint)))
        addressRow = form.add(nil, Form.row([httpAddress, copyAddress]), center: true)
        form.add(tr(.connectStdio), Form.button(tr(.connectCopy), self, #selector(copyConfiguration)), gap: 14)
        form.add(tr(.connectPairing), Form.note(tr(.connectPairingHint)), gap: 14)
        view = Form.page(form.grid)
    }

    private var address: String? {
        guard let status = context.httpStatus, status.hasPrefix("Local MCP: ") else { return nil }
        return String(status.dropFirst("Local MCP: ".count))
    }

    func refresh() {
        httpToggle.state = context.httpEnabled ? .on : .off
        httpToggle.isEnabled = context.isRunning
        if let address {
            httpAddress.stringValue = tr(.connectHTTPAddress, address)
            copyAddress.isHidden = false
        } else {
            httpAddress.stringValue = context.httpStatus ?? ""
            copyAddress.isHidden = true
        }
        addressRow?.isHidden = context.httpStatus == nil
    }

    @objc private func toggleHTTP() { context.setHTTPEnabled(httpToggle.state == .on) }
    @objc private func copyConfiguration() { context.copyConfiguration() }

    @objc private func copyHTTPAddress() {
        guard let address else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(address, forType: .string)
    }
}

// MARK: 更新

final class UpdatesPane: PaneController, SettingsPaneView {
    private let versionLabel = Form.value()
    private lazy var automatic = Form.checkbox(tr(.updatesAutomaticToggle), self, #selector(toggleAutomatic))
    private let automaticNote = Form.note()
    private let lastCheck = Form.value()
    private lazy var checkButton = Form.button(tr(.updatesCheckNow), self, #selector(check))
    private let status = Form.value()
    private let progress = NSProgressIndicator()
    private lazy var cancelButton = Form.button(tr(.updatesCancel), self, #selector(cancel))
    private lazy var installButton = Form.button(tr(.updatesInstall), self, #selector(install))
    private lazy var releaseButton = Form.button(tr(.updatesViewRelease), self, #selector(openRelease))
    private lazy var skipButton = Form.button(tr(.updatesSkip), self, #selector(skip))
    private lazy var revealButton = Form.button(tr(.updatesReveal), self, #selector(reveal))
    private lazy var retryButton = Form.button(tr(.updatesRetry), self, #selector(check))
    private let notes = NSTextView.scrollableTextView()
    private var statusRow: NSGridRow?
    private var progressRow: NSGridRow?
    private var actionsRow: NSGridRow?
    private var notesRow: NSGridRow?

    private static func format(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = HostLanguage.current.locale
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    override func loadView() {
        progress.style = .bar
        progress.isIndeterminate = false
        progress.minValue = 0
        progress.maxValue = 1
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.widthAnchor.constraint(equalToConstant: 240).isActive = true
        if let text = notes.documentView as? NSTextView {
            text.isEditable = false
            text.isSelectable = true
            text.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            text.textContainerInset = NSSize(width: 4, height: 6)
            text.setAccessibilityLabel(tr(.updatesNotes))
        }
        notes.borderType = .bezelBorder
        notes.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            notes.widthAnchor.constraint(equalToConstant: Form.textWidth),
            notes.heightAnchor.constraint(equalToConstant: 150),
        ])
        installButton.keyEquivalent = "\r"

        let form = FormBuilder()
        form.add(tr(.updatesVersion), versionLabel)
        form.add(tr(.updatesAutomatic), automatic, gap: 14)
        form.add(nil, automaticNote)
        form.add(tr(.updatesLastCheck), lastCheck, gap: 14)
        form.add(nil, checkButton)
        statusRow = form.add(nil, status)
        progressRow = form.add(nil, Form.row([progress, cancelButton]), center: true)
        actionsRow = form.add(nil, Form.row([installButton, releaseButton, skipButton, revealButton, retryButton]), center: true)
        let notesRow = form.add(tr(.updatesNotes), notes, gap: 6)
        notesRow.rowAlignment = .none
        notesRow.yPlacement = .top
        self.notesRow = notesRow
        view = Form.page(form.grid)
    }

    func refresh() {
        let updates = context.updates
        let version = updates.version ?? "dev", build = updates.build ?? "-"
        versionLabel.stringValue = HostLanguage.current == .chinese ? "\(version)（\(build)）" : "\(version) (\(build))"
        automatic.state = updates.isReleaseBuild && updates.preferences.automaticChecks ? .on : .off
        automatic.isEnabled = updates.isReleaseBuild
        automaticNote.stringValue = updates.isReleaseBuild ? tr(.updatesAutomaticHint) : tr(.updatesDevBuild)
        lastCheck.stringValue = updates.preferences.lastCheck.map(Self.format) ?? tr(.updatesNever)
        checkButton.isEnabled = updates.canCheck

        var message: String?
        var buttons: [NSButton] = []
        var showProgress = false
        installButton.title = tr(.updatesInstall)
        switch updates.phase {
        case .idle:
            break
        case .checking:
            message = tr(.updatesChecking)
        case let .upToDate(check):
            message = tr(.updatesUpToDate, check.current)
        case let .available(check):
            var text = tr(.updatesAvailable, check.latest, check.current)
            if updates.isSkipped { text += "\n" + tr(.updatesSkipped, check.latest) }
            if check.asset == nil { text += "\n" + tr(.updatesNoPackage) }
            message = text
            if updates.isReleaseBuild && check.asset != nil { buttons.append(installButton) }
            buttons.append(releaseButton)
            if !updates.isSkipped { buttons.append(skipButton) }
        case let .downloading(check, downloaded, total):
            let formatter = ByteCountFormatter()
            formatter.countStyle = .file
            message = tr(.updatesDownloading, check.latest, formatter.string(fromByteCount: Int64(downloaded)),
                         formatter.string(fromByteCount: Int64(total)))
            showProgress = true
            progress.isIndeterminate = false
            progress.doubleValue = total > 0 ? Double(downloaded) / Double(total) : 0
            cancelButton.isHidden = false
        case .verifying:
            message = tr(.updatesVerifying)
            showProgress = true
            progress.isIndeterminate = true
            progress.startAnimation(nil)
            cancelButton.isHidden = true
        case let .ready(check, _):
            message = tr(.updatesDownloaded, check.latest)
            installButton.title = tr(.updatesConfirmInstall)
            buttons = [installButton, releaseButton]
        case let .manual(_, _, reason):
            message = tr(.updatesManualInstall, reason)
            buttons = [revealButton, releaseButton]
        case .installing:
            message = tr(.updatesInstalling)
        case let .failed(reason, check):
            message = tr(.updatesFailed, reason)
            buttons = [retryButton] + (check == nil ? [] : [releaseButton])
        }
        if !showProgress { progress.stopAnimation(nil) }
        status.stringValue = message ?? ""
        statusRow?.isHidden = message == nil
        progressRow?.isHidden = !showProgress
        for button in [installButton, releaseButton, skipButton, revealButton, retryButton] {
            button.isHidden = !buttons.contains(button)
        }
        actionsRow?.isHidden = buttons.isEmpty

        let notesText: String? = {
            switch updates.phase {
            case let .available(check), let .ready(check, _), let .manual(check, _, _), let .downloading(check, _, _), let .verifying(check):
                return check.notes.isEmpty ? nil : Self.readable(check.notes)
            default: return nil
            }
        }()
        if let text = notes.documentView as? NSTextView, text.string != (notesText ?? "") { text.string = notesText ?? "" }
        notesRow?.isHidden = notesText == nil
    }

    /// 发布说明是 Markdown；按纯文本显示，只去掉标题前的 # 与粗体标记。
    static func readable(_ notes: String) -> String {
        notes.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            var text = String(line)
            if let range = text.range(of: #"^#{1,6}\s+"#, options: .regularExpression) { text.removeSubrange(range) }
            return text.replacingOccurrences(of: "**", with: "")
        }.joined(separator: "\n")
    }

    @objc private func toggleAutomatic() { context.updates.setAutomaticChecks(automatic.state == .on) }
    @objc private func check() { context.updates.check(manual: true) }
    @objc private func cancel() { context.updates.cancelDownload() }
    @objc private func skip() { context.updates.skip() }
    @objc private func reveal() { context.updates.revealDownloadedApp() }
    @objc private func openRelease() { context.updates.openReleasePage() }

    @objc private func install() {
        if case .ready = context.updates.phase {
            context.updates.confirmInstall()
        } else {
            context.updates.downloadAndInstall()
        }
    }
}

// MARK: 关于

final class AboutPane: PaneController, SettingsPaneView {
    private let version = NSTextField(labelWithString: "")

    override func loadView() {
        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 72), icon.heightAnchor.constraint(equalToConstant: 72)])
        icon.setAccessibilityElement(false)
        let name = NSTextField(labelWithString: "Computer Use")
        name.font = .boldSystemFont(ofSize: 17)
        version.textColor = .secondaryLabelColor
        version.isSelectable = true
        let summary = NSTextField(wrappingLabelWithString: tr(.aboutDescription))
        summary.alignment = .center
        summary.preferredMaxLayoutWidth = Form.textWidth
        let links = Form.row([
            Form.button(tr(.aboutWebsite), self, #selector(openWebsite)),
            Form.button(tr(.aboutReleases), self, #selector(openReleases)),
            Form.button(tr(.aboutLicenses), self, #selector(openLicenses)),
        ])
        let stack = NSStackView(views: [icon, name, version, summary, links])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 8
        stack.setCustomSpacing(14, after: summary)
        view = Form.page(stack)
    }

    func refresh() {
        let updates = context.updates
        version.stringValue = tr(.aboutVersion, updates.version ?? "dev", updates.build ?? "-")
    }

    @objc private func openWebsite() { NSWorkspace.shared.open(UpdateController.projectPage) }
    @objc private func openReleases() { NSWorkspace.shared.open(UpdateController.releasesPage) }
    @objc private func openLicenses() { NSWorkspace.shared.open(context.paths.licenses) }
}
