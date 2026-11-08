# 配置

项目根目录的 `mio.config.json` 是唯一的配置文件。

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
| `version` | 版本号，写入 APK 与 Windows 文件属性 |
| `icon` | 图标源文件（PNG，建议 1024×1024） |

## window

桌面窗口的初始状态，启动时应用。运行时调整用 `windowApi`。

| 字段 | 默认 | 说明 |
|---|---|---|
| `width` / `height` | 1024 / 720 | 初始尺寸（逻辑像素） |
| `title` | 应用名称 | 窗口标题，优先于 `app.name` |
| `x` / `y` | 居中 | 初始位置 |
| `center` | `true` | 是否居中 |
| `minWidth` / `minHeight` | — | 最小尺寸 |
| `resizable` | `true` | 是否允许缩放 |
| `decorations` | `true` | `false` 得到无边框窗口，可自绘标题栏 |
| `alwaysOnTop` | `false` | 置顶 |

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
| `storePasswordEnv` | — | 存库密码所在的环境变量 |
| `keyPasswordEnv` | — | 密钥密码所在的环境变量 |
| `foregroundService` | `false` | 允许使用前台服务 |

签名密码只通过环境变量读取，不写入配置或命令行参数。

`--format aab` 会忽略 `abi`，固定使用 universal 模板；Play 负责按 ABI 拆分下发。

## windows

| 字段 | 默认 | 说明 |
|---|---|---|
| `exe` | 应用名称 | 输出可执行文件名，如 `Notes.exe`；模板里的 exe 会自动找到并改名 |
| `signCommand` | — | 签名命令，`{exe}` 替换为产物绝对路径 |

## devtools

| 字段 | 默认 | 说明 |
|---|---|---|
| `devtools` | 开发模式开启，构建产物关闭 | 是否允许打开 WebView DevTools（Windows 右键菜单的“检查”，Android 的 `chrome://inspect`） |

```json
{ "devtools": true }
```

开启后启动日志会记录一次屏幕几何信息；页面里的 `console.*`、未捕获异常也会写入
`logs/mio.log`。

## Android 工具链

构建 Android 需要 Java 与 Android 的签名/对齐工具。查找顺序：

1. `MIO_ANDROID_TOOLS_DIR` 指向的工具包（`apksigner.jar`、`zipalign`、可选 `jre/`）；
2. Android SDK build-tools（`ANDROID_HOME` / `ANDROID_SDK_ROOT` / 默认安装位置）；
3. 都没有时自动下载缺的部分。

只下载缺的组件：有 Java 就只下工具（约 1.4 MB），有 build-tools 就只下 Java 运行时
（约 18 MB），都没有则约 19 MB。AAB 额外需要 `bundle` 组件（`aapt2` +
`bundletool`，约 37 MB），只在 `--format aab` 时下载。下载校验 sha256，缓存在
`~/.mio/tools/android/<清单版本>/<平台>/`，之后离线可用。

想提前准备（例如 CI 预热），用：

```bash
mio tools                          # 查看各部分是否就绪
mio tools install                  # APK 构建所需：工具 + JRE + 模板
mio tools install --format aab     # 额外拉 aapt2 + bundletool
mio tools install --platform all   # Android 与 Windows 模板都拉
```

| 变量 | 作用 |
|---|---|
| `MIO_ANDROID_TOOLS_DIR` | 指定工具包目录，优先级最高 |
| `MIO_JAVA_HOME` / `JAVA_HOME` | 使用已有的 Java |
| `MIO_TOOLS_CACHE_DIR` | 工具包缓存位置 |
| `MIO_TOOLS_MANIFEST_URL` | 指定工具包清单（镜像或离线包） |
| `MIO_NO_TOOL_DOWNLOAD=1` | 禁止自动下载，缺工具时直接报错 |
| `MIO_TOOLS_FORCE_DOWNLOAD=1` | 强制重新下载，修复损坏的缓存 |

下载遵循 `HTTPS_PROXY` / `HTTP_PROXY`，没有环境变量时回退到 `git config http.proxy`。

## 生成签名证书

工具包里带 `keytool`，没有 JDK 的机器也能生成证书：

```bash
export MIO_KS_PASS='<password>'          # PowerShell: $env:MIO_KS_PASS = "<password>"
npx mio keystore --out .mio/release.p12 --alias release \
  --dname "CN=Your Name, O=Your Org, C=CN"
```

命令会打印可直接粘进 `mio.config.json` 的配置。密码通过 `keytool -storepass:env`
传入，不出现在命令行参数里。同名文件存在时加 `--force` 覆盖；`--days` 控制有效期
（默认 10000 天），`--password-env` 可换环境变量名。

## 命令行覆盖

```bash
mio build --platform android --abi universal
mio build --template ./my-runtime.apk
mio dev --platform windows --no-install
```

`--template` 指定自己的运行时；不指定时按需下载官方版本并校验。
