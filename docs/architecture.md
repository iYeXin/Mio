# Mio MVP 架构

## 1. 模板与内容分离

```
Web source ──vite build──> dist/ ──asar──> app.asar
                                              │
                          ┌───────────────────┴───────────────────┐
                          │                                       │
                 Android template APK                  Windows template folder
                 assets/mio/app.asar                    mio_shell.exe + data/
                          │                                       │
                 AXML + icon + re-sign                  PE RT_RCDATA injection
                          │                                       │
                          └───────────────────┬───────────────────┘
                                              │
                                     Flutter shell
```

模板壳是固定的 Flutter AOT 产物。应用构建**不重新编译 Flutter**，只修改容器内的资源
和元信息。

## 2. Android 构建流程

1. 读取模板 APK（`packages/cli/templates/android/mio-shell.apk`）。
2. 用 `yauzl` 解包全部条目。
3. 用 `patchManifestAxml` 修改 `AndroidManifest.xml`：
   - `package` 与所有包名派生的 permission/authority 字符串；
   - `versionCode` / `versionName`；
   - `application@label`（追加字符串，不破坏共享字符串）。
   - `dev.mio.mio_shell.MainActivity` 保留，避免包名变化后类找不到。
4. 可选：把 `res/*.png` 启动图标替换为配置的图标（按原尺寸 resize）。
5. 删除旧 `META-INF` 签名，加入 `assets/mio/app.asar`。
6. 用 `yazl` 重打包。
7. `zipalign`（4KB / 16KB）。
8. `apksigner` 签 v1/v2/v3；`minSdk 24+` 默认关闭 v1。
9. `apksigner verify` 通过后才把产物复制到最终路径。

## 3. Windows 构建流程

1. 复制模板目录到 `build/mio/windows/<AppName>/`。
2. 生成 `app.asar`。
3. `resedit` 把 asar 作为 `RT_RCDATA`、资源名 `MIO_ASAR` 写入 exe。
4. Flutter shell 用 `FindResourceW("MIO_ASAR", RT_RCDATA)` 读取。
5. 产物仍是 exe + DLL + `data/` 目录；单文件 exe 不在 MVP 范围。

## 4. 运行时启动

Android：

1. Flutter `main_android.dart`；
2. `MioPlatformAndroid` 通过 MethodChannel 把 `assets/mio/app.asar` 复制到 app data；
3. `AsarArchive.open` 读取 `mio-manifest.json`；
4. 启动 `MioServer`（HTTP + WebSocket）；
5. 创建 WebView，加载 `http://127.0.0.1:<port>/`。

Windows：

1. `main_windows.dart`；
2. `MioPlatformWindows` 用 Win32 FFI 读取 PE 资源，写入 app data；
3. 启动 server；
4. `webview_flutter_windows` 以 Texture 方式嵌入 WebView2，加载本地 URL。

Dev 模式：shell 读取 `MIO_DEV_URL`（Windows）或 `mio.devUrl` intent extra（Android），
跳过 asar；server 只提供 WS/bootstrap 相关能力。`mio dev` 通过
`adb reverse tcp:<port> tcp:<port>` 把 Android 设备端口映射到宿主 Vite。

## 5. HTTP 服务

路由：

- `/__mio__/rpc`：WebSocket 升级（token + Origin 校验）；
- `/__mio__/bootstrap.js`：从 asar 读取；
- `/__mio__/blob`：二进制读写（token 校验、Range、流式写盘）；
- `/__mio__/health`：健康检查；
- 其他路径：asar 静态文件；HTML 响应会注入：
  ```html
  <script>window.__MIO_BOOT__={...}</script>
  <script src="/__mio__/bootstrap.js"></script>
  ```

控制信道与数据信道分离：JSON-RPC 只传小消息，文件字节走 blob 端点。这样既避免
base64 放大，也不会让大 payload 阻塞 WebSocket 解析。

安全：

- 只绑定 `127.0.0.1`；
- 每次启动生成 32 字节随机 token；
- Origin 只允许自身 origin 和 dev origin；
- asar 路径标准化，拒绝 `..` / 绝对路径 / link / unpacked；
- 静态响应加 `X-Content-Type-Options: nosniff` 等头。

## 6. WebSocket 桥

JSON-RPC 2.0：

```json
{"jsonrpc":"2.0","id":1,"method":"app.info","params":{}}
{"jsonrpc":"2.0","id":1,"result":{...}}
```

事件：

```json
{"jsonrpc":"2.0","method":"event","params":{"name":"app.lifecycle","data":{"state":"paused"}}}
```

`bootstrap.js` 负责：

- 连接、自动重连、请求队列；
- 30 秒调用超时；
- `window.Mio` 挂载；
- 事件订阅/取消。

`@iyexin/mio-api` 负责类型和命名空间封装，不重复实现 transport。

## 7. 已知取舍

- 二进制 API 用 base64，而不是 binary frame；协议没有破坏，后续可加；
- 文件字节额外走 HTTP blob 端点（流式 + Range），JSON-RPC 只传控制消息；
- 错误对象同时带数字 `code`（JSON-RPC 合规）与符号 `mioCode`，页面侧用符号码分支；
- Flutter 模板包含完整引擎，Android universal APK 约 53.6 MB；
- 模板 API 变更需要发新模板；应用 asar 与模板 API 通过 `apiVersion` 对接；
- **不提供原生插件机制**：没有插件清单、寄存器、结构体 ABI、生命周期或版本协商；
- 原生能力只有两层，都很薄：Windows 侧车进程（`processApi`：起进程 + stdio）与进程内
  加载自有库（`nativeApi`：加载 + 固定标量签名调用 + 标量事件桥）。协议、线程、内存、
  失败恢复都留在应用侧；
- Windows Authenticode 通过 `windows.signCommand` 钩子接入外部签名工具，不内置证书。

范围：一个 WebView、一层桥、按需加载原生库。需要插件生态或大规模原生集成时，直接用
原生或 Flutter。细节见 [native-extensions.md](native-extensions.md)。
