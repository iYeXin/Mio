# 开始使用

Mio 是一个轻量的跨平台开发框架。你用熟悉的 Web 技术写界面和逻辑，用
`@iyexin/mio-api` 调用设备能力，构建出可安装、可发布的 Android 与 Windows 应用。

## 环境

- Node.js 22.12+
- 构建 Android 应用不需要 Android Studio；构建 Windows 应用不需要 Visual Studio
- Android 签名需要 Java 与 Android 的签名/对齐工具；机器上没有时，首次构建会自动下载（约 19 MB），已有的部分会跳过
- 只有想自己重新构建运行时（模板）时，才需要 Flutter 与对应的原生工具链

## 安装 CLI

在你想放项目的目录里安装 CLI，后续命令统一用 `npx mio`：

```bash
npm install -D @iyexin/mio-cli
```

也可以全局安装（`npm install -g @iyexin/mio-cli`），之后直接用 `mio`。

## 创建项目

```bash
npx mio create my-app
cd my-app
npm install
```

`create` 会把 `@iyexin/mio-cli` 写进新项目的 devDependencies，并生成常用的 npm
脚本，所以进入项目后 `npm run dev`、`npx mio build` 都能直接使用。

生成的是一个普通的 Vite + TypeScript 项目，唯一的 Mio 依赖是 `@iyexin/mio-api`。
可以像普通前端项目一样组织代码、加依赖、跑测试。

## 已有项目

在现有项目根目录执行 `init`，只补缺失的部分：已有的 `package.json` 字段、脚本和依赖
都保留，`mio.config.json` 已存在时原样保留，重复执行不会重复初始化：

```bash
npx mio init
```

`mio create` 指向一个非空目录时，也是这个行为——在原目录上初始化，而不是覆盖。

## 升级

```bash
npx mio upgrade        # 升到当前 CLI 的版本
npx mio upgrade 0.2.0  # 或指定版本
```

只改 `@iyexin/mio-*` 的版本范围，其它依赖不动；之后运行 `npm install`。

## 开发

```bash
npm run dev            # Windows
npm run dev:android    # Android
```

等价写法是 `npx mio dev --platform windows`。

命令会启动 Vite，并把开发服务器接到 Mio 运行时上：改代码即时生效，桥、事件和原生能力
与打包后一致。

## 构建

```bash
npm run build:windows
npm run build:android
```

需要指定 ABI 时用 `npx mio build --platform android --abi arm64`。

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
