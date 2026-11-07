# 验证应用（人工跑，不入 CI）

这两个小应用的用途是**手工**验证那些自动化测试覆盖不到的东西：真实 WebView、
真实原生加载、事件桥、进程清理。结果记录在
[../../docs/mvp-acceptance.md](../../docs/mvp-acceptance.md)。

它们没有自动化：需要真机/真桌面、需要编译原生库、需要看屏幕。别把它们接进 CI。

## native/ —— `nativeApi` 的 18 项检查

覆盖：加载与 ABI 校验、6 种标量调用、错误码、`mio_start` 入口、事件桥双向
（`mio_event`）、`app.info` 能力位、`app.paths`、`app.log` + `fs.appendText`、
**worker 隔离**（400 ms 调用期间 `ping` 仍返回）、`native.stop`。

```powershell
cd tools/verification/native
./build.ps1                                   # 需要 NDK / MSVC，产物进 app/web/native/

cd app                                        # mio.config.json 在这里
node ../../../../packages/cli/dist/bin.js build --platform windows --skip-web
./build/mio/windows/Native-Demo/Native-Demo.exe
```

Android：

```powershell
node ../../../../packages/cli/dist/bin.js build --platform android --abi arm64 --skip-web
adb install -r build/mio/android/Native-Demo-0.1.0.apk
adb shell am start -n com.example.nativedemo/dev.mio.mio_shell.MainActivity
```

页面会逐项显示 PASS/FAIL，全绿说明这一轮的原生链路是通的。

## process/ —— `processApi` 的 5 项检查

覆盖：spawn + stdin/stdout + 退出码、kill、路径策略（拒绝系统目录）、缺失可执行
文件、关窗清理。需要把 `findstr.exe` 放进应用数据目录的 `sidecar/`（页面会打印它
期望的路径）。

```powershell
cd tools/verification/process/app
node ../../../../packages/cli/dist/bin.js build --platform windows --skip-web
./build/mio/windows/Sidecar-Check/Sidecar-Check.exe
```

## 为什么不在仓库里放二进制

`app/web/native/` 和 `build/` 都在 `.gitignore` 里：库要按本机工具链重编，产物不该
进版本库。页面和 C 源码在库里，足以复现。
