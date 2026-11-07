# 开始使用

Mio 是一个轻量的跨平台开发框架。你用熟悉的 Web 技术写界面和逻辑，用
`@iyexin/mio-api` 调用设备能力，构建出可安装、可发布的 Android 与 Windows 应用。

## 环境

- Node.js 22.12+
- 构建 Android 应用不需要 Android Studio；构建 Windows 应用不需要 Visual Studio
- Android 签名需要 Java 与 Android 的签名/对齐工具；机器上没有时，首次构建会自动下载（约 19 MB），已有的部分会跳过
- 只有想自己重新构建运行时（模板）时，才需要 Flutter 与对应的原生工具链

## 创建项目

```bash
npx @iyexin/mio-cli create my-app
cd my-app
npm install
```

生成的是一个普通的 Vite + TypeScript 项目，唯一的 Mio 依赖是 `@iyexin/mio-api`。
可以像普通前端项目一样组织代码、加依赖、跑测试。

## 开发

```bash
npx @iyexin/mio-cli dev --platform windows
npx @iyexin/mio-cli dev --platform android
```

命令会启动 Vite，并把开发服务器接到 Mio 运行时上：改代码即时生效，桥、事件和原生能力
与打包后一致。

## 构建

```bash
npx @iyexin/mio-cli build --platform windows
npx @iyexin/mio-cli build --platform android --abi arm64
```

产物：

```text
build/mio/windows/My-App/
build/mio/android/My-App-1.0.0.apk
```

Android 可以按 ABI 选择运行时：`arm64`（默认，约 19 MB）、`universal`（约 54 MB，
覆盖 32 位设备与模拟器）、`x64`（约 20 MB，模拟器）。

## 项目配置

`mio.config.json` 描述应用本身：

```json
{
  "app": {
    "id": "dev.example.notes",
    "name": "Notes",
    "version": "1.0.0",
    "icon": "icon.png"
  },
  "window": {
    "width": 1100,
    "height": 780,
    "minWidth": 720,
    "minHeight": 480,
    "center": true
  },
  "web": { "outDir": "dist" },
  "android": { "abi": "arm64", "minSdk": 24 },
  "windows": { "signCommand": "signtool sign /fd sha256 /f cert.pfx {exe}" }
}
```

窗口的初始状态在启动时生效，不会先显示再跳变；运行中可以继续用 `windowApi` 调整。
字段细节见 [配置](/configuration)。

## 下一步

- [配置](/configuration) —— 应用、窗口、构建与签名的全部字段
- [API v1](/api) —— 命名空间、事件、错误码
- [原生库](/native-extensions) —— 加载自己的 .so / .dll
- [签名](/signing) —— 发布前的 Android 与 Windows 签名
