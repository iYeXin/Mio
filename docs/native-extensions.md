# 原生能力

> 决策日期：2026-11-06（2026-11-07 修订）  
> 结论：**Mio 不做原生插件机制**，提供两层极简的原生能力：起进程（`processApi`，
> Windows）与进程内加载自己的库（`nativeApi`，Android + Windows，标量调用 + 标量事件）。

## 1. 两层能力

- `processApi`：Windows 上把子进程当作侧车，读写它的 stdio；
- `nativeApi`：把 `.so` / `.dll` 解到磁盘，壳加载后调用导出函数，双向传标量事件。

两层都不引入插件清单、注册表、结构体 ABI 或版本协商。协议、线程、内存和失败恢复由
应用自己负责。

## 2. 明确不做

Mio **不提供**以下能力，且不打算在可预见的未来提供：

- Flutter plugin 动态加载（`pubspec` 依赖 + 编译期注册）；
- **插件 ABI**：没有插件清单、没有结构体/虚表、没有注册表、没有插件生命周期与版本协商；
- Java/Kotlin 插件桥（DEX 动态加载、SDK 接入）；
- Android SDK / Android 原生 API 接入；
- 插件市场、插件沙箱、第三方插件权限模型；
- 插件原生 UI（camera preview、原生地图、原生 View/Texture）；
- 为“大型/深度”应用补齐原生能力。

“不做插件”不等于“不能碰原生”。Mio 允许应用带**自己的** C/C++/Rust 代码，但只提供
最薄的一层：加载一个库、调用固定名字的入口、用一小撮标量签名调函数、把标量事件推回
页面。剩下的协议、线程、内存、失败恢复都由应用负责（见 §4）。

这些“不做”不是“以后有空再做”，而是与 Mio 的模板模型、体积目标和安全模型冲突。

## 3. 为什么不做插件

### 3.1 模板是预编译的 Flutter AOT 壳

Mio 的壳在发布前编译一次，应用只是注入 `app.asar`。Flutter plugin 依赖：

- pubspec 依赖解析；
- generated plugin registrant；
- 编译期资源合并；
- Dart AOT 代码。

这些都无法在应用构建时动态加入。要支持 Flutter plugin，只能每个应用重新编译模板，
那就不再是 Mio。

### 3.2 插件 AB​I 会拖进平台工程

正因为模板是预编译的，任何“可调用形状”都必须在模板里存在。要做通用插件 ABI，就得有
注册表、结构体、生命周期、版本兼容、跨语言类型映射 —— 这是一整套平台工程，维护成本
远大于 Mio 想承担的范围。所以 Mio 只保留一个入口符号和一组固定标量签名，把复杂度留给
应用。

### 3.3 安全与信任边界

Mio 的应用内容是**可信代码**：XSS 等价于原生权限。进程内加载自己的库不会改变这个
前提 —— 页面本来就能写文件、起进程，现在也能加载库。Mio 不做的是“来自独立供应链的
第三方插件”那套签名/隔离/权限/审核。

## 4. 唯一的方向：自己起进程

如果应用确实需要 C/C++/Rust 能力，Mio 的方向不是“插件”，而是：

> **应用自己拉起一个新进程，自己定义协议，自己处理通信。**

Mio 只负责提供进程启动/stdio 这一层基础 API，不提供插件协议、不提供插件加载器、
不提供插件生命周期管理。

### 4.1 `processApi`（Windows only，已实现）

> 状态：**已实现**（API v1.0.0）。这是 Mio 唯一与原生代码相关的能力：启动进程 +
> 搬运 stdio，没有插件协议、没有加载器、没有生命周期管理。

```ts
import { processApi } from "@iyexin/mio-api";

const child = await processApi.spawn({
  path: "sidecar/helper.exe",   // 安装目录或应用数据目录内的相对/绝对路径
  args: ["--port", "0"],        // 数组传参，不经过 shell
  cwd: "sidecar",               // 可选，默认是可执行文件所在目录
  env: { MIO_SIDECAR: "1" },    // 与父进程环境合并
});

await processApi.write(child.id, new TextEncoder().encode("ping\n"));
await processApi.closeStdin(child.id);

await processApi.onStdout(({ id, bytes }) => {
  if (id === child.id) console.log(new TextDecoder().decode(bytes));
});
await processApi.onExit(({ id, code }) => console.log(id, "exit", code));
```

约定：

