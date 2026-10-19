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
        pauseButton.isEnabled = context.isRunning || context.serviceState == .paused
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

// MARK: 接入

final class ConnectPane: PaneController, SettingsPaneView, NSComboBoxDelegate {
    private let access: ConnectAccess
    private let profile = NSComboBox()
    private let profileStatus = Form.note()
    private let feedback = Form.note()
    private let pairPreview = NSTextView.scrollableTextView()
    private var profileIsValid = true
    private var shownProfiles: [String] = []
    private lazy var refreshProfiles = Form.button(tr(.connectRefresh), self, #selector(reloadProfiles))
    private lazy var copyPair = Form.button(tr(.connectCopyPair), self, #selector(copyPairCommand))
    private lazy var copyMCP = Form.button(tr(.connectCopy), self, #selector(copyConfiguration))
    private lazy var copyPrompt = Form.button(tr(.connectCopyPrompt), self, #selector(copyInstallationPrompt))
    private lazy var advancedToggle = Form.button(tr(.connectAdvanced), self, #selector(toggleAdvanced))
    private var advancedForm: NSGridView?
    private var advancedExpanded = false
    private lazy var httpToggle = Form.checkbox(tr(.connectHTTPToggle), self, #selector(toggleHTTP))
    private let httpAddress = Form.value()
    private lazy var copyAddress = Form.button(tr(.connectCopyAddress), self, #selector(copyHTTPAddress))
    private var addressRow: NSGridRow?

    init(context: HostContext, access: ConnectAccess? = nil) {
        self.access = access ?? ConnectAccess(paths: context.paths)
        super.init(context: context)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        profile.delegate = self
        profile.isEditable = true
        profile.completes = false
        profile.stringValue = access.selectedProfile
        profile.setAccessibilityLabel(tr(.connectProfile))
        profile.identifier = NSUserInterfaceItemIdentifier("connect-profile")
        profile.translatesAutoresizingMaskIntoConstraints = false
        profile.widthAnchor.constraint(equalToConstant: 230).isActive = true
        if let text = pairPreview.documentView as? NSTextView {
            text.isEditable = false
            text.isSelectable = true
            text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            text.textContainerInset = NSSize(width: 4, height: 4)
            text.setAccessibilityLabel(tr(.connectPairing))
        }
        pairPreview.borderType = .bezelBorder
        pairPreview.hasVerticalScroller = true
        pairPreview.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            pairPreview.widthAnchor.constraint(equalToConstant: Form.textWidth),
            pairPreview.heightAnchor.constraint(equalToConstant: 66),
        ])
        let main = FormBuilder()
        main.add(nil, copyPrompt)
        main.add(nil, Form.note(tr(.connectInstallHint)))
        main.add(nil, feedback)
        advancedToggle.setButtonType(.onOff)
        advancedToggle.isBordered = false
        advancedToggle.imagePosition = .imageLeft
        advancedToggle.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)
        advancedToggle.identifier = NSUserInterfaceItemIdentifier("connect-advanced-toggle")
        let form = FormBuilder()
        form.add(tr(.connectProfile), Form.row([profile, refreshProfiles]), center: true)
        form.add(nil, Form.note(tr(.connectProfileHint)))
        form.add(nil, profileStatus)
        form.add(tr(.connectPairing), copyPair, gap: 8)
        form.add(nil, pairPreview)
        form.add(nil, Form.note(tr(.connectPairingSteps)))
        form.add(tr(.connectStdio), copyMCP, gap: 8)
        form.add(tr(.connectHTTP), httpToggle, gap: 8)
        form.add(nil, Form.note(tr(.connectHTTPHint)))
        addressRow = form.add(nil, Form.row([httpAddress, copyAddress]), center: true)
        advancedForm = form.grid
        form.grid.identifier = NSUserInterfaceItemIdentifier("connect-advanced")
        form.grid.isHidden = true
        let content = Form.column([main.grid, advancedToggle, form.grid], spacing: 16)
        content.detachesHiddenViews = true
        view = Form.page(content)
        access.onChange = { [weak self] in self?.renderAccess() }
        renderAccess()
    }

    private var address: String? {
        guard let status = context.httpStatus, status.hasPrefix("Local MCP: ") else { return nil }
        return String(status.dropFirst("Local MCP: ".count))
    }

    func refresh() {
        // Basic setup only generates a prompt. Profile metadata is needed when Advanced is expanded.
        if advancedExpanded { access.loadIfNeeded() }
        renderAccess()
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

    private func renderAccess() {
        guard isViewLoaded else { return }
        if shownProfiles != access.profiles {
            let entry = profile.stringValue
            profile.removeAllItems()
            profile.addItems(withObjectValues: access.profiles)
            profile.stringValue = entry
            shownProfiles = access.profiles
        }
        profile.isEnabled = !access.isBusy
        refreshProfiles.isEnabled = !access.isBusy && profileIsValid
        for button in [copyPair, copyMCP, copyPrompt] {
            button.isEnabled = profileIsValid && !access.isBusy
        }
        (pairPreview.documentView as? NSTextView)?.string = profileIsValid
            ? ConnectAccess.pairCommand(paths: context.paths, profile: access.selectedProfile) : ""
        if !profileIsValid { profileStatus.stringValue = tr(.connectProfileInvalidName) }
        else if access.isBusy { profileStatus.stringValue = tr(.connectWorking) }
        else if let failure = access.failure { profileStatus.stringValue = Self.message(failure) }
        else {
            let key: L10nKey
            switch access.profileState {
            case .missing: key = .connectProfileMissing
            case .invalid: key = .connectProfileInvalid
            case .unverified: key = .connectProfileUnverified
            case .valid: key = .connectProfileValid
            case .unauthorized: key = .connectProfileUnauthorized
            case nil: key = .connectProfileUnchecked
            }
            profileStatus.stringValue = tr(key)
        }
    }

    func controlTextDidChange(_ notification: Notification) {
        updateSelection()
    }

    func controlTextDidEndEditing(_ notification: Notification) {
        updateSelection()
        if profileIsValid { access.reload() }
    }

    func comboBoxSelectionDidChange(_ notification: Notification) {
        if profile.indexOfSelectedItem >= 0, let name = profile.itemObjectValue(at: profile.indexOfSelectedItem) as? String {
            profile.stringValue = name
        }
        updateSelection()
        if profileIsValid { access.reload() }
    }

    private func updateSelection() {
        profileIsValid = ConnectAccess.validProfile(profile.stringValue)
        if profileIsValid { _ = access.selectProfile(profile.stringValue) }
        feedback.stringValue = ""
        renderAccess()
    }

    @objc private func reloadProfiles() {
        updateSelection()
        if profileIsValid { access.reload() }
    }

    @objc private func toggleHTTP() { context.setHTTPEnabled(httpToggle.state == .on) }

    @objc private func toggleAdvanced() {
        advancedExpanded = advancedToggle.state == .on
        advancedForm?.isHidden = !advancedExpanded
        advancedToggle.image = NSImage(systemSymbolName: advancedExpanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
        if !profileIsValid { feedback.stringValue = tr(.connectProfileInvalidName) }
        refresh()
        (parent as? SettingsTabViewController)?.fitWindow(animated: true)
    }

    @objc private func copyPairCommand() {
        guard profileIsValid else { return }
        copy(ConnectAccess.pairCommand(paths: context.paths, profile: access.selectedProfile))
    }

    @objc private func copyConfiguration() {
        guard profileIsValid, let configuration = ConnectAccess.configuration(paths: context.paths, profile: access.selectedProfile) else { return }
        copy(configuration)
    }

    @objc private func copyInstallationPrompt() {
        guard profileIsValid else { return }
        feedback.stringValue = tr(.connectWorking)
        access.installationPrompt { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let prompt): self.copy(prompt)
            case .failure(let failure): self.feedback.stringValue = Self.message(failure)
            }
        }
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        feedback.stringValue = NSPasteboard.general.setString(text, forType: .string)
            ? tr(.connectContentCopied) : tr(.connectClipboardFailed)
    }

    private static func message(_ failure: ConnectFailure) -> String {
        switch failure {
        case .unavailable: return tr(.connectCLIUnavailable)
        case .timeout: return tr(.connectCLITimeout)
        case .output: return tr(.connectCLIOutput)
        case .command: return tr(.connectCLIFailed)
        }
    }

    @objc private func copyHTTPAddress() {
        guard let address else { return }
        copy(address)
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
