# 模板维护

模板是**预编译产物**，不入库（`packages/cli/templates/{android,windows}` 被
`.gitignore` 忽略）。它们作为 GitHub Release 资产分发，`mio build` 需要时下载并缓存。

改壳（`shell/` 下的 Dart/Kotlin/C++）之后必须重建模板，否则用户拿到的还是旧壳。

## 本地重建

```powershell
./scripts/build-templates.ps1                 # Android（universal + arm64）+ Windows
./scripts/build-templates.ps1 -Platform android -SkipUniversal
```

脚本做的是：

```text
flutter build apk --release -t lib/main_android.dart --target-platform android-arm,android-arm64,android-x64
flutter build apk --release -t lib/main_android.dart --target-platform android-arm64
flutter build windows --release -t lib/main_windows.dart
→ packages/cli/templates/android/mio-shell-{universal,arm64}.apk
→ packages/cli/templates/windows/（整个 Release 目录）
```

需要 Flutter 3.47+；Android 需要 SDK/JDK，Windows 需要 Visual Studio。x64 模板默认不发布，
需要时用 `--target-platform android-x64` 单独构建。

本地存在模板时，`mio build` 会**优先使用本地目录**（`source: local`），不会联网。

## 发布

打标签即触发 `.github/workflows/release.yml`：

1. `android` job：在 ubuntu 上构建三份 APK；
2. `windows` job：在 windows 上构建并用 `Compress-Archive` 打成 `mio-windows.zip`
   （归档根目录就是模板目录，CLI 解包后要能直接看到 `data/`）；
3. `publish` job：`scripts/write-template-manifest.mjs` 生成 `manifest.json`
   （sha256、大小、apiVersion、templateVersion），连同五个文件一起挂到 Release。

```powershell
git tag -a v0.1.0 -m "Mio 0.1.0"
git push --follow-tags
```

## 用户侧解析顺序

1. 显式指定：`--template <path>`、`mio.config.json` 的 `android.template` /
   `windows.templateDir`、环境变量 `MIO_ANDROID_TEMPLATE` / `MIO_WINDOWS_TEMPLATE`；
2. 本地模板目录（仓库 checkout 里由上面脚本生成）；
3. 缓存：`%LOCALAPPDATA%\mio\templates\<cli版本>\`（Linux/macOS 用 `$XDG_CACHE_HOME` 或 `~/.cache`）；
4. 从 `https://github.com/iYeXin/Mio/releases/download/v<cli版本>/` 下载并校验 sha256。

校验规则：

- 模板 manifest 的 `apiVersion` 主版本必须与 CLI 一致，否则拒绝使用；
- 单 ABI 模板必须真的包含 `arm64-v8a` / `x86_64`；不匹配会提示用哪个 `--target-platform` 重建；
- 显式指定单个 APK 时，CLI 校验 zip 结构（`AndroidManifest.xml` + `libapp.so`）。

## Web 模板

`templates/web` 是脚手架源；`packages/cli/templates/web` 是 CLI 内置副本（**这份入库**）。
修改后同步：

```powershell
Remove-Item packages/cli/templates/web -Recurse -Force
New-Item packages/cli/templates/web -ItemType Directory
Copy-Item templates/web/* packages/cli/templates/web -Recurse
Remove-Item packages/cli/templates/web/{node_modules,dist,build,.mio} -Recurse -Force
```

## 同步后验证

1. `pnpm -r test` + `cd shell && flutter analyze && flutter test`；
2. 用临时 app 走 CLI 全流程：`mio build --platform windows --skip-web`，启动产物确认页面加载；
3. 桥协议改动时跑 `tools/verification/process`（进程 API）与 `tools/verification/native`
   （原生 API，18 项检查）；
4. 打标签后确认 Release 里五个资产齐全，`manifest.json` 的 apiVersion 与 CLI 一致。
