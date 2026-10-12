import AppKit
import Darwin
import HostCore

// 子进程意外退出后，向它的管道写入会产生 SIGPIPE 并直接终止宿主。忽略该信号后写入返回 EPIPE，
// 由 send 的错误处理进入停服流程。
signal(SIGPIPE, SIG_IGN)
guard let mode = HostLaunchMode.parse(Array(CommandLine.arguments.dropFirst())) else { exit(2) }
if mode == .ensureRunning || mode == .recoverFault {
    let result = HostStartup.ensureRunning(recoveringFault: mode == .recoverFault)
    if let data = try? JSONEncoder().encode(result) {
        try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
    }
    exit(result.ok ? 0 : 1)
}
if mode == .background {
    do { try HostStartup.detachStandardStreams() } catch { exit(1) }
}
let application = NSApplication.shared
let delegate = HostApplication(background: mode == .background)
application.delegate = delegate
application.run()
