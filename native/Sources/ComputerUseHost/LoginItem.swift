import ServiceManagement

/// 登录时打开：注册当前 App 为登录项（macOS 13 起的 SMAppService）。默认不注册。
enum LoginItem {
    static var status: SMAppService.Status { SMAppService.mainApp.status }

    /// 已注册（含等待用户在系统设置里允许）时视为开启。
    static var isOn: Bool { status == .enabled || status == .requiresApproval }

    static func setEnabled(_ enabled: Bool) throws {
        let service = SMAppService.mainApp
        if enabled {
            guard service.status != .enabled else { return }
            try service.register()
        } else {
            guard service.status == .enabled || service.status == .requiresApproval else { return }
            try service.unregister()
        }
    }

    static func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}
