# Mio API v1

`@iyexin/mio-api` 是 Web 侧的类型封装。真正的 bridge 实现在 `packages/api/bootstrap.js`：
它由运行时注入，或由 Web bundle 通过 side-effect import 执行。

所有 API 调用返回 Promise；事件通过 `Mio.on` 注册。

```ts
import { Mio, app, fs, clipboard } from "@iyexin/mio-api";

await Mio.ready;
const info = await app.info();
await fs.writeText("notes/hello.txt", "hello");
console.log(await fs.readText("notes/hello.txt"));
const unsubscribe = await Mio.on("app.lifecycle", (event) => {
  console.log(event);
});
```

## 低层接口

| 成员 | 说明 |
|---|---|
| `Mio.ready` | 等待 WebSocket 连接与握手完成 |
| `Mio.state` | 当前连接状态：`connecting` / `open` / `closed` |
| `Mio.invoke<T>(method, params?)` | JSON-RPC 调用，返回 Promise |
| `Mio.on(name, handler)` | 订阅事件，返回取消函数（Promise 包裹） |
| `Mio.once(name, handler)` | 只订阅一次 |
| `Mio.off(name, handler)` | 取消订阅 |

桥每 5 秒发一次 `ping`，4 秒没有回就主动断开重连。这样“壳卡死/被杀”会在几秒内以
`MIO_DISCONNECTED` 暴露出来，而不是等到下一次调用的 30 秒超时。

`window.Mio` 与 `@iyexin/mio-api` 导出的 `Mio` 使用同一个 bridge；bootstrap 有重复安装保护。

## app

| 方法 | 返回 |
|---|---|
| `app.info()` | `{ id, name, version, title, platform, apiVersion, templateVersion, dev, startedAt, uptimeMs, features }` |
| `app.paths()` | `{ data, app, native, install, temp }`，Windows 上另有 `home` / `desktop` / `documents` / `downloads` / `pictures` / `music` / `videos`，Android 上是 `external`（应用专属外部目录） |
| `app.log(level, message)` | 追加到 `logs/mio.log`（约 1 MB 轮转），返回 `{ path }` |
| `app.quit()` | `void` |

`features` 用来在运行前判断能力，而不是靠 `try/catch` 才发现：

| 字段 | 含义 |
|---|---|
| `dev` | true 表示页面来自 dev server，没有应用归档（`nativeApi` 因此不可用） |
| `features.native` | `nativeApi` 可用（平台支持 + 有应用归档） |
| `features.process` | `processApi` 可用（Windows） |
| `features.window` | 窗口控制可用 |
| `features.notify` | `notify.send` 可用（Android） |
| `features.media` | `media.pickImage` 可用（Android / Windows） |
| `features.foreground` | 前台服务可用：Android 且配置里声明了 `android.foregroundService` |

## platform

| 方法 | 返回 |
|---|---|
| `platform.info()` | `{ os, osVersion, locale, processors, platform, abi }` |
| `platform.keepAwake(enabled)` | 保持屏幕常亮（Android、Windows） |
| `platform.orientation(mode)` | 锁定屏幕方向：`auto` / `portrait` / `landscape`（Android） |

## fs

文件根目录固定为应用数据目录下的 `app/`。绝对路径和 `..` 越界会被拒绝。

| 方法 | 说明 |
|---|---|
| `fs.readText(path)` | 读 UTF-8 文本 |
| `fs.writeText(path, text)` | 写 UTF-8 文本，自动建父目录（先写 `.part` 再改名） |
| `fs.appendText(path, text)` | 追加 UTF-8 文本，文件不存在时创建 |
| `fs.readBytes(path)` | 读二进制，返回 `Uint8Array`（走 HTTP blob，流式） |
| `fs.writeBytes(path, data)` | 写 `Uint8Array` / `ArrayBuffer`（走 HTTP blob，流式） |
| `fs.blobUrl(path)` | 返回可用于 `fetch()` 的 blob URL（支持 Range） |
| `fs.list(path?)` | 返回 `FileEntry[]` |
| `fs.stat(path)` | 返回 `FileStat \| null` |
| `fs.mkdir(path)` | 递归创建目录 |
| `fs.remove(path, recursive?)` | 删除文件/目录 |
| `fs.rename(from, to)` | 重命名文件 |
| `fs.copy(from, to)` | 复制文件或目录；文件流式写入临时文件再改名 |
| `fs.exists(path)` | 是否存在 |

