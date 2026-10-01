import Foundation

/// 界面语言跟随系统首选语言：列表里先出现的中文（任何 zh 变体）或英文生效，其他语言回退到英文。
public enum HostLanguage: String, CaseIterable {
    case chinese = "zh-Hans"
    case english = "en"

    public static func preferred(from languages: [String]) -> HostLanguage {
        for language in languages {
            let code = language.lowercased().replacingOccurrences(of: "_", with: "-")
            if code == "zh" || code.hasPrefix("zh-") { return .chinese }
            if code == "en" || code.hasPrefix("en-") { return .english }
        }
        return .english
    }

    /// 启动时按系统语言确定；只有界面测试会改写它来检查两种语言的布局。
    public static var current = preferred(from: Locale.preferredLanguages)
    public var locale: Locale { Locale(identifier: rawValue) }
}

/// 界面文案。两种语言的表必须包含同样的键和同样的格式占位符（测试检查）。
public enum L10nKey: String, CaseIterable {
    // 菜单
    case menuSettings, menuPause, menuResume, menuEmergencyStop, menuRestart, menuCheckUpdates, menuUpdateAvailable, menuQuit
    case statusItemAccessibility
    // 服务状态
    case statusNotStarted, statusPermissionsNeeded, statusStartingDriver, statusStartingRuntime, statusReady, statusPaused
    case statusControlling, statusEmergencyStopped, statusRestarting, statusQuitting, statusInstallingUpdate
    case statusRequestExpired, statusReopenAfterGrant
    // 服务失败
    case failureLaunchTitle, failureDriverTimeout, failureRuntimeTimeout, failureChildExited, childDriver, childRuntime
    case failureReadEvents, failureRuntime, failureSendControl
    case errorUnsafeDirectory, errorAlreadyRunning, errorResourcesUnavailable, errorLineTooLong, errorInvalidEvent
    case errorSocketPathTooLong, errorSocketOccupied
    // 审批
    case approvalPairTitle, approvalPairBody, approvalForegroundAllowed, approvalNone, approvalAllowed, approvalNotAllowed
    case approvalForegroundTitle, approvalForegroundBody, approvalDeny, approvalAllow
    case commonOK, commonCancel
    // 设置窗口
    case settingsTitle, paneGeneral, paneStatus, paneClients, paneConnect, paneUpdates, paneAbout
    // 通用
    case generalStartup, generalLaunchAtLogin, generalLoginNeedsApproval, generalOpenLoginItems, generalLoginFailed
    case generalCLI, generalInstallCLI, generalCLIInstalled, generalCLINotInstalled, generalCLIOther
    case generalLanguage, generalLanguageValue
    case cliTitle, cliBody, cliInstall, cliDone, cliDoneBody, cliFailed
    // 权限与状态
    case statusService, statusAccessibility, statusScreenRecording, statusGranted, statusDenied, statusOpenSystemSettings
    case statusRequestPermissions, statusPermissionsHint, statusControl, permissionsTitle, permissionsBody
    // 客户端
    case clientsName, clientsApps, clientsBrowser, clientsForeground, clientsYes, clientsNo, clientsRevoke
    case clientsEmpty, clientsNotRunning, clientsHint, clientsRevokeTitle, clientsRevokeBody
    // 接入
    case connectHTTP, connectHTTPToggle, connectHTTPHint, connectHTTPAddress, connectCopyAddress
    case connectStdio, connectCopy, connectCopied, connectCopiedBody, connectCopyFailed, connectPairing, connectPairingHint
    // 更新
    case updatesVersion, updatesAutomatic, updatesAutomaticToggle, updatesAutomaticHint, updatesLastCheck, updatesNever
    case updatesCheckNow, updatesChecking, updatesUpToDate, updatesAvailable, updatesInstall, updatesDownload
    case updatesViewRelease, updatesSkip, updatesSkipped, updatesDownloading, updatesVerifying, updatesInstalling
    case updatesDownloaded, updatesReveal, updatesFailed, updatesRetry, updatesDevBuild, updatesNoPackage, updatesManualInstall
    case updatesTranslocated, updatesNotWritable, updatesConfirmTitle, updatesConfirmBody, updatesConfirmActive
    case updatesConfirmInstall, updatesNotes, updatesCancel
    case updateErrorNetwork, updateErrorTimeout, updateErrorRateLimit, updateErrorChanged, updateErrorNoPackage
    case updateErrorUpToDate, updateErrorGeneric, updateErrorLaunch, updateErrorOutput
    case verifyFailed, verifyExtract, verifyBundle, verifySignature, verifyGatekeeper
    // 关于
    case aboutDescription, aboutVersion, aboutWebsite, aboutReleases, aboutLicenses
}

