# Third-party notices

This project's original source and documentation are licensed under MIT. Dependencies are not relicensed by that choice. Preserve their copyright, license and notice files when distributing a binary package.

| Component | Pinned version | License / source |
|---|---|---|
| Cua Driver and native SDK | 0.28.2 | MIT, [upstream license](https://github.com/trycua/cua/blob/cua-driver-rs-v0.28.2/LICENSE.md) |
| MCP TypeScript server/client/node | 2.1.0 | MIT, [upstream](https://github.com/modelcontextprotocol/typescript-sdk) |
| Playwright | 1.63.0 | Apache-2.0, [upstream](https://github.com/microsoft/playwright) |
| Zod | 4.6.5 | MIT, [upstream](https://github.com/colinhacks/zod) |
| Node.js | Fixed by packaging script | Node's bundled LICENSE includes its third-party notices, [upstream](https://github.com/nodejs/node) |
| .NET runtime and Windows Forms | .NET 10; patch version selected by the build SDK/runtime packs | MIT for the original runtime and Windows Forms code; dependencies retain their own notices. [Runtime license](https://github.com/dotnet/runtime/blob/main/LICENSE.TXT), [Windows Forms license](https://github.com/dotnet/winforms/blob/main/LICENSE.TXT) |

The packaged production dependency tree retains installed package licenses; packaging additionally preserves Cua and Node binary licenses. Windows self-contained packages also carry `licenses/DOTNET-LICENSE` and `licenses/DOTNET-THIRD-PARTY-NOTICES`, copied from the build machine's .NET installation. The .NET patch version is not pinned by this repository; confirm the notices cover the runtime packs used when preparing a binary release. Chromium is downloaded separately on explicit request and carries its own notices. Build-time tools remain in the lockfile and are not shipped as production dependencies.

Source distributions include the project's `LICENSE` and `NOTICE`. Packaged applications also include these files and this dependency summary in their `licenses` directory. This summary does not replace the complete license and notice files of each dependency.