### 二进制传输

二进制数据**不经过 JSON-RPC**。base64 over JSON 会把内存放大并阻塞解析，因此二进制
走独立的 HTTP 端点：

```text
GET|HEAD /__mio__/blob?token=<token>&path=<path>   读取（支持 Range）
POST|PUT /__mio__/blob?token=<token>&path=<path>   写入请求体
```

- token 与 WebSocket 相同，每次启动随机生成；
- 路径规则与 `fs.*` 完全一致（只能访问应用数据目录）；
- 支持 `Range: bytes=start-end`、`bytes=start-`、`bytes=-suffix`，返回 `206` 与
  `Content-Range`；
- 上传是流式写盘，不会把整个文件读进内存；
- dev 模式下跨 origin 请求会带 CORS 头（仅允许已注册的 origin）。

底层 bridge 暴露了三个方法，`@iyexin/mio-api` 已经封装：

```ts
window.Mio.blobUrl(path);          // 拼 URL，可自行 fetch
window.Mio.readBlob(path);         // -> Promise<Uint8Array>
window.Mio.writeBlob(path, bytes); // -> Promise<void>
```

`fs.readBytes` / `fs.writeBytes` / `fs.blobUrl` 就是这三个方法的封装。

## dialog

系统文件选择器；对话框 UI 由系统提供，Mio 不画控件。

| 方法 | 说明 |
|---|---|
| `dialog.openFile(extensions?)` | 选择文件，返回路径或 null |
| `dialog.openDirectory()` | 选择目录，返回路径或 null |
| `dialog.saveFile(suggestedName?)` | 选择保存位置，返回路径或 null |
| `dialog.openFiles(extensions?)` | 多选文件，返回路径数组（取消时为空数组） |

## tray（Windows）

| 方法 | 说明 |
|---|---|
| `tray.set({ icon?, tooltip?, menu? })` | 设置托盘图标/提示/菜单；`icon` 是沙箱内的 PNG 路径 |
| `tray.remove()` | 移除托盘 |
| `tray.onClick(handler)` | `{ button: "left" \| "right" }` |
| `tray.onMenu(handler)` | `{ id, label }`，`id` 取自菜单项 |

## share

| 方法 | 说明 |
|---|---|
| `share.text({ text, subject? })` | 系统分享文本 |
| `share.file({ path, mimeType?, subject? })` | 分享沙箱文件 |

Android 走 `Intent.ACTION_SEND`，Windows 走系统分享面板；不可用时返回 `UNSUPPORTED`。

## clipboard

| 方法 | 说明 |
|---|---|
| `clipboard.readText()` | 读文本或 null |
| `clipboard.writeText(text)` | 写文本 |

## shell

| 方法 | 说明 |
|---|---|
| `shell.openExternal(url)` | 只允许 http/https/mailto |
| `shell.openPath(path)` | 用系统默认程序打开沙箱内的文件（仅 Windows） |
| `shell.reveal(path)` | 在资源管理器中定位文件/目录（仅 Windows） |

## http

WebView 的 `fetch()` 受同源策略和 CORS 限制。`http` 由 Dart 执行，没有这些限制；二进制
不经 base64：请求体来自字符串或沙箱文件，响应要么是文本，要么落到沙箱文件里。

```ts
const r = await http.request({ url: "https://api.github.com/repos/iYeXin/Mio" });
r.status;      // 200
r.text;        // 文本响应体（content-type 是文本类且不超过 maxBytes）
r.path;        // 二进制响应体所在的沙箱路径，可用 fs.blobUrl(path) 读取

await http.download({ url, path: "downloads/app.zip", id: "zip", resume: true });
await http.upload({ url: "https://example.com/put", path: "downloads/app.zip" });
```

