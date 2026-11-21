# 更新目录

同一个仓库，三个独立目录：

- `updates/stable/update.json`：Windows 正式版
- `updates/beta/update.json`：Windows 测试版
- `updates/mobile/update.json`：手机版

桌面端只读取对应目录，不再共用 GitHub Releases 列表。安装包本体放在 Release 资产里，目录里只放清单，避免 400 MB 的 exe 进入 Git 历史。

对外地址（仓库自己的 GitHub Pages，国内可访问）：

- `https://blockvibe001.github.io/cm-launcher/updates/stable/update.json`
- `https://blockvibe001.github.io/cm-launcher/updates/beta/update.json`
- `https://blockvibe001.github.io/cm-launcher/updates/mobile/update.json`
