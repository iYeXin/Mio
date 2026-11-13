# Mio API

`@iyexin/mio-api` 是 Web 侧的类型封装：所有调用返回 Promise，事件用 `Mio.on` 订阅。

```ts
import { Mio, app, fs } from "@iyexin/mio-api";

await Mio.ready;
const info = await app.info();
await fs.writeText("notes/hello.txt", "hello");
console.log(await fs.readText("notes/hello.txt"));

const unsubscribe = await Mio.on("app.lifecycle", (event) => {
  console.log(event);
});
```

## 调用与事件

| 成员 | 说明 |
|---|---|
| `Mio.ready` | 等待 WebSocket 连接与握手完成 |
| `Mio.state` | `connecting` / `open` / `closed` |
| `Mio.invoke<T>(method, params?)` | 调用任意方法 |
| `Mio.on(name, handler)` | 订阅事件，返回取消函数 |
| `Mio.once(name, handler)` | 只订阅一次 |
| `Mio.off(name, handler)` | 取消订阅 |

## app

| 方法 | 返回 |
|---|---|
| `app.info()` | `{ id, name, version, title, platform, apiVersion, templateVersion, dev, startedAt, uptimeMs, features }` |
| `app.paths()` | `{ data, app, native, install, temp }`；Windows 另有 `home` / `desktop` / `documents` / `downloads` / `pictures` / `music` / `videos`，Android 有 `external` |
| `app.log(level, message)` | 追加到 `logs/mio.log`（约 1 MB 轮转），返回 `{ path }` |
| `app.consumeBack()` | 告知壳这次返回已由页面处理 |
| `app.quit()` | 退出应用 |

`features` 用于在运行前判断能力：

| 字段 | 含义 |
|---|---|
| `dev` | 页面来自 dev server，没有应用归档（`nativeApi` 因此不可用） |
| `features.native` | `nativeApi` 可用 |
| `features.process` | `processApi` 可用（Windows） |
| `features.window` | 窗口控制可用 |
| `features.notify` | 通知可用（Android） |
| `features.media` | 相册/文件选择可用 |
| `features.foreground` | 前台服务可用（Android 且配置声明 `android.foregroundService`） |
| `features.storage` | 存储权限查询可用（Android） |
| `features.tray` | 托盘可用（Windows） |
| `features.share` | 系统分享可用 |

## platform

| 方法 | 返回 |
|---|---|
| `platform.info()` | `{ os, osVersion, locale, processors, platform, abi }` |
| `platform.display()` | `{ scaleFactor, bounds, workArea?, window? }`，尺寸为逻辑像素 |
| `platform.insets()` | 安全边距 `{ top, right, bottom, left }`（逻辑像素） |
| `platform.setSystemBars({ statusBarColor?, statusBarIcons?, navigationBarColor?, navigationBarIcons? })` | Android 系统栏颜色与图标明暗 |
| `platform.keepAwake(enabled)` | 保持屏幕常亮（Android、Windows） |
| `platform.orientation(mode)` | 锁定方向：`auto` / `portrait` / `landscape`（Android） |

## 安全边距

应用默认占满整个窗口（Android 进入 edge-to-edge，内容延伸到状态栏、刘海和导航栏下方）。
是否需要留出安全边距由页面自己决定：

- `platform.insets()` 返回 `{ top, right, bottom, left }`，单位是逻辑像素；
- 桥会在 `<html>` 上维护 `--mio-inset-top` / `--mio-inset-right` /
  `--mio-inset-bottom` / `--mio-inset-left`，随旋转和刘海变化自动更新；
- 也可以直接用 CSS `env(safe-area-inset-*)`，但页面需要在 viewport meta 里写
  `viewport-fit=cover`。

```css
body {
  padding-top: var(--mio-inset-top, env(safe-area-inset-top, 0px));
  padding-bottom: var(--mio-inset-bottom, env(safe-area-inset-bottom, 0px));
}
```