| 方法 | 说明 |
|---|---|
| `http.request({ url, method?, headers?, body?, bodyFile?, timeoutMs?, followRedirects?, proxy?, caFile?, saveTo?, maxBytes? })` | 返回 `{ status, url, headers, bytes, contentType, text?, path? }` |
| `http.download({ url, path, resume?, id?, ... })` | 流式写文件，支持 `Range` 续传，返回 `{ status, path, bytes, transferred, resumed }` |
| `http.upload({ url, path, method?, id?, ... })` | 把沙箱文件作为请求体流式上传，返回 `{ status, bytes, headers, body }` |
| `http.serve({ host?, port?, maxBodyBytes? })` | 启动本地服务，返回 `{ host, port }` |
| `http.stop()` | 关闭服务 |
| `http.respond(id, { status?, headers?, body?, bodyFile? })` | 回应一次请求 |
| `http.onRequest(handler)` | 订阅并自动回应，返回取消函数 |
| `http.onProgress(handler)` | 订阅 `http.progress`：`{ id, direction, received, total, ratio }` |

规则：

- `body` 是 UTF-8 字符串；二进制请求体用 `bodyFile`（沙箱路径），不经过 JSON；
- 响应是文本类（`text/*`、`application/json`、xml…）且不超过 `maxBytes`（默认 8 MB）时
  直接回 `text`；否则写入沙箱，回 `path`，页面用 `fs.blobUrl(path)` 读取；
- `saveTo` 直接把响应流写进指定文件，返回 `path`；
- 只允许 http/https；
- 代理：`proxy` 参数 > `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 环境变量；`NO_PROXY` 生效；
- `caFile` 指向沙箱里的 PEM，追加到信任链（自签/内网 CA）；
- `http.download` 校验 `Content-Length`，不匹配报 `HTTP_INCOMPLETE`；续传时文件写到
  `.part`，校验通过再改名。

服务默认绑定 `127.0.0.1`；要接受局域网连接，显式传 `host: "0.0.0.0"`。每个请求以
`http.request` 事件推给页面：

```ts
await http.serve({ host: "0.0.0.0", port: 8080 });
await http.onRequest(async (request) => {
  if (request.path === "/health") {
    return { status: 200, headers: { "content-type": "text/plain" }, body: "ok" };
  }
  return { status: 404 };
});
```

事件数据：`{ id, method, path, query, headers, remote, body: Uint8Array }`。页面 60 秒内
不回应，服务返回 504；请求体超过 `maxBodyBytes`（默认 16 MB）返回 413。
## notify

| 方法 | 说明 |
|---|---|
| `notify.send({ title, body?, id? })` | 系统通知，Android only；Android 13+ 首次调用请求权限，立即返回 |
| `notify.progress({ id?, title?, text?, progress, max? })` | 常驻进度通知，适合下载；完成后用 `notify.cancel(id)` |
| `notify.cancel(id)` | 取消通知 |

Windows 没有对应实现，调用返回 `UNSUPPORTED`。

## media

| 方法 | 说明 |
|---|---|
| `media.pickImage()` | 打开系统相册（Windows 上是文件选择器），把图片复制到沙箱 `media/`，返回 `{ path, name, mime, size }` 或 `null` |
| `media.pickImages({ max? })` | 多选；Android 13+ 走系统 Photo Picker，取消时返回空数组 |

`path` 是相对沙箱的路径，可以直接交给 `fs.readBytes` / `fs.blobUrl`。

## foreground

Android 前台服务：带一个常驻通知，让进程在后台继续存活（后台下载、长任务）。
需要先在 `mio.config.json` 里声明：

```json
{ "android": { "foregroundService": true } }
```

| 方法 | 说明 |
|---|---|
| `foreground.start({ title?, text? })` | 启动服务并显示常驻通知 |
| `foreground.stop()` | 停止服务 |
| `foreground.info()` | `{ supported, declared, running }` |

未声明时调用 `foreground.start` 会失败（`FORBIDDEN`）；非 Android 平台返回
`UNSUPPORTED`。服务类型声明为 `dataSync`，Android 14+ 需要
`FOREGROUND_SERVICE_DATA_SYNC` 权限（模板已包含）。

## nativeApi（Android / Windows）

进程内加载自己的动态库，两种用法任选：

1. **只调函数**：`nativeApi.call()`，用固定的一组标量签名调用导出函数，不需要入口、
   不需要通信协议；
2. **跑主入口**：`nativeApi.start()` 调用可选的 `mio_start`，之后库可以通过回调向页面
   推标量事件，复杂逻辑与自定义通信都归库自己。

```ts
import { nativeApi } from "@iyexin/mio-api";

