# 应用图标

- `app-icon.svg`：手工绘制的矢量源图，暖白底板（`#F2EFE8`）搭配炭黑无尾光标（`#292826`）；光标外角和内凹处均使用曲线过渡。
- `app-icon.png`：从 SVG 渲染的 1024 px 透明背景预览。
- `app-icon.icns`：macOS App 图标，包含 16–1024 px 表示。
- `app-icon.ico`：Windows exe、窗体、正常托盘及安装器图标，包含 16、20、24、32、48、64、128、256 px 表示。
- `menu-bar-icon.svg` / `menu-bar-icon.png`：从同一光标路径导出的 macOS 菜单栏图标，去除底板并填充白色；PNG 为 36 px，以 18 pt 显示，支持 Retina。

修改 `app-icon.svg` 后，在已安装项目依赖和 Playwright Chromium 的 macOS 上运行 `node scripts/generate-icons.mjs`，提交源图及全部导出文件。脚本使用项目现有 Playwright 渲染矢量图，再通过 macOS 的 sips 和 iconutil 生成平台容器，不调用图像生成服务。CI 直接使用已转换文件，无需额外转换步骤。macOS 正常运行时显示白色光标，暂停、停止及异常等状态保留原有状态符号；提示文字仍显示正在控制的应用数量。Windows 正常托盘显示完整图标缩小版，停止/失败仍使用警告图标。

设计仅包含底板和一个指针路径，无窗口、尾柄、渐变、纹理或阴影。