## fs

根目录是应用数据目录下的 `app/`，相对路径都从这里解析。

| 方法 | 说明 |
|---|---|
| `fs.readText(path)` | 读 UTF-8 文本 |
| `fs.writeText(path, text)` | 写 UTF-8 文本，自动建父目录 |
| `fs.appendText(path, text)` | 追加文本，文件不存在时创建 |
| `fs.readBytes(path)` | 读二进制，返回 `Uint8Array`（走 blob 端点） |
| `fs.writeBytes(path, data)` | 写 `Uint8Array` / `ArrayBuffer`（走 blob 端点） |
| `fs.blobUrl(path)` | 返回可用于 `fetch()` 的 blob URL（支持 Range） |
| `fs.list(path?)` | 返回 `FileEntry[]` |
| `fs.stat(path)` | 返回 `FileStat \| null` |
| `fs.mkdir(path)` | 递归创建目录 |
| `fs.remove(path, recursive?)` | 删除文件/目录 |
| `fs.rename(from, to)` | 重命名 |
| `fs.copy(from, to)` | 复制文件或目录 |
| `fs.exists(path)` | 是否存在 |

绝对路径默认拒绝。通过 `dialog.openFile` / `openFiles` / `saveFile` / `openDirectory`
选过的路径会获得本次运行的授权，之后可以直接使用：

```ts
const target = await dialog.saveFile("score.png");
if (target) await fs.writeBytes(target, png);
```

目录授权覆盖子路径，应用退出后失效。

### 二进制传输

二进制数据不经过 JSON-RPC，走独立的 HTTP 端点：

```text
GET|HEAD /__mio__/blob?token=<token>&path=<path>   读取（支持 Range）
POST|PUT /__mio__/blob?token=<token>&path=<path>   写入请求体
```

- token 与 WebSocket 相同，每次启动随机生成；
- 路径规则与 `fs.*` 一致；
- 支持 `Range`，返回 `206` 与 `Content-Range`；
- 上传流式写盘，不把整个文件读进内存；
- dev 模式下跨 origin 请求带 CORS 头，仅允许已注册的 origin。

`@iyexin/mio-api` 已封装为 `fs.readBytes` / `fs.writeBytes` / `fs.blobUrl`；底层也可
直接用 `window.Mio.readBlob` / `writeBlob` / `blobUrl`。

## dialog

系统文件选择器。

| 方法 | 说明 |
|---|---|
| `dialog.openFile(extensions?)` | 选择文件，返回路径或 `null` |
| `dialog.openFiles(extensions?)` | 多选，返回路径数组（取消时为空） |
| `dialog.openDirectory()` | 选择目录，返回路径或 `null` |
| `dialog.saveFile(suggestedName?)` | 选择保存位置，返回路径或 `null` |

返回的路径自动获得 `fs` 读写授权。

## tray（Windows）

| 方法 | 说明 |
|---|---|
| `tray.set({ icon?, tooltip?, menu? })` | 设置托盘图标、提示与菜单；`icon` 是沙箱内的 PNG |
| `tray.remove()` | 移除托盘 |
| `tray.onClick(handler)` | `{ button: "left" \| "right" }` |
| `tray.onMenu(handler)` | `{ id, label }` |

## share

| 方法 | 说明 |
|---|---|
| `share.text({ text, subject? })` | 分享文本 |
| `share.file({ path, mimeType?, subject? })` | 分享沙箱文件 |

Android 走 `Intent.ACTION_SEND`，Windows 走系统分享面板。

## clipboard

| 方法 | 说明 |
|---|---|
| `clipboard.readText()` | 读文本或 `null` |
| `clipboard.writeText(text)` | 写文本 |

## shell

| 方法 | 说明 |
|---|---|
| `shell.openExternal(url)` | 只允许 http/https/mailto |
| `shell.openPath(path)` | 用默认程序打开沙箱文件（Windows） |
| `shell.reveal(path)` | 在资源管理器中定位文件/目录（Windows） |