const lib = await nativeApi.load("demo");            // native/<abi>/demo.so|dll
const sum = await nativeApi.call(lib.handle, "mio_add", "i32(i32,i32)", [2, 3]);

await nativeApi.onEvent(({ handle, event, a, b, c }) => {
  console.log(handle, event, a, b, c);
});
const started = await nativeApi.start(lib.handle, '{"level":"info"}'); // { code, running }
```

| 方法 | 返回 |
|---|---|
| `nativeApi.load(name)` | `{ handle, name, abi, path, file, entry, started }` |
| `nativeApi.start(handle, config?)` | `{ handle, code, running }`，`config` 会以 UTF-8 传入 `mio_start` |
| `nativeApi.stop(handle)` | `{ handle, stopped, reason?, timedOut? }`，调用可选的 `mio_stop` |
| `nativeApi.call(handle, symbol, signature, args?)` | 标量结果或 `null`（`void`） |
| `nativeApi.emit(handle, event, a?, b?, c?)` | `void`，把标量事件送进库的 `mio_event` |
| `nativeApi.list()` | 已加载的库 |

### 库的落点

库放在应用内容的 `native/<abi>/<name>.so`（Android）或 `native/<abi>/<name>.dll`
（Windows），`<abi>` 是 `arm64`、`x64`、`arm`、`x86` 之一。首次 `load` 时壳会把它解到
应用数据目录再 `dlopen`，同一进程内重复 `load` 返回同一个 handle。

可运行的最小工程见 [examples/native-demo](../examples/native-demo/)。

ABI 与文件头会在加载前校验：ELF/PE 头不对、机器类型与当前进程不符，都会在 `dlopen`
之前报 `NATIVE_INVALID`，而不是抛出 linker 噪声。

### 支持的签名

参数类型 `i32`、`i64`、`f64`、`str`，返回类型 `void`、`i32`、`i64`、`f64`。参数形状
固定为这 13 种（`str` 只出现在首位）：

```text
()
(i32)          (i32,i32)        (i32,i32,i32)
(i64)          (i64,i64)
(f64)          (f64,f64)
(str)          (str,i32)        (str,i32,i32)
(i32,f64)      (i32,f64,f64)
```

每种形状都支持 4 种返回类型，共 52 个签名，例如 `i32(i32,i32)`、`f64(f64,f64)`、
`void(str)`、`i64(i64)`。这是一份**刻意收窄**的清单：壳是预编译的，每种可调用形状都
必须存在于模板里。不在清单内的签名会得到 `NATIVE_BAD_SIGNATURE`，不会静默失败。

`str` 参数由壳分配、调用后立即释放，**库不得保留该指针**。缓冲区、结构体、指针出参
不在支持范围内 —— 用文件、blob 端点，或退回 `processApi`。

### 主入口与事件桥

库可选导出：

```c
typedef void (*mio_sink_fn)(int32_t event, int64_t a, int64_t b, double c);
int32_t mio_start(mio_sink_fn sink, const char* config);
```

- `mio_start` 在**独立 isolate** 里调用：即使它阻塞，也不会冻住界面；5 秒内返回则
  `start()` 得到 `code`，否则返回 `running: true` 并让它继续跑；
- `config` 是 UTF-8 只读字符串，只在调用期间有效；
- 库可以在**任意线程**调用 `sink`，参数只有标量；壳把它们转成 `native.event`；
- 事件顺序：同一线程内保序，跨线程不保证；
- `nativeApi.stop()` 调用可选的 `void mio_stop(void)`，让库先收尾；应用退出时壳也会
  对已启动的库做一次有界的 `mio_stop`（每个 1 秒），库本身仍然留在进程里；
- 反方向用 `nativeApi.emit()`，走可选的 `mio_event` 导出：

```c
void mio_event(int32_t event, int64_t a, int64_t b, double c);
```

- 想要传字符串/二进制，自己写文件或开 socket，页面用 `fs.*` / `fetch` 去读。

## processApi（Windows）

侧车进程：启动一个可执行文件，并读写它的 stdio。Mio 没有原生插件机制，这是接
C/C++/Rust 的唯一方式（边界见 [native-extensions.md](native-extensions.md)）。
除 Windows 外，所有平台都返回 `UNSUPPORTED`。

```ts
import { processApi } from "@iyexin/mio-api";