- 只允许 Windows，其他平台返回 `UNSUPPORTED`；
- 可执行文件必须位于**安装目录**（exe 旁）或**应用数据目录** `app/`；路径会先解析
  symlink 再做归属校验，逃逸被 `PROCESS_FORBIDDEN` 拒绝；
- 不经 shell，参数以数组传递；
- `cwd` 默认是可执行文件所在目录，同样受 allowlist 限制；
- stdin/stdout/stderr 以 base64 分块传输，单块 ≤ 16 KB，块边界没有语义；
- 并发上限 32 个；写 stdin 是排队写入，不会阻塞 RPC；
- 通信协议（JSON、protobuf、自定义帧）由应用自己定义；
- 子进程与应用同用户权限，应用代码必须可信 —— 页面里能写文件，就能放一个新的
  exe 进应用数据目录并运行它；
- 关闭窗口或 `app.quit()` 会先结束侧车再退出；进程崩溃时可能残留，且**不跟踪孙进程**。

这也解释了为什么 sidecar 不是插件系统：Mio 只提供“起进程 + 通管道”，协议、版本、
生命周期、失败恢复全部留在应用侧。需要 Mio 管理这些，就说明需求已经超出 Mio 的定位。

### 4.2 Android 没有“起进程”这条路

Android 不允许应用可靠地 `fork/exec` 任意 sidecar 二进制；从应用数据目录执行 ELF 会
受 SELinux/系统策略限制。Mio 不会为 Android 提供“拉起任意进程”的能力。

因此：

- Android SDK / Java/Kotlin 能力：没有支持路径；
- Android C/C++ sidecar：没有支持路径；
- Android 的原生能力只有进程内加载（4.3）这一条路。

### 4.3 进程内加载动态库（已实现：`nativeApi`）

与“起进程”并列的另一条路：把 `.so` / `.dll` 解到磁盘，壳 `dlopen` 后使用。它同样不是
插件机制：没有注册表、没有结构体 ABI、没有生命周期管理、没有版本协商。提供两种用法：

1. **只调函数**：一组固定的标量签名（`i32`/`i64`/`f64`/`str` 参数，`void`/`i32`/`i64`/`f64`
   返回），够基础场景用，不需要写入口、不需要协议；
2. **跑主入口**：可选的 `mio_start(sink, config)`，库自己起线程、自己定协议，通过 `sink`
   推标量事件回页面（`native.event`）。

实现要点：

- 库放在应用内容的 `native/<abi>/<name>.so|dll`，首次加载时解到应用数据目录（流式写出，
  不把整库读进内存），并用“归档 mtime + 条目偏移/长度”作为缓存键；
- **每个库一个常驻 worker isolate**：`call` / `emit` 都在那里串行执行，UI 线程只等结果。
  一个 400 ms 的导出调用不会卡住界面，也不会阻塞同一时间的其他桥请求（服务端按请求
  并发处理）；同一次加载内的调用天然串行，不需要库自己加锁；
- 加载前校验 ELF/PE 头与机器类型，ABI 不符直接报错；
- `mio_start` 在独立 isolate 里调用，阻塞也不会冻结界面；
- 事件桥是双向的、都只传标量：native → JS 走 `sink`（`native.event`），JS → native 走
  可选的 `mio_event`（`nativeApi.emit`）。字符串/二进制仍走文件或 socket —— 这是刻意
  的边界；
- 收尾用可选的 `mio_stop`（`nativeApi.stop`，退出时也会调用一次），但库不能真正卸载。

实测结论：

- Windows：数据目录、安装目录都可加载，入口符号可解析；
- Android：应用数据目录的**绝对路径可以 `dlopen`**（“namespace 会挡住”的说法对绝对
  路径不成立），16 KB 模拟器上也成立；
- 三个硬约束：库必须 **16 KB 对齐**、自定义依赖必须**按顺序先加载**、ABI 必须匹配；
- 代价是**故障边界消失**：原生段错误会带走整个应用，这方面进程内不如 sidecar 可靠；
- Dart 的 `DynamicLibrary` 没有卸载 API，库常驻到进程退出，不能热替换。

API 与支持的签名见 [api.md](api.md)；这部分能力不会长成插件系统。

## 5. 边界

- 一个 WebView、一层 JSON 桥、按需加载的标量接口；
- 原生段错误会带走整个应用，进程内的隔离只到 isolate；
- Dart 的 `DynamicLibrary` 没有卸载 API，库常驻到进程退出；
- Android 侧只有进程内加载，没有 Java/Kotlin 或 sidecar 路径。

需要完整的原生 SDK、插件生态或长期平台兼容时，用原生或 Flutter 更直接。