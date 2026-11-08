# 签名与发布

Android 与 Windows 的签名机制完全不同，Mio 分别处理。

## Android

### 构建顺序

```text
修改 APK → zipalign → apksigner sign → apksigner verify → 产物
```

`apksigner` 不负责对齐，`zipalign` 不能省。工具缺失时按
[工具链](/configuration#android-工具链)自动下载。

### 调试签名

不配置 `android.keystore` 时，CLI 自动创建并复用：

```text
<project>/.mio/debug.p12
alias: mio-debug
password: android
```

只用于本地调试（`.gitignore` 已排除）。发布用你自己的证书。

### 发布签名

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

```bash
export MIO_KS_PASS=...
export MIO_KEY_PASS=...
mio build --platform android
```

密码只从环境变量读取，不写入配置或命令行参数。密钥丢失后无法更新已发布应用，
请自行备份；keystore 建议用 PKCS#12。

### 生成证书

没有现成证书时，用自带的 `keytool` 生成：

```bash
MIO_KS_PASS=<password> mio keystore --out .mio/release.p12 --alias release --dname "CN=Your Name"
```

详见[配置](/configuration#生成签名证书)。

### Android App Bundle

上传 Play 的 `.aab` 用**上传密钥**签名，Google 再用 Play App Signing 重签下发的 APK：

```bash
npx mio build --platform android --format aab
```

- AAB 用 `jarsigner` 签名（`apksigner` 只支持 APK），CLI 会自动执行并校验；
- 密码仍然只从环境变量读取；
- 首次上传前需要在 Play Console 启用 Play App Signing，并保管好上传密钥；
- 本地不能直接安装 AAB，先 `bundletool build-apks` 拆成 APK。

### 校验

```bash
apksigner verify --verbose --print-certs build/mio/android/App.apk
```

CLI 签名后会自动 verify，不通过不会产出最终文件。

### 16 KB 对齐

```bash
zipalign -c -v -P 16 4 build/mio/android/App.apk
```

`pageSize: 16` 是默认值。16 KB 页大小的设备要求 native 库按 16 KB 对齐；对齐在签名
前完成，构建后校验一次。

## Windows

### 签名顺序

注入资源会改变 exe，必须在注入之后签名。CLI 的顺序：

```text
复制模板 → 注入 asar → 注入图标/版本信息 → 重命名 exe → signCommand
```

模板 exe 原有的签名会被覆盖，最终以 `signCommand` 的结果为准。

### 配置

```json
{
  "windows": {
    "signCommand": "signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a \"{exe}\""
  }
}
```

`{exe}` 替换为最终 exe 的绝对路径，命令在项目目录执行。

用证书文件时：

```json
{
  "windows": {
    "signCommand": "signtool sign /fd SHA256 /f cert.pfx /p %CERT_PASSWORD% /tr http://timestamp.digicert.com /td SHA256 \"{exe}\""
  }
}
```

- 密码通过环境变量传入，配置里只写变量名；
- `.pfx` 不进仓库；
- 时间戳服务保证证书过期后签名仍然有效。

`signtool.exe` 随 Windows SDK 安装，通常位于
`C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\signtool.exe`；不在 PATH
时在 `signCommand` 里写绝对路径。


### 校验

```bash
signtool verify /pa /v build/mio/windows/App/App.exe
```

未配置 `signCommand` 时产物是未签名 exe，只适合本地测试。

## 发布产物

```text
build/mio/android/<AppName>-<version>.apk
build/mio/windows/<AppName>/<AppName>.exe  (+ dll, data/)
```

Android 产物是单文件 APK。Windows 产物是目录，需要整体分发（压缩包或安装器），
exe 依赖 `flutter_windows.dll`、`data/`、`WebView2Loader.dll` 等。

## CI

- 把 keystore / 证书放进 secret 管理（GitHub Secrets、Vault、KMS）；
- 构建时写入临时文件，结束后删除；
- 优先用云 KMS 签名，避免私钥落地；
- 在 CI 中执行 `apksigner verify` 和 `signtool verify` 作为门禁。

仓库的 CI 不包含签名，签名属于发布流水线。