const child = await processApi.spawn({ path: "sidecar/helper.exe", args: ["--port", "0"] });
await processApi.write(child.id, new TextEncoder().encode("ping\n"));
await processApi.closeStdin(child.id);

await processApi.onStdout(({ id, bytes }) => {
  if (id === child.id) console.log(new TextDecoder().decode(bytes));
});
await processApi.onExit(({ id, code }) => console.log(id, "exited", code));
```

| 方法 | 返回 |
|---|---|
| `processApi.spawn({ path, args?, cwd?, env? })` | `{ id, pid, executable, cwd }` |
| `processApi.write(id, data)` | `void`，`data` 可为 `Uint8Array`/`ArrayBuffer`/`string`（UTF-8） |
| `processApi.closeStdin(id)` | `void` |
| `processApi.kill(id, signal?)` | `{ id, pid, killed }`，`signal` 为 `"term"`（默认）或 `"kill"` |
| `processApi.list()` | `{ id, pid, executable }[]` |
| `processApi.exec({ command?, path?, args?, cwd?, env?, stdin?, timeoutMs?, maxOutputBytes? })` | 跑完整个命令并收集输出，返回 `{ code, pid, stdout, stderr, durationMs, truncated }` |
| `processApi.pid()` | 应用自己的 pid：`{ pid }` |
| `processApi.env(names?)` | 应用进程的环境变量：`{ env }`，`names` 可过滤 |
| `processApi.args()` | 应用自己的启动参数：`{ args }` |

事件：

| 事件 | 数据 |
|---|---|
| `process.stdout` / `process.stderr` | `{ id, pid, bytes }`（`@iyexin/mio-api` 已解码；原始 bridge 事件是 base64 `data`） |
| `process.exit` | `{ id, pid, code, signal, executable }` |
| `process.error` | `{ id, pid, stream, message }`，stdio 管道出错时推送 |

约定：

- 可执行文件只能位于**安装目录**（exe 旁）或**应用数据目录** `app/`；相对路径先按
  安装目录解析，再按数据目录解析，绝对路径必须最终落在两者之一内；
- 路径在校验前会解析 symlink，逃逸会被 `PROCESS_FORBIDDEN` 拒绝；
- 不经过 shell，`args` 原样以数组传给 `CreateProcess`；
- `cwd` 默认是可执行文件所在目录，同样必须在允许目录内；
- `env` 与父进程环境合并，不是替换；
- stdout/stderr 以 base64 分块推送，单块 ≤ 16 KB，**块边界没有语义**，读完先拼接；
- 并发上限 32 个侧车进程；
- `write` 是排队写入，不会因为子进程不读 stdin 而阻塞 RPC 调用；
- `kill` 先发 SIGTERM，5 秒未退出再发 SIGKILL；Windows 上两者都是 `TerminateProcess`；
- 关闭窗口或调用 `app.quit()` 会先结束所有侧车再退出（窗口处于 prevent-close 模式）；
  进程崩溃或被强杀时可能残留，**孙进程不跟踪**，需要子进程自行管理；
- 侧车与主进程同用户权限，应用代码必须是可信代码。

## processApi 补充说明

`exec` 的两种模式：

```ts
// 系统命令，走 cmd.exe /c
await processApi.exec({ command: "dir /b", cwd: "downloads" });