public enum L10n {
    public static func text(_ key: L10nKey, language: HostLanguage = .current) -> String {
        table(language)[key] ?? english[key] ?? key.rawValue
    }

    public static func format(_ key: L10nKey, _ arguments: [CVarArg], language: HostLanguage = .current) -> String {
        String(format: text(key, language: language), locale: language.locale, arguments: arguments)
    }

    static func table(_ language: HostLanguage) -> [L10nKey: String] {
        language == .chinese ? chinese : english
    }

    static let chinese: [L10nKey: String] = [
        .menuSettings: "设置…",
        .menuPause: "暂停新动作",
        .menuResume: "恢复接收动作",
        .menuEmergencyStop: "紧急停止",
        .menuRestart: "重新启动服务",
        .menuCheckUpdates: "检查更新…",
        .menuUpdateAvailable: "新版本 %@ 可用…",
        .menuQuit: "退出 Computer Use",
        .statusItemAccessibility: "Computer Use：%@",

        .statusNotStarted: "尚未启动",
        .statusPermissionsNeeded: "需要辅助功能及屏幕录制权限",
        .statusStartingDriver: "正在启动桌面驱动…",
        .statusStartingRuntime: "正在启动统一运行时…",
        .statusReady: "就绪 · 后台模式",
        .statusPaused: "已暂停新动作",
        .statusControlling: "正在操作 %ld 个应用",
        .statusEmergencyStopped: "紧急停止；请手动重启服务",
        .statusRestarting: "正在重新启动…",
        .statusQuitting: "正在退出…",
        .statusInstallingUpdate: "正在安装更新…",
        .statusRequestExpired: "审批请求已过期或失效；未授权",
        .statusReopenAfterGrant: "授权后请完全退出并重新打开 App",

        .failureLaunchTitle: "Computer Use 无法启动",
        .failureDriverTimeout: "桌面驱动启动超时。",
        .failureRuntimeTimeout: "统一运行时启动超时。",
        .failureChildExited: "%@已退出；服务停止，动作不会重放。",
        .childDriver: "桌面驱动",
        .childRuntime: "统一运行时",
        .failureReadEvents: "无法读取运行时事件：%@",
        .failureRuntime: "运行时发生错误。",
        .failureSendControl: "无法向运行时发送控制指令。",
        .errorUnsafeDirectory: "服务数据目录必须属于当前用户且不能是符号链接。",
        .errorAlreadyRunning: "Computer Use 已在运行。",
        .errorResourcesUnavailable: "缺少内置运行组件，请使用完整 App 安装包。",
        .errorLineTooLong: "运行时事件超出长度限制。",
        .errorInvalidEvent: "运行时返回了无效事件。",
        .errorSocketPathTooLong: "本地服务 socket 路径过长。",
        .errorSocketOccupied: "本地服务 socket 路径已被其他文件占用，已保留原文件。",

        .approvalPairTitle: "允许客户端操作这些应用？",
        .approvalPairBody: "客户端：%@\n标识：%@\n应用标识：\n%@\n独立受控浏览器：%@\n前台操作：%@\n\n批准后长期有效，重启 App 也不再询问；在设置的“客户端”中撤销该客户端即可收回全部权限。",
        .approvalForegroundAllowed: "允许（可能切换焦点、移动鼠标并模拟键盘）",
        .approvalNone: "无",
        .approvalAllowed: "允许",
        .approvalNotAllowed: "不允许",
        .approvalForegroundTitle: "允许当前会话使用前台操作？",
        .approvalForegroundBody: "客户端：%@\n目标：%@\n会话：%@\n\n此操作可能切换焦点并移动鼠标。授权仅适用于此会话及目标应用。",
        .approvalDeny: "拒绝",
        .approvalAllow: "允许",
        .commonOK: "好",
        .commonCancel: "取消",

        .settingsTitle: "设置",
        .paneGeneral: "通用",
        .paneStatus: "权限与状态",
        .paneClients: "客户端",
        .paneConnect: "接入",
        .paneUpdates: "更新",
        .paneAbout: "关于",

        .generalStartup: "启动：",
        .generalLaunchAtLogin: "登录时打开 Computer Use",
        .generalLoginNeedsApproval: "需要在“系统设置 > 通用 > 登录项”中允许。",
        .generalOpenLoginItems: "打开登录项设置…",
        .generalLoginFailed: "无法更改登录项",
        .generalCLI: "命令行：",
        .generalInstallCLI: "安装到 ~/.local/bin…",
        .generalCLIInstalled: "已安装：%@",
        .generalCLINotInstalled: "未安装。安装后可在终端运行 computer-use。",
        .generalCLIOther: "%@ 已被其他文件占用，不会覆盖。",
        .generalLanguage: "语言：",
        .generalLanguageValue: "简体中文（跟随系统）",
        .cliTitle: "安装命令行入口",
        .cliBody: "将在 %@ 创建指向当前 App 的符号链接。请将 ~/.local/bin 加入 PATH。",
        .cliInstall: "安装",
        .cliDone: "CLI 已安装",
        .cliDoneBody: "%@\n运行 computer-use doctor 检查服务。",
        .cliFailed: "CLI 安装失败",

        .statusService: "服务：",
        .statusAccessibility: "辅助功能：",
        .statusScreenRecording: "屏幕录制：",
        .statusGranted: "已授权",
        .statusDenied: "未授权",
        .statusOpenSystemSettings: "打开系统设置…",
        .statusRequestPermissions: "请求系统权限…",
        .statusPermissionsHint: "授权变化后请完全退出并重新打开 App，以刷新系统缓存。截图是否可用，需在客户端连接后通过 observe 确认。",
        .statusControl: "控制：",
        .permissionsTitle: "系统权限",
        .permissionsBody: "请在系统设置中允许 Computer Use 使用辅助功能和屏幕录制。授权发生变化后，请完全退出并重新打开本 App，以刷新系统缓存。CLI doctor 检查权限归属；截图是否可用还需通过 observe 验证。",

        .clientsName: "名称",
        .clientsApps: "应用",
        .clientsBrowser: "受控浏览器",
        .clientsForeground: "前台操作",
        .clientsYes: "允许",
        .clientsNo: "—",
        .clientsRevoke: "撤销…",
        .clientsEmpty: "还没有已配对的客户端。在终端运行 computer-use pair 发起配对。",
        .clientsNotRunning: "服务未运行，暂时无法读取客户端列表。",
        .clientsHint: "授权范围在配对时确定；需要改变范围时，撤销后重新配对。",
        .clientsRevokeTitle: "撤销“%@”？",
        .clientsRevokeBody: "该客户端的凭据会立即失效，需要重新配对才能再次使用。",

        .connectHTTP: "本机 HTTP：",
        .connectHTTPToggle: "启用本机 HTTP MCP",
        .connectHTTPHint: "只监听 127.0.0.1，并要求客户端凭据；仅本次运行有效，重启服务或 App 后关闭。",
        .connectHTTPAddress: "地址：%@",
        .connectCopyAddress: "复制地址",
        .connectStdio: "MCP 配置：",
        .connectCopy: "复制 stdio 配置",
        .connectCopied: "已复制 MCP 配置",
        .connectCopiedBody: "先使用 computer-use pair 完成客户端授权，再将配置添加到 Agent。",
        .connectCopyFailed: "无法复制配置",
        .connectPairing: "配对：",
        .connectPairingHint: "在终端运行 computer-use pair --name \"My Agent\" --app <Bundle ID>，然后在弹出的确认框中批准。Codex 可用 computer-use config codex 生成配置片段。",

        .updatesVersion: "当前版本：",
        .updatesAutomatic: "自动检查：",
        .updatesAutomaticToggle: "每天检查一次更新",
        .updatesAutomaticHint: "只读取 GitHub 上公开的发布信息，不上传任何使用数据。",
        .updatesLastCheck: "上次检查：",
        .updatesNever: "从未",
        .updatesCheckNow: "立即检查",
        .updatesChecking: "正在检查更新…",
        .updatesUpToDate: "已是最新版本（%@）。",
        .updatesAvailable: "新版本 %@ 可用（当前 %@）。",
        .updatesInstall: "下载并安装…",
        .updatesDownload: "下载",
        .updatesViewRelease: "查看发布页",
        .updatesSkip: "跳过此版本",
        .updatesSkipped: "已跳过 %@；自动检查不再提示这个版本。",
        .updatesDownloading: "正在下载 %@（%@ / %@）…",
        .updatesVerifying: "正在校验安装包…",
        .updatesInstalling: "正在安装并重新打开…",
        .updatesDownloaded: "%@ 已下载并通过校验。",
        .updatesReveal: "显示安装包",
        .updatesFailed: "更新失败：%@",
        .updatesRetry: "重试",
        .updatesDevBuild: "开发版本不自动检查更新，也不能在应用内安装。",
        .updatesNoPackage: "这个版本没有适用于本机的安装包。",
        .updatesManualInstall: "%@ 已在访达中显示校验通过的新版本，请手动替换。",
        .updatesTranslocated: "App 正在从系统隔离的临时位置运行，请先把它移到“应用程序”文件夹。",
        .updatesNotWritable: "没有权限替换当前位置的 App。",
        .updatesConfirmTitle: "安装 Computer Use %@？",
        .updatesConfirmBody: "将停止服务、在原位置替换 App 并重新打开。已配对的客户端和系统权限保持不变。",
        .updatesConfirmActive: "有 Agent 正在操作应用，安装会立即中断当前动作。",
        .updatesConfirmInstall: "安装并重新打开",
        .updatesNotes: "更新内容：",
        .updatesCancel: "取消下载",
        .updateErrorNetwork: "无法连接更新服务器，请检查网络连接。",
        .updateErrorTimeout: "更新服务器响应超时，请稍后再试。",
        .updateErrorRateLimit: "GitHub 访问次数暂时达到上限，请稍后再试。",
        .updateErrorChanged: "最新版本已经变化，请重新检查更新。",
        .updateErrorNoPackage: "最新版本没有适用于本机的安装包。",
        .updateErrorUpToDate: "已是最新版本。",
        .updateErrorGeneric: "更新服务返回错误：%@",
        .updateErrorLaunch: "无法运行内置的更新组件。",
        .updateErrorOutput: "内置的更新组件返回了无法识别的结果。",
        .verifyFailed: "安装包未通过校验：%@",
        .verifyExtract: "无法解压安装包。",
        .verifyBundle: "安装包里的 App 标识或版本不符。",
        .verifySignature: "签名与当前 App 的开发者不一致。",
        .verifyGatekeeper: "未通过 Gatekeeper 公证检查。",

        .aboutDescription: "在你授权的范围内，让 AI Agent 查看并操作本机应用的本地 MCP 与命令行服务。",
        .aboutVersion: "版本 %@（%@）",
        .aboutWebsite: "项目主页",
        .aboutReleases: "发布记录",
        .aboutLicenses: "许可与声明",
    ]

