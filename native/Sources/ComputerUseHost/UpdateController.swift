import AppKit
import HostCore

/// 检查、下载、校验与安装更新的状态机。界面只读取 `phase` 并调用这里的方法。
final class UpdateController {
    enum Phase {
        case idle
        case checking
        case upToDate(UpdateCheck)
        case available(UpdateCheck)
        case downloading(UpdateCheck, downloaded: Int, total: Int)
        case verifying(UpdateCheck)
        /// 已下载并通过校验，等待用户确认安装。
        case ready(UpdateCheck, app: URL)
        /// 无法在原位置替换：已在访达中显示校验通过的新版本，请用户手动替换。
        case manual(UpdateCheck, app: URL, reason: String)
        case installing(UpdateCheck)
        case failed(String, UpdateCheck?)
    }

    static let releasesPage = URL(string: "https://github.com/\(UpdateCommand.repository)/releases")!
    static let projectPage = URL(string: "https://github.com/\(UpdateCommand.repository)")!

    // 只由本类的流程改写；界面测试直接设置它来检查各状态的布局。
    var phase = Phase.idle { didSet { onChange?() } }
    /// 检查发现、且用户没有跳过的新版本；菜单据此显示更新项。
    private(set) var announced: UpdateCheck? { didSet { onChange?() } }
    var onChange: (() -> Void)?
    weak var host: HostContext?

    let preferences: UpdatePreferences
    let version: String?
    let build: String?
    /// 当前 App 的 Developer ID 团队。为 nil 时是开发版本：不自动检查，也不在应用内安装。
    let teamID: String?
    private let command: UpdateCommand
    private let caches: URL
    private var run: UpdateCommand.Run?
    private var timer: Timer?
    private var stage: URL?

    /// 后几项参数只供界面测试替换；App 使用默认值。
    init(paths: HostPaths, info: [String: Any]? = Bundle.main.infoDictionary, teamID: String? = CodeSigning.currentTeamIdentifier(),
         command: UpdateCommand? = nil, caches: URL? = nil, defaults: UserDefaults = .standard) {
        version = info?["CFBundleShortVersionString"] as? String
        build = info?["CFBundleVersion"] as? String
        self.teamID = teamID
        self.command = command ?? UpdateCommand(paths: paths, inheritedEnvironment: ProcessInfo.processInfo.environment)
        self.caches = caches ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        preferences = UpdatePreferences(defaults: defaults)
    }

    var isReleaseBuild: Bool { teamID != nil }

    var isBusy: Bool {
        switch phase {
        case .checking, .downloading, .verifying, .installing: return true
        default: return false
        }
    }

    /// 已有下载好的新版本时不再检查，避免丢掉校验过的安装包。
    var canCheck: Bool {
        switch phase {
        case .checking, .downloading, .verifying, .ready, .manual, .installing: return false
        default: return true
        }
    }

    var currentCheck: UpdateCheck? {
        switch phase {
        case .idle, .checking: return nil
        case let .upToDate(check), let .available(check), let .downloading(check, _, _), let .verifying(check),
             let .ready(check, _), let .manual(check, _, _), let .installing(check): return check
        case let .failed(_, check): return check
        }
    }