// 沙箱里的可执行文件，直接启动（仍受目录策略约束）
await processApi.exec({ path: "sidecar/tool.exe", args: ["--json"], stdin: "\n" });
```

输出各截断到 `maxOutputBytes`（默认 1 MB），`truncated` 标记是否截断。`command`
模式是真正的 shell 执行，只应在应用自己控制的内容上使用。

## windowApi（Windows）

| 方法 | 说明 |
|---|---|
| `windowApi.state()` | `{ supported, x, y, width, height, isMaximized, isFullScreen }` |
| `windowApi.setTitle(title)` | 设置窗口标题 |
| `windowApi.minimize()` | 最小化 |
| `windowApi.maximize()` | 最大化 |
| `windowApi.restore()` | 还原 |
| `windowApi.close()` | 关闭窗口 |
| `windowApi.center()` | 窗口居中 |
| `windowApi.moveTo(x, y)` | 移动窗口 |
| `windowApi.setFullScreen(bool)` | 全屏切换 |
| `windowApi.setAlwaysOnTop(bool)` | 置顶 |
| `windowApi.setSize(width, height)` | 设置窗口尺寸 |
| `windowApi.setDecorations(bool)` | 去掉/恢复标题栏；配合 `startDragging()` 自绘标题栏 |
| `windowApi.startDragging()` | 开始原生拖动，从自绘标题栏的 pointer-down 调用 |
| `windowApi.setResizable(bool)` | 是否允许缩放 |
| `windowApi.setMinimumSize(width, height)` | 最小尺寸 |
| `windowApi.setVisible(bool)` | 显示/隐藏窗口 |
| `windowApi.setMenuBarVisible(bool)` | 原生菜单栏显隐（模板默认没有菜单，调用会报告实际情况） |
| `windowApi.setHasShadow(bool)` | DWM 窗口阴影；无边框窗口下带小圆角 |
| `windowApi.focus()` / `windowApi.blur()` | 聚焦/失焦 |
| `windowApi.setSize(width, height)` | 设置窗口尺寸 |
| `windowApi.onState(handler)` | 移动/缩放/最大化后推送 `window.state`，含 `isVisible` / `isFocused` / `hasShadow` |

Android 上 `windowApi` 返回 `supported: false`，动作调用会抛 `UNSUPPORTED`。

## 事件

| 事件 | 数据 |
|---|---|
| `bridge.state` | `{ state: "connecting" \| "open" \| "closed" }` |
| `http.request` | `{ id, method, path, query, headers, remote, bodyBase64 }`，原始 bridge 数据是 base64 |
| `http.progress` | `{ id, direction, received, total, ratio }`，约 120 ms 节流 |
| `window.state` | `{ x, y, width, height, isMaximized, isFullScreen }`（Windows） |
| `tray.click` | `{ button: "left" \| "right" }`（Windows） |
| `tray.menu` | `{ id, label }`（Windows） |
| `app.lifecycle` | `{ state: "resumed" \| "inactive" \| "paused" \| "detached" \| ... }` |
| `process.stdout` / `process.stderr` | `{ id, pid, data }`，`data` 是 base64 分块（`processApi.onStdout` 已解码） |
| `process.exit` | `{ id, pid, code, signal, executable }` |
| `process.error` | `{ id, pid, stream, message }` |
| `native.loaded` | `{ handle, name, abi, path, file, entry, started }` |
| `native.event` | `{ handle, event, a, b, c }`，来自 `mio_start` 的 sink |

事件由 shell 推送，WebSocket 消息格式：

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": { "name": "app.lifecycle", "data": { "state": "paused" } }
}
```

## 错误

Promise 会以 `MioError` 拒绝，带 `code`、`message`、`data`：

- `code` 是**稳定的符号码**（`FS_FORBIDDEN`、`PROCESS_NOT_FOUND`…），应用应当
  按它分支；
- `rpcCode` 是 JSON-RPC 的整数码（`-32602` 等），用于和标准客户端对齐；
- 当 shell 无法给出符号码时（例如请求本身不是合法 JSON），`code` 退化为数字码。

常见符号码：

