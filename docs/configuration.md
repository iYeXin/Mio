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
| `width` / `height` | 1024 / 720 | 初始尺寸 |
| `title` | 应用名称 | 窗口标题 |
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
| `exe` | 自动探测 | 主程序文件名 |
| `signCommand` | — | 签名命令，`{exe}` 会替换为产物路径 |

## 命令行覆盖

```bash
mio build --platform android --abi universal
mio build --template ./my-runtime.apk
mio dev --platform windows --no-install
```

`--template` 用于指定自己的运行时；不指定时按需要下载官方版本并校验。
