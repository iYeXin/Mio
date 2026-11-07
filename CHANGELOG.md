# Changelog

本文件记录 Mio 的对外变更。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)；
`MIO_API_VERSION`（桥契约）与 CLI 版本分开演进，见 [docs/release.md](docs/release.md)。

## 0.1.5 — 2026-11-07

- 工具包下载也遵循 `git config http.proxy`（与模板下载一致），没有代理环境变量时
  仍可拉取工具；
- `mio keystore` 支持用 `MIO_TOOLS_FORCE_DOWNLOAD=1` 刷新工具缓存。
## 0.1.4 — 2026-11-07

- 工具包里的 Java 运行时加入 `keytool`（`jdk.crypto.ec`），没有 JDK 也能生成证书；
- 新增 `mio keystore`：用自带 keytool 生成 PKCS12 证书，密码只从环境变量读取
  （`-storepass:env`），并打印可直接使用的 `android` 配置；
- 脚手架 `.gitignore` 覆盖 `.mio/*.p12`。
## 0.1.3 — 2026-11-07

- **Android 构建不再要求预装 Java / Android Studio**：缺少签名与对齐工具时按需下载，
  已有部分会跳过。工具约 1.4 MB（apksigner.jar + zipalign），jlink 裁剪的 Java 运行时
  约 18 MB，两者都缺时约 19 MB；
- 工具包按组件缓存（`~/.mio/tools/android/`），校验 sha256，支持 `MIO_TOOLS_CACHE_DIR`、
  `MIO_TOOLS_MANIFEST_URL`、`MIO_NO_TOOL_DOWNLOAD`、`MIO_TOOLS_FORCE_DOWNLOAD`；
- Release 增加工具包构建（linux-x64 / win32-x64 / darwin-arm64）与 `mio-tools.json` 清单；
- `mio doctor` 会说明工具链缺什么、首次构建是否会自动下载；
- 文档补充工具链段落与真实体积。
## 0.1.2 — 2026-11-07

- 新增 `fs.copy(from, to)`：复制文件或目录，文件流式写临时文件再改名；
- 新增 `dialog.openFiles(extensions?)`：多选文件，取消返回空数组；
- 新增 `platform.keepAwake(enabled)`：Android 保持屏幕常亮，Windows 用
  `SetThreadExecutionState`；
- 新增 `platform.orientation(mode)`：Android 锁定 `auto` / `portrait` / `landscape`；
- `mio create` 不再自动执行 `npm install`，只输出后续命令。

## 0.1.2 — 2026-11-07

- `mio create` 不再自动执行 `npm install`：装依赖由用户决定，输出里只给出下一步命令；
- 新 API：
  - `http.request` / `http.download`：由 Dart 发起请求，不受 CORS 限制，支持自定义方法、
    请求头和请求体；响应上限 32 MB，大文件走 `http.download` 流式写盘；
  - `http.serve` / `http.stop` / `http.respond` / `http.onRequest`：应用内 HTTP 服务，
    默认绑定 loopback，可显式开放到局域网；请求以 `http.request` 事件推到页面；
  - `notify.send`：Android 系统通知（Android 13+ 按需请求权限）；
  - `media.pickImage`：Android 相册 / Windows 文件选择器，图片复制到沙箱 `media/`；
  - `foreground.start` / `stop` / `info`：Android 前台服务（常驻通知），需要在
    `mio.config.json` 里声明 `android.foregroundService: true`；
- `app.info().features` 新增 `notify` / `media` / `foreground` / `tray` / `share` 五个能力位；
- `http` 重做：请求体不再走 base64（字符串或沙箱文件），响应按 content-type 返回文本或
  写入沙箱；新增 `http.upload`、`http.download` 的 `resume`、`http.progress` 事件、
  `Content-Length` 校验、`proxy` / `HTTPS_PROXY` 与 `caFile`；
- 通知补齐：`notify.progress`、`notify.cancel`；Android 13+ 走系统 Photo Picker，
  新增 `media.pickImages`；
- Windows：托盘（`tray.set/remove` + `tray.click` / `tray.menu` 事件）、窗口外观
  （`window.setDecorations` / `startDragging` / `setResizable` / `setMinimumSize`）
  与 `window.state` 事件；
- 新增 `share.text` / `share.file`（基于 `share_plus`）；
- 窗口初始状态写进 `mio.config.json` 的 `window`（`x`/`y`/`center`/`resizable`/
  `decorations`/`alwaysOnTop`/`minWidth`/`minHeight`），启动时在首帧前应用，避免闪烁；
- 窗口 API 补充：`window.setVisible`、`setHasShadow`（DWM 阴影，无边框时带圆角）、
  `setMenuBarVisible`、`focus` / `blur`，`window.state` 增加 `isVisible` / `isFocused` /
  `hasShadow`；
- 进程 API 补充（Windows）：`process.exec`（`command` 走 `cmd.exe /c`，`path` 直接启动，
  收集 stdout/stderr、超时与截断）、`process.pid`（应用自身 pid）、`process.env`、
  `process.args`（应用自己的启动参数）；
- 模板新增 `POST_NOTIFICATIONS`、`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_DATA_SYNC`
  权限与 `MioForegroundService` 声明；
- 新增 `tools/verification/platform` 验证应用。
## 0.1.1 — 2026-11-07

- npm 包改为 `@iyexin` scope：`@iyexin/mio-cli`、`@iyexin/mio-api`、
  `@iyexin/mio-android-tools`。用法 `npx @iyexin/mio-cli ...`，或全局安装后用 `mio`；
