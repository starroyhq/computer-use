# 应用图标

- `app-icon.svg`：矢量源图，浅蓝底板上的青紫柔光搭配亮冰青圆润光标。
- `app-icon.png`：从 SVG 渲染的 1024 px 透明背景预览。
- `app-icon.icns`：macOS App 图标，包含 16–1024 px 表示；单独增加透明留白，使可见底板在 Dock 中与相邻图标大小接近。
- `app-icon.ico`：Windows exe、窗体、正常托盘及安装器图标，包含 16、20、24、32、48、64、128、256 px 表示。
- `menu-bar-icon.svg` / `menu-bar-icon.png`：从同一光标路径导出的 macOS 菜单栏模板图标，只保留实心轮廓；PNG 为 36 px，以 18 pt 显示，支持 Retina。

指针路径 `#cursor` 来自 Cua Driver 0.38.0 的默认光标轮廓，许可见 [CUA-CURSOR-LICENSE.txt](CUA-CURSOR-LICENSE.txt)。Windows 托盘使用完整图标的小尺寸帧；macOS 菜单栏仅取指针轮廓，由系统按背景着色。
