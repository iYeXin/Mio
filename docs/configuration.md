# 配置

一个项目只有一个配置文件：项目根目录的 `mio.config.json`。

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
    "title": "Notes",
    "minWidth": 720,
    "minHeight": 480,
    "center": true,
    "resizable": true,
    "decorations": true,
    "alwaysOnTop": false
  },
  "web": {
    "outDir": "dist",
    "buildCommand": "npm run build",
    "devCommand": "npm run dev"
  },
  "android": {
    "abi": "arm64",
    "minSdk": 24,
    "pageSize": 16,
    "keystore": "release.p12",
    "alias": "release",
    "storePasswordEnv": "MIO_KS_PASS",
    "keyPasswordEnv": "MIO_KEY_PASS"
  },
  "windows": {
    "exe": "Notes.exe",
    "signCommand": "signtool sign /fd sha256 /f cert.pfx {exe}"
  }
}
```

## app

| 字段 | 说明 |
|---|---|
| `id` | Android 应用 ID / Windows 标识，形如 `dev.example.notes` |
| `name` | 显示名称 |
| `version` | 版本号，写进 APK 与 Windows 文件属性 |
| `icon` | 图标源文件（PNG，建议 1024×1024） |

## window

用于 Android 之外的桌面窗口。所有字段在启动时应用，不会出现先显示再调整的跳变。

| 字段 | 默认 | 说明 |
|---|---|---|
| `width` / `height` | 1024 / 720 | 初始尺寸（逻辑像素） |
| `title` | 应用名称 | 窗口标题（优先于 `app.name`） |
| `x` / `y` | 居中 | 初始位置 |
| `center` | `true` | 是否居中 |
| `minWidth` / `minHeight` | — | 最小尺寸 |
| `resizable` | `true` | 是否允许缩放 |
| `decorations` | `true` | 设为 `false` 得到无边框窗口，可自绘标题栏 |
| `alwaysOnTop` | `false` | 置顶 |

运行时的调整（尺寸、位置、可见性、阴影、拖动等）仍然通过 `windowApi` 完成。

## web

| 字段 | 默认 | 说明 |
|---|---|---|
| `outDir` | `dist` | 构建产物目录 |
| `buildCommand` | `npm run build` | 构建命令 |
| `devCommand` | `npm run dev` | `mio dev` 启动的命令 |
| `devUrl` | 自动探测 | 开发服务器地址 |

## android

| 字段 | 默认 | 说明 |
|---|---|---|
| `abi` | `arm64` | `arm64` / `universal` / `x64` |
| `minSdk` | 24 | 最低系统版本 |
| `pageSize` | 16 | 对齐页大小（4 或 16 KB） |
| `keystore` | — | 签名证书；省略时使用调试证书 |
| `alias` | — | 证书别名 |
| `storePasswordEnv` | — | 存库密码所在的环境变量名 |
| `keyPasswordEnv` | — | 密钥密码所在的环境变量名 |
| `foregroundService` | `false` | 允许使用前台服务 |

密码只通过环境变量传入，不会出现在配置文件或命令行里。

## windows

| 字段 | 默认 | 说明 |
|---|---|---|
| `exe` | 应用名称 | **输出**可执行文件名，如 `Notes.exe`；模板里的 exe 会自动找到并改名 |
| `signCommand` | — | 签名命令，`{exe}` 会替换为产物路径 |

## devtools

| 字段 | 默认 | 说明 |
|---|---|---|
| `devtools` | `mio dev` 开启、构建产物关闭 | 是否允许打开 WebView DevTools（Windows 右键菜单里的“检查”，Android 的 `chrome://inspect`） |

```json
{ "devtools": true }
```

未设置时跟随运行模式：开发服务器里开启，打包产物里关闭。开启后启动日志会写出屏幕
几何信息（`platform.display()`），打包后的页面 `console.*` 和未捕获异常也会转发到
`logs/mio.log`。

## Android 工具链

Android 构建需要 Java 与 Android 的签名/对齐工具。Mio 按这个顺序找：

1. `MIO_ANDROID_TOOLS_DIR` 指向的工具包（`apksigner.jar`、`zipalign`、可选 `jre/`）；
2. Android SDK build-tools（`ANDROID_HOME` / `ANDROID_SDK_ROOT` / 默认安装位置）；
3. 以上都没有时，自动下载缺的部分。

自动下载只取缺的组件：本机有 Java 时只下工具（约 1.4 MB），有 build-tools 时只下
Java 运行时（约 18 MB），都没有则两份都下，合计约 19 MB。下载会校验 sha256，缓存到
`~/.mio/tools/android/<清单版本>/<平台>/`，之后离线可用。

| 变量 | 作用 |
|---|---|
| `MIO_ANDROID_TOOLS_DIR` | 直接指定工具包目录，优先级最高 |
| `MIO_JAVA_HOME` / `JAVA_HOME` | 使用已有的 Java |
| `MIO_TOOLS_CACHE_DIR` | 工具包缓存位置 |
| `MIO_TOOLS_MANIFEST_URL` | 指定工具包清单（镜像或离线包） |
| `MIO_NO_TOOL_DOWNLOAD=1` | 禁止自动下载，缺工具时直接报错 |
| `MIO_TOOLS_FORCE_DOWNLOAD=1` | 强制重新下载（修复损坏的缓存） |

下载遵循 `HTTPS_PROXY` / `HTTP_PROXY`。

## 生成签名证书

工具包里带 `keytool`，没有 JDK 的机器也能生成自己的签名证书：

```bash
export MIO_KS_PASS='<password>'          # PowerShell: $env:MIO_KS_PASS = "<password>"
npx @iyexin/mio-cli keystore --out .mio/release.p12 --alias release \
  --dname "CN=Your Name, O=Your Org, C=CN"
```

命令会打印一段可以直接粘进 `mio.config.json` 的配置。密码只从环境变量读取，
通过 `keytool -storepass:env` 传入，不会出现在命令行参数里。已有同名文件时加
`--force` 覆盖。

`--days` 控制有效期（默认 10000 天），`--password-env` 可以换一个环境变量名。

## 命令行覆盖

```bash
mio build --platform android --abi universal
mio build --template ./my-runtime.apk
mio dev --platform windows --no-install
```

`--template` 用于指定自己的运行时；不指定时按需要下载官方版本并校验。