- `mio create` 直接依赖发布的 `@iyexin/mio-api`，不再把 API 复制进项目；
- API 收敛（此前没有对外发布，不留兼容层）：
  - 移除 `dialog.message` / `dialog.confirm`（Flutter 控件，不是系统对话框），
    `dialog` 只保留系统选择器；
  - 移除 `fs.readFile` / `fs.writeFile` 的 base64 形态；
  - 二进制统一为 `fs.readBytes` / `fs.writeBytes` / `fs.blobUrl`；
- 文档重组：README 重写，调研/决策/验收记录移出仓库；
- 发布：tag 触发模板构建与 Release，npm 通过 Trusted Publishing 发布（`npm-publish` 环境）。

## 0.1.0 — 2026-11-07

首个可用版本。

### 模板与构建

- Flutter 预编译壳（Android APK / Windows 目录）+ `app.asar` 注入，构建不重新编译 Flutter；
- Android：AXML 包名/版本/label 补丁、图标替换、`zipalign`（4KB/16KB）、`apksigner` v2/v3
  签名与 `verify`，只有 verify 通过才发布产物；
- Android 模板按 ABI 拆分：`universal`（约 54 MB）、`arm64`（约 19 MB）、`x64`（约 20 MB）；
- **模板不再入库**：作为 GitHub Release 资产发布，`mio build` 首次按需下载并校验 sha256，
  也可用 `--template <path>` 显式指定；本地重建见 `scripts/build-templates.ps1`；
- 打标签触发 `.github/workflows/release.yml`：构建模板、生成 `manifest.json`、发布 Release；
- Windows：PE `RT_RCDATA` 注入 `app.asar`、版本信息与图标补丁、`windows.signCommand` 钩子；
- 可选 16KB page size 对齐；模板维护流程见 [docs/template-maintenance.md](docs/template-maintenance.md)。

### 运行时

- 本地 HTTP 静态服务 + WebSocket JSON-RPC 2.0，绑定 `127.0.0.1` 随机端口、每次启动随机 token、
  校验 Origin；
- HTTP blob 端点（`GET|POST /__mio__/blob`）承担二进制，流式、支持 Range，不再 base64 放大；
- 请求**并发处理**：一个慢调用不会堵住整条桥；
- 桥每 5 秒心跳、4 秒无响应即重连，状态以 `bridge.state` 事件暴露；
- 错误对象同时带数字 `code` 与符号 `mioCode`，页面按 `FS_FORBIDDEN` 之类的符号码分支；
- API 版本握手：`mio-manifest.json` 的 `requires.apiVersion` 在启动时校验。

### Web API v1

- `app`：`info`（含 `dev`、`startedAt`、`uptimeMs`、`features`）、`paths`、`log`、`quit`；
- `platform.info`（含 `abi`）；
- `fs`：`readText` / `writeText` / `appendText`、`readBytes` / `writeBytes` / `blobUrl`、`list`、`stat`、`mkdir`、`remove`、`rename`、`exists`；
- `dialog`：`openFile`、`openDirectory`、`saveFile`（系统选择器，UI 由系统提供）；
- `clipboard`、`shell.openExternal`、`shell.openPath` / `shell.reveal`（Windows）；
- `windowApi`：状态、标题、最小化/最大化/还原/关闭、尺寸、移动、居中、全屏、置顶；
- 写文件统一走“临时文件 + 改名”，中断不会留下半截文件。

### 原生能力

- `nativeApi`（Android + Windows）：加载应用自带的 `.so`/`.dll`，固定标量签名调用
  （13 种参数形状 × 4 种返回类型）、可选的 `mio_start` 入口、`mio_event` 反方向事件、
  `mio_stop` 收尾；
- **每个库一个 worker isolate**：调用串行、不卡 UI；但**不是故障边界**，原生段错误会带走整个应用；
- 库从 asar 流式解包到应用数据目录，加载前校验 ELF/PE 头与 ABI，缓存键为归档 mtime + 条目位置；
- `processApi`（仅 Windows）：起进程、写 stdin、读 stdout/stderr、结束、列表；关窗时清理；
- 两者都不是插件机制：没有插件清单、注册表、ABI 兼容承诺或权限模型。

### 工具链

- `@iyexin/mio-cli`：`create` / `build` / `dev` / `doctor`，内置模板与 ABI 选择；
- `@iyexin/mio-android-tools`：APK 注入、AXML 补丁、图标替换、zipalign、apksigner、PE 资源注入、
  工具包下载与校验；
- `@iyexin/mio-api`：零依赖 `bootstrap.js` + 类型化的 ESM 封装（`app`/`fs`/`dialog`/`nativeApi`/…）。

### 文档与验收

- [README](README.md)、[API](docs/api.md)、[架构](docs/architecture.md)、
  [原生边界](docs/native-extensions.md)、[签名](docs/signing.md)、
  [手动验证](docs/manual-testing.md)、[验收记录](docs/mvp-acceptance.md)、
  [模板维护](docs/template-maintenance.md)、[发布流程](docs/release.md)；
- 三份调研记录：[apksigner 必要性](docs/research/apksigner.md)、
  [虚拟源 vs localhost](docs/transport-v2.md)、[进程内加载动态库](docs/research/native-in-process.md)；
- 自动化：`flutter test` 97 项、CLI 8 项、android-tools 15 项，`flutter analyze` 与
  `pnpm -r typecheck` 干净；CI 覆盖 Node 与 Flutter 两条流水线；
- 端到端：18 项检查在 Windows 11 与 Android 12 真机全部通过。

### 已知限制

见 [README「已知限制」](README.md#已知限制)：只出 APK 不出 AAB、Windows 非单文件、
没有原生插件机制、`nativeApi` 只有标量且无卸载、Android 无侧车进程、
16KB 只在模拟器验证、Windows 10 / 缺失 WebView2 未实测。