    func start() {
        // 上次安装留下的下载包、解压结果和被替换的旧 App 在这里清理。
        UpdateInstaller.removeStages(caches: caches)
        guard isReleaseBuild else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 60 * 60, repeats: true) { [weak self] _ in self?.checkIfDue() }
        // 启动一分钟后再检查，不和服务启动争抢资源。
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in self?.checkIfDue() }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        run?.cancel()
    }

    func setAutomaticChecks(_ enabled: Bool) {
        preferences.automaticChecks = enabled
        onChange?()
        if enabled { checkIfDue() }
    }

    private func checkIfDue() {
        guard isReleaseBuild, preferences.automaticChecks, canCheck,
              UpdateSchedule.isDue(lastCheck: preferences.lastCheck, now: Date()) else { return }
        check(manual: false)
    }

    func check(manual: Bool) {
        guard canCheck else { return }
        let previous = phase
        phase = .checking
        run = command.check { [weak self] result in
            guard let self else { return }
            self.run = nil
            switch result {
            case let .success(check):
                self.preferences.lastCheck = Date()
                self.phase = check.available ? .available(check) : .upToDate(check)
                self.announced = UpdateSchedule.shouldAnnounce(check, skipped: self.preferences.skippedVersion, manual: manual) ? check : nil
            case let .failure(error):
                // 自动检查失败不打扰用户，一小时后再试；手动检查显示原因。
                self.phase = manual ? .failed(error.localizedDescription, nil) : previous
            }
        }
    }

    var isSkipped: Bool {
        guard case let .available(check) = phase else { return false }
        return preferences.skippedVersion == check.latest
    }

    func skip() {
        guard case let .available(check) = phase else { return }
        preferences.skippedVersion = check.latest
        announced = nil
        onChange?()
    }

    func downloadAndInstall() {
        guard isReleaseBuild, case let .available(check) = phase else { return }
        guard check.asset != nil else {
            phase = .failed(tr(.updatesNoPackage), check)
            return
        }
        let stage: URL
        do { stage = try UpdateInstaller.makeStage(caches: caches, version: check.latest) } catch {
            phase = .failed(error.localizedDescription, check)
            return
        }
        self.stage = stage
        phase = .downloading(check, downloaded: 0, total: check.asset?.size ?? 0)
        run = command.download(version: check.latest, into: stage.appendingPathComponent("download", isDirectory: true), progress: { [weak self] downloaded, total in
            guard let self, case .downloading = self.phase else { return }
            self.phase = .downloading(check, downloaded: downloaded, total: total)
        }, completion: { [weak self] result in
            guard let self else { return }
            self.run = nil
            switch result {
            case let .success(download):
                self.verify(download, check: check, stage: stage)
            case .failure(.cancelled):
                self.discardStage()
                self.phase = .available(check)
            case let .failure(error):
                self.discardStage()
                self.phase = .failed(error.localizedDescription, check)
            }
        })
    }

    func cancelDownload() { run?.cancel() }

    private func verify(_ download: UpdateDownload, check: UpdateCheck, stage: URL) {
        guard let teamID else { return }
        phase = .verifying(check)
        let current = version
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = UpdateInstaller.prepare(download, stage: stage, currentVersion: current, teamID: teamID)
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case let .success(app):
                    if let blocker = UpdateInstaller.blocker(for: Bundle.main.bundleURL) {
                        self.phase = .manual(check, app: app, reason: Self.describe(blocker))
                        NSWorkspace.shared.activateFileViewerSelecting([app])
                    } else {
                        self.phase = .ready(check, app: app)
                        // 这里是 GCD 回调；确认框改在 run loop 里弹出，不挡住运行时事件。
                        Alerts.later { [weak self] in self?.confirmInstall() }
                    }
                case let .failure(error):
                    self.discardStage()
                    self.phase = .failed(error.localizedDescription, check)
                }
            }
        }
    }

    /// 请用户确认后安装；取消时保留已校验的安装包，稍后可以在“更新”分区继续。
    func confirmInstall() {
        guard case let .ready(check, app) = phase else { return }
        var message = tr(.updatesConfirmBody)
        if (host?.controlledAppCount ?? 0) > 0 { message += "\n\n" + tr(.updatesConfirmActive) }
        guard Alerts.confirm(tr(.updatesConfirmTitle, check.latest), message, confirm: tr(.updatesConfirmInstall)) else { return }
        install(check, app: app)
    }

    private func install(_ check: UpdateCheck, app: URL) {
        guard let stage else { return }
        let current = Bundle.main.bundleURL
        if let blocker = UpdateInstaller.blocker(for: current) {
            phase = .manual(check, app: app, reason: Self.describe(blocker))
            NSWorkspace.shared.activateFileViewerSelecting([app])
            return
        }
        // 替换脚本等本进程退出后才移动文件；本进程退出前按正常流程停止服务。
        let swap = UpdateInstaller.swapCommand(pid: ProcessInfo.processInfo.processIdentifier, current: current, next: app,
                                               backup: stage.appendingPathComponent("Previous.app", isDirectory: true))
        let process = Process()
        process.executableURL = swap.executable
        process.arguments = swap.arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch {
            phase = .failed(tr(.updateErrorLaunch), check)
            return
        }
        phase = .installing(check)
        host?.quitForUpdate()
    }

    func revealDownloadedApp() {
        if case let .manual(_, app, _) = phase { NSWorkspace.shared.activateFileViewerSelecting([app]) }
    }

    func openReleasePage() {
        NSWorkspace.shared.open(currentCheck?.releasePage ?? Self.releasesPage)
    }

    private func discardStage() {
        if let stage { try? FileManager.default.removeItem(at: stage) }
        stage = nil
    }

    private static func describe(_ blocker: UpdateInstaller.Blocker) -> String {
        switch blocker {
        case .translocated: return tr(.updatesTranslocated)
        case .notWritable, .notBundle: return tr(.updatesNotWritable)
        }
    }
}