    static let english: [L10nKey: String] = [
        .menuSettings: "Settings…",
        .menuPause: "Pause New Actions",
        .menuResume: "Resume Actions",
        .menuEmergencyStop: "Emergency Stop",
        .menuRestart: "Restart Service",
        .menuCheckUpdates: "Check for Updates…",
        .menuUpdateAvailable: "Version %@ Available…",
        .menuQuit: "Quit Computer Use",
        .statusItemAccessibility: "Computer Use: %@",

        .statusNotStarted: "Not started",
        .statusPermissionsNeeded: "Accessibility and Screen Recording permissions required",
        .statusStartingDriver: "Starting the desktop driver…",
        .statusStartingRuntime: "Starting the runtime…",
        .statusReady: "Ready · Background mode",
        .statusPaused: "New actions paused",
        .statusControlling: "Controlling apps (%ld)",
        .statusEmergencyStopped: "Emergency stop; restart the service manually",
        .statusRestarting: "Restarting…",
        .statusQuitting: "Quitting…",
        .statusInstallingUpdate: "Installing the update…",
        .statusRequestExpired: "The approval request expired or was withdrawn; nothing was granted",
        .statusReopenAfterGrant: "After granting, quit and reopen the app",

        .failureLaunchTitle: "Computer Use Cannot Start",
        .failureDriverTimeout: "The desktop driver did not start in time.",
        .failureRuntimeTimeout: "The runtime did not start in time.",
        .failureChildExited: "The %@ exited; the service stopped and no action will be replayed.",
        .childDriver: "desktop driver",
        .childRuntime: "runtime",
        .failureReadEvents: "Cannot read runtime events: %@",
        .failureRuntime: "The runtime reported an error.",
        .failureSendControl: "Cannot send a control command to the runtime.",
        .errorUnsafeDirectory: "The service data folder must belong to the current user and must not be a symbolic link.",
        .errorAlreadyRunning: "Computer Use is already running.",
        .errorResourcesUnavailable: "Bundled components are missing; reinstall the complete app package.",
        .errorLineTooLong: "A runtime event exceeded the size limit.",
        .errorInvalidEvent: "The runtime sent an invalid event.",
        .errorSocketPathTooLong: "The local service socket path is too long.",
        .errorSocketOccupied: "Another file occupies the local service socket path; it was left untouched.",

        .approvalPairTitle: "Allow this client to control these apps?",
        .approvalPairBody: "Client: %@\nID: %@\nApp IDs:\n%@\nIsolated controlled browser: %@\nForeground actions: %@\n\nApproval stays in effect, including after the app restarts. Revoke the client under Settings > Clients to withdraw every permission.",
        .approvalForegroundAllowed: "Allowed (may switch focus, move the pointer and simulate the keyboard)",
        .approvalNone: "None",
        .approvalAllowed: "Allowed",
        .approvalNotAllowed: "Not allowed",
        .approvalForegroundTitle: "Allow this session to use foreground actions?",
        .approvalForegroundBody: "Client: %@\nTarget: %@\nSession: %@\n\nThis may switch focus and move the pointer. The permission applies only to this session and target app.",
        .approvalDeny: "Deny",
        .approvalAllow: "Allow",
        .commonOK: "OK",
        .commonCancel: "Cancel",

        .settingsTitle: "Settings",
        .paneGeneral: "General",
        .paneStatus: "Status",
        .paneClients: "Clients",
        .paneConnect: "Connect",
        .paneUpdates: "Updates",
        .paneAbout: "About",

        .generalStartup: "Startup:",
        .generalLaunchAtLogin: "Open Computer Use at login",
        .generalLoginNeedsApproval: "Allow it in System Settings > General > Login Items.",
        .generalOpenLoginItems: "Open Login Items…",
        .generalLoginFailed: "Cannot Change the Login Item",
        .generalCLI: "Command line:",
        .generalInstallCLI: "Install in ~/.local/bin…",
        .generalCLIInstalled: "Installed at %@",
        .generalCLINotInstalled: "Not installed. Install it to run computer-use in Terminal.",
        .generalCLIOther: "%@ is used by another file and will not be replaced.",
        .generalLanguage: "Language:",
        .generalLanguageValue: "English (follows the system)",
        .cliTitle: "Install the Command-Line Tool",
        .cliBody: "This creates a symbolic link at %@ that points into this app. Add ~/.local/bin to your PATH.",
        .cliInstall: "Install",
        .cliDone: "CLI Installed",
        .cliDoneBody: "%@\nRun computer-use doctor to check the service.",
        .cliFailed: "CLI Installation Failed",

        .statusService: "Service:",
        .statusAccessibility: "Accessibility:",
        .statusScreenRecording: "Screen Recording:",
        .statusGranted: "Allowed",
        .statusDenied: "Not allowed",
        .statusOpenSystemSettings: "Open System Settings…",
        .statusRequestPermissions: "Request Permissions…",
        .statusPermissionsHint: "After changing permissions, quit and reopen the app to refresh the system cache. Whether screenshots work is confirmed by observe once a client connects.",
        .statusControl: "Control:",
        .permissionsTitle: "System Permissions",
        .permissionsBody: "Allow Computer Use under Accessibility and Screen Recording in System Settings. After a change, quit and reopen this app to refresh the system cache. computer-use doctor checks which app holds the permissions; observe confirms that screenshots work.",

        .clientsName: "Name",
        .clientsApps: "Apps",
        .clientsBrowser: "Browser",
        .clientsForeground: "Foreground",
        .clientsYes: "Allowed",
        .clientsNo: "—",
        .clientsRevoke: "Revoke…",
        .clientsEmpty: "No clients are paired yet. Run computer-use pair in Terminal to pair one.",
        .clientsNotRunning: "The service is not running, so the client list is unavailable.",
        .clientsHint: "Scopes are fixed at pairing. To change them, revoke the client and pair again.",
        .clientsRevokeTitle: "Revoke “%@”?",
        .clientsRevokeBody: "Its credentials stop working immediately. It must pair again to reconnect.",

        .connectHTTP: "Local HTTP:",
        .connectHTTPToggle: "Enable local HTTP MCP",
        .connectHTTPHint: "Listens on 127.0.0.1 only and requires client credentials. It lasts for this run only and turns off when the service or app restarts.",
        .connectHTTPAddress: "Address: %@",
        .connectCopyAddress: "Copy Address",
        .connectStdio: "MCP config:",
        .connectCopy: "Copy stdio Configuration",
        .connectCopied: "MCP Configuration Copied",
        .connectCopiedBody: "Pair the client with computer-use pair first, then add the configuration to the agent.",
        .connectCopyFailed: "Cannot Copy the Configuration",
        .connectPairing: "Pairing:",
        .connectPairingHint: "Run computer-use pair --name \"My Agent\" --app <bundle ID> in Terminal, then approve the confirmation that appears. For Codex, computer-use config codex prints a configuration snippet.",

        .updatesVersion: "Current version:",
        .updatesAutomatic: "Automatic checks:",
        .updatesAutomaticToggle: "Check for updates daily",
        .updatesAutomaticHint: "Reads public release information from GitHub only; no usage data is sent.",
        .updatesLastCheck: "Last checked:",
        .updatesNever: "Never",
        .updatesCheckNow: "Check Now",
        .updatesChecking: "Checking for updates…",
        .updatesUpToDate: "Computer Use is up to date (%@).",
        .updatesAvailable: "Version %@ is available (you have %@).",
        .updatesInstall: "Download and Install…",
        .updatesDownload: "Download",
        .updatesViewRelease: "View Release",
        .updatesSkip: "Skip Version",
        .updatesSkipped: "Skipped %@; automatic checks will not mention it again.",
        .updatesDownloading: "Downloading %@ (%@ of %@)…",
        .updatesVerifying: "Verifying the package…",
        .updatesInstalling: "Installing and relaunching…",
        .updatesDownloaded: "%@ was downloaded and verified.",
        .updatesReveal: "Show Package",
        .updatesFailed: "Update failed: %@",
        .updatesRetry: "Try Again",
        .updatesDevBuild: "Development builds do not check automatically or install updates in the app.",
        .updatesNoPackage: "This release has no package for this computer.",
        .updatesManualInstall: "%@ The verified new version is shown in Finder; replace the app manually.",
        .updatesTranslocated: "The app is running from a temporary location the system isolated; move it to the Applications folder first.",
        .updatesNotWritable: "You do not have permission to replace the app in its current location.",
        .updatesConfirmTitle: "Install Computer Use %@?",
        .updatesConfirmBody: "The service stops, the app is replaced in place and reopens. Paired clients and system permissions are kept.",
        .updatesConfirmActive: "An agent is controlling an app right now; installing interrupts its current action.",
        .updatesConfirmInstall: "Install and Relaunch",
        .updatesNotes: "What's new:",
        .updatesCancel: "Cancel Download",
        .updateErrorNetwork: "Cannot reach the update server; check the network connection.",
        .updateErrorTimeout: "The update server did not respond in time; try again later.",
        .updateErrorRateLimit: "GitHub rate limit reached; try again later.",
        .updateErrorChanged: "The latest release changed; check for updates again.",
        .updateErrorNoPackage: "The latest release has no package for this computer.",
        .updateErrorUpToDate: "Computer Use is already up to date.",
        .updateErrorGeneric: "The update service reported: %@",
        .updateErrorLaunch: "Cannot run the bundled update component.",
        .updateErrorOutput: "The bundled update component returned an unreadable result.",
        .verifyFailed: "The package failed verification: %@",
        .verifyExtract: "The package could not be extracted.",
        .verifyBundle: "The app in the package has an unexpected identifier or version.",
        .verifySignature: "Its signature does not match this app's developer.",
        .verifyGatekeeper: "It did not pass the Gatekeeper notarization check.",

        .aboutDescription: "A local MCP and command-line service that lets AI agents see and operate the apps you allow.",
        .aboutVersion: "Version %@ (%@)",
        .aboutWebsite: "Website",
        .aboutReleases: "Releases",
        .aboutLicenses: "Licenses",
    ]
}

/// 取当前语言的文案。
public func tr(_ key: L10nKey) -> String { L10n.text(key) }
/// 取当前语言的文案并填入参数（%@ 对应字符串，%ld 对应 Int）。
public func tr(_ key: L10nKey, _ arguments: CVarArg...) -> String { L10n.format(key, arguments) }
