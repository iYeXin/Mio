# 模板目录

这个目录里**只有 `web/` 是源码**（脚手架模板）。预编译的 Flutter 模板
（`android/*.apk`、`windows/`）不入库：

- 仓库里：由 `scripts/build-templates.ps1` 本地构建，构建产物被 `.gitignore` 忽略；
- 发布的 CLI：`mio build` 从 GitHub Release 下载 `manifest.json` + 对应模板，校验
  sha256 后缓存到 `%LOCALAPPDATA%\mio\templates\<cli版本>\`（Linux/macOS 用
  `$XDG_CACHE_HOME` 或 `~/.cache`）；
- 都不适用时：显式指定模板（`--template <path>`、`mio.config.json` 的
  `android.template` / `windows.templateDir`、或 `MIO_ANDROID_TEMPLATE` /
  `MIO_WINDOWS_TEMPLATE`）。

模板与 CLI 的 **API 主版本**必须一致（`manifest.json` 的 `apiVersion`），否则 CLI 拒绝
使用；显式指定单个文件时，CLI 会校验 APK/目录结构，以及单 ABI 模板是否真的包含该 ABI。
