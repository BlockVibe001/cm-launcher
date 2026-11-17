# 星云启动器 Android 更新日志

安卓专用版本号规则：`<Windows 版本>-android.<序号>`，例如 `1.0.68-android.1`。
安卓版号和 Windows 版号互相独立，Windows 正式版更新不会覆盖安卓版本；这里的条目只给安卓端使用。

## v1.0.68-android.0 · 2026-11-16 · 安卓专用

- 安卓专用更新通道与更新日志独立建立：不再和 Windows 共用一套版本号和更新源
- 安卓更新只读取 `.apk` 资产与 `CHANGELOG-ANDROID.md`，不会把 Windows `.exe` 当成安卓包
- 更新源目录独立为「更新源 / 安卓」，可放 `update.json` 和 APK 做内测
- 首个安卓 APK 构建完成后，在本条之后追加真实安装包版本和更新内容
