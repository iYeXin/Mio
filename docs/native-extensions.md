# 原生库

应用可以带上自己的 `.so` / `.dll`，在需要时加载。适合把计算、编解码、协议解析这类
工作放到 C、C++ 或 Rust 里，界面和业务逻辑仍然留在 Web 层。

## 放置库文件

库放在应用内容的 `native/<abi>/` 下，按构建目标选择目录：

```text
dist/
  native/
    arm64-v8a/libdemo.so     # Android arm64
    x86_64/libdemo.so        # Android x64（模拟器）
    x64/demo.dll             # Windows
```

`<abi>` 用运行时的架构名，`<name>` 是加载时传入的名字，扩展名由平台决定。

## 加载与调用

```ts
import { nativeApi } from "@iyexin/mio-api";

const lib = await nativeApi.load("demo");
// 只调函数：签名是固定的标量组合
const sum = await nativeApi.call(lib.handle, "mio_add", "i32(i32,i32)", [2, 3]);

// 或者启动库的主入口，让它自己起线程、自己推事件
await nativeApi.start(lib.handle, JSON.stringify({ interval: 250 }));
await nativeApi.emit(lib.handle, "tick", 42);
await nativeApi.stop(lib.handle);
```

`load` 会校验库文件头与 ABI，不匹配直接报错，不会出现“加载了但一调用就崩”。

## 支持的签名

参数类型：`i32`、`i64`、`f64`、`str`；返回类型：`void`、`i32`、`i64`、`f64`。
按参数与返回的组合写成 `ret(args)`，例如 `i32(i32,i32)`、`void()`、`f64(str)`。
完整清单见 [API v1](/api#支持的签名)。

字符串参数以 UTF-8 传入，只在该次调用内有效。

## 主入口

`start` 会调用库导出的 `mio_start(sink, config)`：

```c
typedef void (*mio_sink)(const char *event, int32_t a, double b, double c);
int32_t mio_start(mio_sink sink, const char *config);  // 返回 0 表示就绪
void mio_event(const char *event, int32_t a, double b, double c); // 可选
void mio_stop(void); // 可选，退出时调用一次
```

`sink` 把事件推回页面，页面用 `nativeApi.onEvent` 接收。`config` 是 `start` 传入的
字符串。事件只传标量；字符串和二进制仍走文件或 socket。

## 运行时表现

- 每个库有一个常驻的执行上下文，`call` 依次执行，不会阻塞界面；
- 一个耗时 400 ms 的导出函数执行时，桥仍然能响应 ping（约 2 ms）；
- 库加载后会一直驻留到应用退出，不支持热替换；
- 原生代码的崩溃会结束整个应用，请把重活放在独立进程里（Windows 上可用
  `processApi`）。

`mio dev` 不加载原生库：开发模式没有应用归档，`nativeApi` 会返回
`NATIVE_UNAVAILABLE`，用 `mio build` 的产物验证。