| code | 含义 |
|---|---|
| `METHOD_NOT_FOUND` | 未知的 Mio 方法 |
| `BAD_REQUEST` | 参数缺失或类型错误 |
| `UNSUPPORTED` | 当前平台不支持（如 Android 上的 `windowApi` / `processApi`） |
| `FS_FORBIDDEN` | 路径越界（绝对路径、`..`、symlink 逃逸） |
| `FS_NOT_FOUND` | 文件/目录不存在 |
| `PROCESS_FORBIDDEN` | 侧车可执行文件或 cwd 位于允许目录之外 |
| `PROCESS_NOT_FOUND` | 侧车可执行文件/目录不存在，或 id 已失效 |
| `PROCESS_START_FAILED` | 系统拒绝启动该可执行文件 |
| `PROCESS_STDIN_CLOSED` | 进程的 stdin 已关闭 |
| `PROCESS_WRITE_FAILED` | 关闭 stdin 时出错 |
| `PROCESS_LIMIT` | 并发侧车进程超过上限（32） |
| `PROCESS_TIMEOUT` | `processApi.exec` 超时（默认 30 秒，最大 300 秒） |
| `NATIVE_NOT_FOUND` | 应用内容里没有这个库（`native/<abi>/<name>.<ext>`） |
| `NATIVE_UNAVAILABLE` | 当前平台不支持，或 dev 模式没有应用归档 |
| `NATIVE_INVALID` | 不是动态库，或 ABI 与当前进程不符 |
| `NATIVE_LOAD_FAILED` | 系统加载失败（附 16KB 对齐、缺依赖等提示） |
| `NATIVE_SYMBOL_NOT_FOUND` | 库没有导出该符号 |
| `NATIVE_BAD_SIGNATURE` | 签名不在支持清单里，或参数类型/个数不符 |
| `NATIVE_NO_ENTRY` | 调用了 `start()`，但库没有导出 `mio_start` |
| `NATIVE_ALREADY_STARTED` | 同一个库重复 `start()` |
| `NATIVE_NO_EVENT_HANDLER` | 调用了 `emit()`，但库没有导出 `mio_event` |
| `NATIVE_NOT_LOADED` | handle 不存在 |
| `NATIVE_CALL_FAILED` | 原生调用抛出未分类的错误 |
| `NATIVE_WORKER_LOST` | 库的 worker isolate 退出，挂起的调用被终止 |
| `WINDOW_ERROR` | 窗口操作失败（底层报错） |
| `SHELL_ERROR` | 打开 URL / 文件 / 资源管理器失败 |
| `NATIVE_START_FAILED` | `mio_start` 抛错 |
| `HTTP_BAD_URL` | 只允许 http/https URL |
| `HTTP_ERROR` | 请求失败（DNS、连接、写文件等） |
| `HTTP_TIMEOUT` | 请求超时 |
| `HTTP_RESPONSE_TOO_LARGE` | 响应超过 `http.request` 的上限（32 MB），改用 `http.download` |
| `HTTP_BIND_FAILED` | 端口被占用或地址不可用 |
| `HTTP_NO_PENDING_REQUEST` | `http.respond` 的 id 不存在或已回应 |
| `NOTIFY_FAILED` | 通知发送失败 |
| `MEDIA_FAILED` | 选择图片失败 |
| `FOREGROUND_FAILED` | 前台服务启动/停止失败 |
| `HTTP_INCOMPLETE` | 传输提前结束，与 `Content-Length` 不符 |
| `HTTP_RANGE_UNSUPPORTED` | 续传请求没有被服务器接受 |
| `HTTP_TLS_ERROR` | TLS 握手或证书校验失败（可用 `caFile` 追加 CA） |
| `TRAY_ICON_MISSING` | 托盘图标路径不存在 |
| `SHARE_FAILED` | 分享失败 |
| `SHARE_FILE_MISSING` | 要分享的文件不存在 |
| `FORBIDDEN` | 应用配置未声明该能力（如 `android.foregroundService`） |
| `MIO_TIMEOUT` | 调用超时（30 秒） |
| `MIO_DISCONNECTED` | WebSocket 断开 |

blob 传输失败时抛出 `FS_ERROR`，`data.status` 是 HTTP 状态码。

## 版本兼容

`mio-manifest.json` 可以声明：

```json
{
  "requires": { "apiVersion": "1.0.0" }
}
```

CLI 在构建时会自动写入。Shell 启动时校验：

- 主版本必须相同；
- 运行时版本必须 ≥ 要求版本。

不满足时 shell 直接显示错误页，而不是在调用时抛桥错误。

## 限制

- 文本仍走 JSON-RPC；只有二进制走 blob 端点。
- 事件只有 `app.lifecycle`、`process.*`、`native.*`；窗口尺寸等事件尚未实现。
- `fs` 不跟随 symlink，删除只支持文件/目录，不提供 watch。
- blob 端点仅绑定 `127.0.0.1`，不适用于跨机访问。
- `processApi` 只支持 Windows；Android 上没有对应的侧车能力。
- `nativeApi` 只支持标量调用与标量事件；加载后无法卸载，原生段错误会结束整个应用。
- `nativeApi` 只在 `mio build` 的产物里可用，dev 模式没有应用归档。
