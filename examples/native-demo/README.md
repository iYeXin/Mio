# 原生库示例

最小可运行的 `nativeApi` 示例：一个 C 写的库（标量函数 + 可选入口 + 事件），和一个
直接调用它的页面。

```text
src/demo.c         库源码（导出 demo_add / demo_scale / demo_tick / demo_length /
                   mio_start / mio_event）
build-native.ps1   编译成 web/native/<abi>/demo.dll|so
web/index.html     页面：调函数、启动入口、收事件、回推事件
mio.config.json    web.outDir = "web"（所以编译产物会一起打进 asar）
```

## 跑起来

```powershell
cd examples/native-demo
./build-native.ps1                     # Windows DLL + Android .so
node ../../packages/cli/dist/bin.js build --platform windows --skip-web
./build/mio/windows/Native-Demo/Native-Demo.exe
```

Android：

```powershell
node ../../packages/cli/dist/bin.js build --platform android --abi arm64 --skip-web
adb install -r build/mio/android/Native-Demo-0.1.0.apk
```

## 约定

- 库的落点是 `native/<abi>/<name>.so|dll`，`<abi>` 取 `arm64`、`x64`、`arm`、`x86`；
  `nativeApi.load("demo")` 按当前进程的 ABI 去找 `demo`；
- 函数用固定签名字符串调用，例如 `i32(i32,i32)`、`f64(f64,f64)`、`i32(str)`，
  完整清单见 [docs/api.md](../../docs/api.md)；
- 入口符号固定为 `mio_start(mio_sink_fn sink, const char* config)`，可选；
  `sink` 的参数只有标量，壳转成 `native.event`；
- 反方向可选导出 `mio_event(int32_t, int64_t, int64_t, double)`，页面用
  `nativeApi.emit()` 调用；示例里事件 42 会被当作回声，以事件 43 推回来；
- 收尾可选导出 `void mio_stop(void)`，`nativeApi.stop()` 和退出应用时都会调用一次；
- Android 上库必须 **16KB 对齐**（脚本里已经带 `-Wl,-z,max-page-size=16384`），
  否则新设备加载会直接失败；
- 库加载后不能卸载，原生段错误会结束整个应用 —— 这是进程内加载的固有代价。

## 这个示例没有做的事

没有缓冲区、没有结构体、没有字符串返回值、没有自定义依赖。这些都在
[api.md](../../docs/api.md) 的“限制”里写清楚了：需要它们时，用文件、blob 端点，
或者退回 `processApi` 起一个进程。