## http

`http` 由壳执行，不受 WebView 的同源策略与 CORS 限制。

```ts
const r = await http.request({ url: "https://api.github.com/repos/iYeXin/Mio" });
r.status;  // 200
r.text;    // 文本响应体
r.path;    // 二进制响应体所在的沙箱路径

await http.download({ url, path: "downloads/app.zip", id: "zip", resume: true });
await http.upload({ url: "https://example.com/put", path: "downloads/app.zip" });
```

| 方法 | 说明 |
|---|---|
| `http.request({ url, method?, headers?, body?, bodyFile?, timeoutMs?, followRedirects?, proxy?, caFile?, saveTo?, maxBytes? })` | 返回 `{ status, url, headers, bytes, contentType, text?, path? }` |
| `http.download({ url, path, resume?, id?, ... })` | 流式写文件，支持 Range 续传，返回 `{ status, path, bytes, transferred, resumed }` |
| `http.upload({ url, path, method?, id?, ... })` | 流式上传沙箱文件，返回 `{ status, bytes, headers, body }` |
| `http.serve({ host?, port?, maxBodyBytes? })` | 启动本地服务，返回 `{ host, port }` |
| `http.stop()` | 关闭服务 |
| `http.respond(id, { status?, headers?, body?, bodyFile? })` | 回应一次请求 |
| `http.onRequest(handler)` | 订阅并自动回应，返回取消函数 |
| `http.onProgress(handler)` | 订阅 `http.progress` |

规则：

- 请求体是字符串或沙箱文件（`bodyFile`），二进制不经过 JSON；
- 文本类响应且不超过 `maxBytes`（默认 8 MB）直接回 `text`，否则写入沙箱回 `path`；
- `saveTo` 把响应流写入指定文件；
- 只允许 http/https；
- 代理优先级：`proxy` 参数 > `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`，`NO_PROXY` 生效；
- `caFile` 指向沙箱里的 PEM，追加到信任链；
- `download` 校验 `Content-Length`，续传先写 `.part`，校验通过再改名。

本地服务默认绑定 `127.0.0.1`，需要局域网访问时传 `host: "0.0.0.0"`：

```ts
await http.serve({ host: "0.0.0.0", port: 8080 });
await http.onRequest(async (request) => {
  if (request.path === "/health") {
    return { status: 200, headers: { "content-type": "text/plain" }, body: "ok" };
  }
  return { status: 404 };
});
```

请求事件数据：`{ id, method, path, query, headers, remote, body: Uint8Array }`。60 秒内
不回应返回 504；请求体超过 `maxBodyBytes`（默认 16 MB）返回 413。

## notify

| 方法 | 说明 |
|---|---|
| `notify.send({ title, body?, id? })` | 系统通知（Android）；Android 13+ 首次调用请求权限，立即返回 |
| `notify.progress({ id?, title?, text?, progress, max? })` | 常驻进度通知 |
| `notify.cancel(id)` | 取消通知 |

## media

| 方法 | 说明 |
|---|---|
| `media.pickImage()` | 打开系统相册（Windows 上是文件选择器），复制到沙箱 `media/`，返回 `{ path, name, mime, size }` 或 `null` |
| `media.pickImages({ max? })` | 多选；Android 13+ 走系统 Photo Picker，取消时返回空数组 |
| `media.saveImage({ path, album? })` | 把沙箱图片写入系统相册 `Pictures/<album>`（默认 `Mio`），返回 `{ uri, name, album, path? }` |

`pickImage` 返回的 `path` 相对沙箱，可直接交给 `fs.readBytes` / `fs.blobUrl`。
`saveImage` 在 Android 10+ 不需要存储权限。

## storage

