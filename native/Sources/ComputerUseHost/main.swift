import AppKit
import Darwin

// 子进程意外退出后，向它的管道写入会产生 SIGPIPE 并直接终止宿主。忽略该信号后写入返回 EPIPE，
// 由 send 的错误处理进入停服流程。
signal(SIGPIPE, SIG_IGN)
let application = NSApplication.shared
let delegate = HostApplication()
application.delegate = delegate
application.run()
