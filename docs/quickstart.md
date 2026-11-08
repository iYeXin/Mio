# 开始使用

Mio 是一个轻量的跨平台开发框架。用 Web 技术写界面和逻辑，用 `@iyexin/mio-api`
调用设备能力，构建出可安装的 Android 与 Windows 应用。

## 环境

- Node.js 22.12+
- 构建 Android 与 Windows 应用不需要 Android Studio、Visual Studio 或 Flutter
- Android 签名需要的 Java 与签名/对齐工具，缺失时由 CLI 自动下载
- 只有想自己重建运行时模板时，才需要 Flutter 和对应的原生工具链

## 安装 CLI

```bash
npm install -D @iyexin/mio-cli
```

之后命令统一用 `npx mio`。也可以全局安装（`npm install -g @iyexin/mio-cli`），
直接用 `mio`。

## 创建项目

```bash
npx mio create my-app
cd my-app
npm install
```

生成的是一个 Vite + TypeScript 项目，依赖 `@iyexin/mio-api`，并提供这些脚本：

| 脚本 | 作用 |
|---|---|
| `npm run dev` | 开发模式，Windows 窗口 |
| `npm run dev:android` | 开发模式，Android 设备/模拟器 |
| `npm run build:windows` | 构建 Windows 产物 |
| `npm run build:android` | 构建 Android APK |
| `npm run build` | 只构建 Web 资源（`vite build`） |

## 已有项目

在项目根目录执行 `init`，只补缺失的部分。已有的 `package.json` 字段、脚本和依赖
保持原样，`mio.config.json` 已存在时不动，重复执行不会重复初始化：

```bash
npx mio init
```

`mio create` 指向非空目录时也是这个行为：在原目录上初始化，不覆盖文件。

## 升级

```bash
npx mio upgrade        # 升到当前 CLI 的版本
npx mio upgrade 0.2.0  # 指定版本
```

只改项目里 `@iyexin/mio-*` 的版本范围，然后运行 `npm install`。

## 开发

```bash
npm run dev
npm run dev:android
```

命令启动 Vite，并把开发服务器接到 Mio 运行时上：改代码即时生效，桥、事件和原生能力
与打包后一致。等价写法是 `npx mio dev --platform windows`。

## 构建

```bash
npm run build:windows
npm run build:android
```

需要指定 ABI 时：

```bash
npx mio build --platform android --abi arm64
```

产物：

```text
build/mio/windows/My-App/
build/mio/android/My-App-1.0.0.apk
```

Android 运行时按 ABI 选择：`arm64`（默认，约 19 MB）、`universal`（约 54 MB，覆盖
32 位设备与模拟器）、`x64`（约 20 MB，模拟器）。

### Android App Bundle（Play）

```bash
npx mio build --platform android --format aab
```

产物是 `build/mio/android/<AppName>-<version>.aab`，用于 Google Play 上传。AAB 需要
配置发布证书（`android.keystore` / `alias` / `storePasswordEnv`），会自动使用
universal 模板，由 Play 按 ABI 拆分。首次构建会额外下载 `aapt2` 与 `bundletool`
（约 37 MB），可以提前用 `mio tools install --format aab` 拉好。

本地验证 AAB 需要先拆成 APK：

```bash
bundletool build-apks --bundle=build/mio/android/App-1.0.0.aab --output=app.apks --mode=universal
```

## 下一步

- [配置](/configuration) —— 应用、窗口、构建与签名的全部字段
- [API](/api) —— 命名空间、事件、错误码
- [原生库](/native-extensions) —— 加载自己的 `.so` / `.dll`
- [签名](/signing) —— 发布前的 Android 与 Windows 签名