| 方法 | 返回 |
|---|---|
| `storage.status()` | `{ granted, scoped }` |
| `storage.request({ type?: "images" \| "video" })` | 申请相册读取权限，返回同样的状态 |

Android 13+ 使用 `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO`，更老的系统使用
`READ_EXTERNAL_STORAGE`。`scoped=true` 表示分区存储：直接写共享目录不可用，改用
`media.saveImage`。

## foreground

Android 前台服务：带常驻通知，让进程在后台继续存活。需要先在配置里声明：

```json
{ "android": { "foregroundService": true } }
```

| 方法 | 说明 |
|---|---|
| `foreground.start({ title?, text? })` | 启动服务并显示常驻通知 |
| `foreground.stop()` | 停止服务 |
| `foreground.info()` | `{ supported, declared, running }` |

未声明时 `start` 返回 `FORBIDDEN`；非 Android 平台返回 `UNSUPPORTED`。服务类型为
`dataSync`，Android 14+ 需要 `FOREGROUND_SERVICE_DATA_SYNC`（模板已包含）。

## nativeApi

进程内加载自己的动态库，两种用法：

1. **只调函数**：`nativeApi.call()`，用固定的标量签名调用导出函数；
2. **跑主入口**：`nativeApi.start()` 调用可选的 `mio_start`，库通过回调向页面推标量事件。

```ts
import { nativeApi } from "@iyexin/mio-api";

const lib = await nativeApi.load("demo");
const sum = await nativeApi.call(lib.handle, "mio_add", "i32(i32,i32)", [2, 3]);

await nativeApi.onEvent(({ handle, event, a, b, c }) => {
  console.log(handle, event, a, b, c);
});
const started = await nativeApi.start(lib.handle, '{"level":"info"}');
```

| 方法 | 返回 |
|---|---|
| `nativeApi.load(name)` | `{ handle, name, abi, path, file, entry, started }` |
| `nativeApi.start(handle, config?)` | `{ handle, code, running }` |
| `nativeApi.stop(handle)` | `{ handle, stopped, reason?, timedOut? }` |
| `nativeApi.call(handle, symbol, signature, args?)` | 标量结果或 `null` |
| `nativeApi.emit(handle, event, a?, b?, c?)` | `void` |
| `nativeApi.list()` | 已加载的库 |

### 库的落点

库放在应用内容的 `native/<abi>/<name>.so`（Android）或 `native/<abi>/<name>.dll`
（Windows），`<abi>` 是 `arm64`、`x64`、`arm`、`x86` 之一。首次 `load` 时解压到应用
数据目录再加载；同一进程内重复 `load` 返回同一个 handle。

