# @iyexin/mio-cli

Mio 应用 CLI。

```bash
npm install -D @iyexin/mio-cli
npx mio create my-app
cd my-app && npm install
npm run build:android
```

或全局安装后直接用 `mio`：

```bash
npm install -g @iyexin/mio-cli
mio create my-app
```

```text
mio create [target]
mio build [--platform android|windows] [--skip-web] [--template <path>]
mio dev --platform android|windows [--no-install] [--template <path>]
mio doctor
```

## 模板从哪里来

预编译模板不再随包分发（体积）。`mio build` / `mio dev` 按这个顺序找模板：

1. `--template <path>`，或 `mio.config.json` 的 `android.template` / `windows.templateDir`，
   或环境变量 `MIO_ANDROID_TEMPLATE` / `MIO_WINDOWS_TEMPLATE`；
2. 仓库 checkout 里的 `packages/cli/templates`（由 `scripts/build-templates.ps1` 生成）；
3. 本地缓存 `%LOCALAPPDATA%\mio\templates\<版本>\`（或 `~/.cache/mio/templates/...`）；
4. 从 GitHub Release 下载模板与 `manifest.json`，校验 sha256 后缓存。

模板的 `apiVersion` 主版本必须与 CLI 一致；单 ABI 模板还会校验 APK 里确实包含该 ABI。

下载会走 `HTTPS_PROXY` / `HTTP_PROXY`，若都没设置则回退到 `git config http.proxy`；
`NO_PROXY` 生效。下载失败会提示如何配置代理。缓存目录：
`%LOCALAPPDATA%\mio\templates\<版本>\`（Linux/macOS 为 `$XDG_CACHE_HOME/mio/...` 或
`~/.cache/mio/...`）。

## create

复制 `templates/web` 到目标目录，改写 `package.json` 的依赖为 `@iyexin/mio-api@^<版本>`、
生成应用 id 和 `.gitignore`。`create` 只写文件，不执行安装；装依赖由你自己做：

```bash
npx mio create my-app
cd my-app && npm install
```

## build

读取 `mio.config.json`，执行 `npm run build`（可用 `--skip-web`），生成 asar，
然后：

- Android：注入模板 APK、替换图标、zipalign、apksigner 重签；
- Windows：复制模板目录、PE 资源注入。

输出：

- `build/mio/android/<AppName>-<version>.apk`
- `build/mio/windows/<AppName>/`

### Android 模板与 ABI

模板按 ABI 预构建，用 `android.abi` 或 `--abi` 选择：

| abi | 体积 | 适用 |
|---|---|---|
| `arm64`（默认） | 约 19 MB | 现代真机 |
| `universal` | 约 53 MB | 32 位设备、任何模拟器 |
| `x64` | 约 20 MB | 仅模拟器（默认不随 CLI 分发） |

```bash
mio build --platform android --abi universal
```

`mio dev` 始终优先用 universal 模板，因为开发机常连模拟器。

调试构建自动使用 `.mio/debug.p12`。发布构建通过配置：

```json
{
  "android": {
    "keystore": "release.p12",
    "alias": "release",
    "storePasswordEnv": "MIO_KS_PASS",
    "keyPasswordEnv": "MIO_KEY_PASS"
  }
}
```

## dev

启动 Vite（自动选择空闲端口），然后：

- Windows：启动模板 exe，设置 `MIO_DEV_URL` 与 app 元信息 env；
- Android：`adb reverse`、安装模板 APK、用 intent extra 启动。

## doctor

检查 Node、Android tools、adb、模板路径。

## Windows 签名

```json
{
  "windows": {
    "signCommand": "signtool sign /fd SHA256 /a {exe}"
  }
}
```

`{exe}` 会替换为最终 exe 路径；命令在项目目录执行。也可以接 `signtool` 或云签名 CLI。
