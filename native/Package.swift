// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ComputerUseHost",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "ComputerUseHost", targets: ["ComputerUseHost"])],
    targets: [
        .target(name: "HostCore"),
        .executableTarget(name: "ComputerUseHost", dependencies: ["HostCore"]),
        .testTarget(name: "HostCoreTests", dependencies: ["HostCore"])
    ]
)
