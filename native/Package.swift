// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ComputerUseHost",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "ComputerUseHost", targets: ["ComputerUseHost"])],
    targets: [
        .target(name: "HostCore"),
        .executableTarget(
            name: "ComputerUseHost",
            dependencies: ["HostCore"],
            // 只有 debug 构建允许用 CU_RESOURCES_DIR 覆盖资源目录；发行包（-c release）不读取该变量。
            swiftSettings: [.define("CU_RESOURCES_OVERRIDE", .when(configuration: .debug))]
        ),
        .testTarget(name: "HostCoreTests", dependencies: ["HostCore"]),
        // 设置窗口布局测试：直接实例化各分区，不启动服务。
        .testTarget(name: "ComputerUseHostTests", dependencies: ["ComputerUseHost", "HostCore"])
    ]
)