可运行的示例见
[examples/native-demo](https://github.com/iYeXin/Mio/tree/main/examples/native-demo)。

### 支持的签名

参数类型 `i32`、`i64`、`f64`、`str`，返回类型 `void`、`i32`、`i64`、`f64`。参数形状
共 13 种（`str` 只能在首位）：

```text
()
(i32)          (i32,i32)        (i32,i32,i32)
(i64)          (i64,i64)
(f64)          (f64,f64)
(str)          (str,i32)        (str,i32,i32)
(i32,f64)      (i32,f64,f64)
```

每种形状支持 4 种返回类型，例如 `i32(i32,i32)`、`f64(f64,f64)`、`void(str)`。其它签名
返回 `NATIVE_BAD_SIGNATURE`。

`str` 参数由壳分配、调用后释放，库不得保留该指针。指针、结构体和缓冲区出参不在支持
范围内；这类数据用文件或 `http` 传输。

### 主入口与事件

```c
typedef void (*mio_sink_fn)(int32_t event, int64_t a, int64_t b, double c);
int32_t mio_start(mio_sink_fn sink, const char* config);
```

- `mio_start` 在独立 isolate 中调用，阻塞不会冻结界面；5 秒内返回则得到 `code`，
  否则返回 `running: true` 并继续运行；
- `config` 是 UTF-8 只读字符串，只在调用期间有效；
- 库可以在任意线程调用 `sink`，参数只有标量；
- 同一线程内事件保序，跨线程不保证；
- `nativeApi.stop()` 调用可选的 `void mio_stop(void)`；应用退出时壳也会对已启动的库
  做一次有界的 `mio_stop`（每个 1 秒）；
- 反方向用 `nativeApi.emit()`，走可选的 `mio_event` 导出。

```c
void mio_event(int32_t event, int64_t a, int64_t b, double c);
```

## processApi（Windows）

启动外部可执行文件并读写 stdio。除 Windows 外返回 `UNSUPPORTED`。

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
| `processApi.write(id, data)` | `void`，`data` 可为 `Uint8Array` / `ArrayBuffer` / 字符串 |
| `processApi.closeStdin(id)` | `void` |
| `processApi.kill(id, signal?)` | `{ id, pid, killed }`，`signal` 为 `"term"` 或 `"kill"` |
| `processApi.list()` | `{ id, pid, executable }[]` |
| `processApi.exec({ command?, path?, args?, cwd?, env?, stdin?, timeoutMs?, maxOutputBytes? })` | `{ code, pid, stdout, stderr, durationMs, truncated }` |
| `processApi.pid()` | `{ pid }` |
| `processApi.env(names?)` | `{ env }` |
| `processApi.args()` | `{ args }` |

`exec` 的两种模式：

```ts
// 系统命令，走 cmd.exe /c
await processApi.exec({ command: "dir /b", cwd: "downloads" });

// 沙箱里的可执行文件，直接启动
await processApi.exec({ path: "sidecar/tool.exe", args: ["--json"], stdin: "\n" });
```

输出各截断到 `maxOutputBytes`（默认 1 MB），`truncated` 标记是否截断。

约定：

- 可执行文件只能位于安装目录（exe 旁）或应用数据目录 `app/`；相对路径先按安装目录
  解析，再按数据目录解析；
- 路径校验前解析 symlink，逃逸返回 `PROCESS_FORBIDDEN`；
- 不经过 shell，`args` 以数组传给 `CreateProcess`；
- `cwd` 默认是可执行文件所在目录，同样必须在允许目录内；
- `env` 与父进程环境合并；
- stdout/stderr 以 base64 分块推送，单块 ≤ 16 KB，块边界没有语义；
- 并发上限 32 个侧车进程；
- `write` 排队写入，不阻塞 RPC；
- `kill` 先发 SIGTERM，5 秒未退出再发 SIGKILL（Windows 上都是 `TerminateProcess`）；
- 关闭窗口或 `app.quit()` 会先结束所有侧车；进程被强杀时可能残留，孙进程不跟踪；
- 侧车与主进程同用户权限，应用代码必须是可信代码。

事件：

| 事件 | 数据 |
|---|---|
| `process.stdout` / `process.stderr` | `{ id, pid, bytes }`（`processApi.onStdout` 已解码） |
| `process.exit` | `{ id, pid, code, signal, executable }` |
| `process.error` | `{ id, pid, stream, message }` |

## windowApi（Windows）

| 方法 | 说明 |
|---|---|
| `windowApi.state()` | `{ supported, x, y, width, height, isMaximized, isFullScreen }` |
| `windowApi.setTitle(title)` | 设置窗口标题 |
| `windowApi.minimize()` / `maximize()` / `restore()` | 最小化 / 最大化 / 还原 |
| `windowApi.close()` | 关闭窗口 |
| `windowApi.center()` | 居中 |
| `windowApi.moveTo(x, y)` | 移动窗口 |
| `windowApi.setSize(width, height)` | 设置尺寸 |
| `windowApi.setFullScreen(bool)` | 全屏切换 |
| `windowApi.setAlwaysOnTop(bool)` | 置顶 |
| `windowApi.setDecorations(bool)` | 去掉/恢复标题栏，配合 `startDragging()` 自绘 |
| `windowApi.startDragging()` | 开始原生拖动 |
| `windowApi.setResizable(bool)` | 是否允许缩放 |
| `windowApi.setMinimumSize(width, height)` | 最小尺寸 |
| `windowApi.setVisible(bool)` | 显示/隐藏 |
| `windowApi.setMenuBarVisible(bool)` | 原生菜单栏显隐 |
| `windowApi.setHasShadow(bool)` | DWM 阴影；无边框窗口下带小圆角 |
| `windowApi.focus()` / `blur()` | 聚焦 / 失焦 |
| `windowApi.fitToWorkArea({ margin? })` | 缩进可用桌面区域 |
| `windowApi.onState(handler)` | 移动/缩放/最大化后推送 `window.state` |

Android 上 `windowApi` 返回 `supported: false`，动作调用抛 `UNSUPPORTED`。

## 返回键

Android 的返回键由应用决定，顺序是：

1. 壳发 `app.backPressed`（带 `canGoBack`），页面在 400 ms 内调用 `app.consumeBack()`
   表示已处理，壳不再做任何事；
2. 未处理时，如果当前地址不是应用入口，壳在 WebView 历史里后退；
3. 两者都不成立，壳退出应用。

框架不弹“再按一次退出”这样的提示；需要的话应用自己实现：

```ts
Mio.on("app.backPressed", () => {
  if (closeDialog()) void app.consumeBack();
});
```

## 事件

| 事件 | 数据 |
|---|---|
| `bridge.state` | `{ state: "connecting" \| "open" \| "closed" }` |
| `app.lifecycle` | `{ state: "resumed" \| "inactive" \| "paused" \| "detached" \| ... }` |
| `app.backPressed` | `{ canGoBack }` |
| `http.request` | `{ id, method, path, query, headers, remote, bodyBase64 }` |
| `http.progress` | `{ id, direction, received, total, ratio }`，约 120 ms 节流 |
| `window.state` | `{ x, y, width, height, isMaximized, isFullScreen }`（Windows） |
| `tray.click` | `{ button: "left" \| "right" }`（Windows） |
| `tray.menu` | `{ id, label }`（Windows） |
| `process.stdout` / `process.stderr` | `{ id, pid, data }`（base64 分块） |
| `process.exit` | `{ id, pid, code, signal, executable }` |
| `process.error` | `{ id, pid, stream, message }` |
| `native.loaded` | `{ handle, name, abi, path, file, entry, started }` |
| `native.event` | `{ handle, event, a, b, c }` |

事件消息格式：

```json
{ "jsonrpc": "2.0", "method": "event", "params": { "name": "app.lifecycle", "data": { "state": "paused" } } }
```

## 错误

Promise 以 `MioError` 拒绝，带 `code`、`message`、`data`。`code` 是稳定的符号码，
应用应按它分支；`rpcCode` 是 JSON-RPC 的整数码。

| code | 含义 |
|---|---|
| `METHOD_NOT_FOUND` | 未知方法 |
| `BAD_REQUEST` | 参数缺失或类型错误 |
| `UNSUPPORTED` | 当前平台不支持 |
| `FS_FORBIDDEN` | 路径越界或未授权 |
| `FS_NOT_FOUND` | 文件/目录不存在 |
| `FS_ERROR` | blob 传输失败（`data.status` 是 HTTP 状态码） |
| `PROCESS_FORBIDDEN` | 可执行文件或 cwd 位于允许目录之外 |
| `PROCESS_NOT_FOUND` | 可执行文件/目录不存在，或 id 已失效 |
| `PROCESS_START_FAILED` | 系统拒绝启动 |
| `PROCESS_STDIN_CLOSED` | stdin 已关闭 |
| `PROCESS_WRITE_FAILED` | 写 stdin 失败 |
| `PROCESS_LIMIT` | 并发侧车超过 32 |
| `PROCESS_TIMEOUT` | `processApi.exec` 超时（默认 30 秒，最大 300 秒） |
| `NATIVE_NOT_FOUND` | 内容里没有这个库 |
| `NATIVE_UNAVAILABLE` | 平台不支持，或 dev 模式没有归档 |
| `NATIVE_INVALID` | 不是动态库，或 ABI 不符 |
| `NATIVE_LOAD_FAILED` | 系统加载失败 |
| `NATIVE_SYMBOL_NOT_FOUND` | 库没有导出该符号 |
| `NATIVE_BAD_SIGNATURE` | 签名不支持，或参数类型/个数不符 |
| `NATIVE_NO_ENTRY` | 没有导出 `mio_start` |
| `NATIVE_ALREADY_STARTED` | 重复 `start()` |
| `NATIVE_NO_EVENT_HANDLER` | 没有导出 `mio_event` |
| `NATIVE_NOT_LOADED` | handle 不存在 |
| `NATIVE_CALL_FAILED` | 原生调用抛出未分类错误 |
| `NATIVE_START_FAILED` | `mio_start` 抛错 |
| `NATIVE_WORKER_LOST` | worker isolate 退出 |
| `WINDOW_ERROR` | 窗口操作失败 |
| `SHELL_ERROR` | 打开 URL / 文件 / 资源管理器失败 |
| `HTTP_BAD_URL` | 只允许 http/https |
| `HTTP_ERROR` | 请求失败（DNS、连接、写文件等） |
| `HTTP_TIMEOUT` | 请求超时 |
| `HTTP_RESPONSE_TOO_LARGE` | 响应超过 `http.request` 上限（32 MB），改用 `download` |
| `HTTP_BIND_FAILED` | 端口被占用或地址不可用 |
| `HTTP_NO_PENDING_REQUEST` | `http.respond` 的 id 不存在或已回应 |
| `HTTP_INCOMPLETE` | 传输提前结束，与 `Content-Length` 不符 |
| `HTTP_RANGE_UNSUPPORTED` | 续传请求未被服务器接受 |
| `HTTP_TLS_ERROR` | TLS 握手或证书校验失败 |
| `NOTIFY_FAILED` | 通知发送失败 |
| `MEDIA_FAILED` | 选择图片失败 |
| `SAVE_FAILED` | 写入相册失败 |
| `STORAGE_DENIED` | 没有写入共享存储的权限 |
| `STORAGE_ERROR` | 存储权限查询/申请失败 |
| `FOREGROUND_FAILED` | 前台服务启动/停止失败 |
| `TRAY_ICON_MISSING` | 托盘图标不存在 |
| `SHARE_FAILED` | 分享失败 |
| `SHARE_FILE_MISSING` | 要分享的文件不存在 |
| `FORBIDDEN` | 配置未声明该能力 |
| `MIO_TIMEOUT` | 调用超时（30 秒） |
| `MIO_DISCONNECTED` | WebSocket 断开 |

## 版本兼容

`mio-manifest.json` 声明所需的 API 版本，构建时自动写入：

```json
{ "requires": { "apiVersion": "1.0.0" } }
```

Shell 启动时校验：主版本必须相同，运行时版本必须 ≥ 要求版本。不满足时显示错误页。

## 边界

- 文本走 JSON-RPC，二进制走 blob 端点；
- 窗口尺寸和位置用逻辑像素，物理像素 = 逻辑值 × `platform.display().scaleFactor`；
- `fs` 不跟随 symlink，不提供 watch；
- blob 端点只绑定 `127.0.0.1`；
- `processApi` 只支持 Windows；
- `nativeApi` 只支持标量调用与标量事件，加载后不能卸载，原生段错误会结束整个应用；
- `nativeApi` 只在 `mio build` 的产物里可用，dev 模式没有应用归档。
