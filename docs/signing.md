# 签名与发布

Mio 需要同时处理 Android APK 和 Windows exe 的签名。两者机制完全不同。

## 1. Android

### 1.1 为什么必须签名

Android 在安装时强制校验签名，未签名 APK 无法安装。targetSdk 30+ 只带 v1 签名的
APK 在 Android 11+ 也无法安装，所以现代 APK 至少需要 APK Signature Scheme v2。

Mio 使用 AOSP `apksigner`，并固定顺序：

```text
修改 APK → zipalign → apksigner sign → apksigner verify → 发布产物
```

`apksigner` 不负责对齐，`zipalign` 不能省。

### 1.2 调试签名

不配置 `android.keystore` 时，CLI 会自动创建并复用：

```text
<project>/.mio/debug.p12
alias: mio-debug
password: android
```

这个密钥只用于本地调试（`.gitignore` 已排除）。发布用你自己的证书。

### 1.3 发布签名

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

规则：

- 密码只从环境变量读取，绝不写入配置或命令行参数；
- CLI 不生成、不保存发布密钥；
- 密钥丢失意味着无法更新已发布应用，请自行做好备份；
- keystore 建议使用 PKCS#12（`keytool` 已不推荐 JKS）。

### 1.4 校验

```bash
apksigner verify --verbose --print-certs build/mio/android/App.apk
```

CLI 在签名后会自动执行 verify；verify 不通过不会发布产物。

### 1.5 对齐与 16KB page size

```bash
zipalign -c -v -P 16 4 build/mio/android/App.apk
```

`pageSize: 16` 是默认值。16KB 页大小的设备（Android 15+ 部分机型）要求 native 库
按 16KB 对齐；构建时不做这一步，安装或启动可能失败。

对齐在签名前完成（`zipalign -P 16 4`），构建后校验一次；16KB 页大小的镜像已在
模拟器上验证。

## 2. Windows

### 2.1 为什么需要 Authenticode

未签名 exe：

- SmartScreen 会拦截，用户看到「未知发布者」；
- 企业环境可能直接禁止运行；
- 杀软误报概率更高。

Authenticode 签名不能省，但**证书必须由你提供**。Mio 不生成、不内置证书。

### 2.2 通过 CLI 钩子签名

注入资源会改变 exe，**必须在注入之后签名**。CLI 已经按这个顺序执行：

```text
复制模板 → 注入 asar → 注入图标/版本信息 → 重命名 exe → signCommand
```

配置：

```json
{
  "windows": {
    "signCommand": "signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a \"{exe}\""
  }
}
```

`{exe}` 会被替换为最终 exe 的绝对路径，命令在项目目录执行。

### 2.3 用证书文件签名

```json
{
  "windows": {
    "signCommand": "signtool sign /fd SHA256 /f cert.pfx /p %CERT_PASSWORD% /tr http://timestamp.digicert.com /td SHA256 \"{exe}\""
  }
}
```

约定：

- 密码只通过环境变量传入，`mio.config.json` 里只写变量名；
- `.pfx` 不进仓库（`.gitignore` 已覆盖常见扩展名）；
- 时间戳服务能保证证书过期后签名仍然有效。

### 2.4 Windows 上可用 signtool

`signtool.exe` 随 Windows SDK 安装，通常在：

```text
C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\signtool.exe
```

如果不在 PATH，可以在 `signCommand` 里写绝对路径。

### 2.5 校验

```bash
signtool verify /pa /v build/mio/windows/App/App.exe
```

### 2.6 与模板的关系

模板 exe 本身可能带有签名。注入资源后签名会失效，因此：

- 如果模板已签名，CLI 不负责剥离旧签名（`resedit` 会以未签名形式重新生成）；
- 最终签名以 `signCommand` 的结果为准；
- 未配置 `signCommand` 时产物是未签名 exe，只适合本地测试。

## 3. 发布产物

```text
build/mio/android/<AppName>-<version>.apk
build/mio/windows/<AppName>/<AppName>.exe  (+ dll, data/)
```

Android 产物是单文件 APK。

Windows 产物是**目录**，需要整体分发（压缩包或安装器）：exe 依赖
`flutter_windows.dll`、`data/`、`WebView2Loader.dll` 等。

## 4. CI 中的签名

推荐：

- 把 keystore / 证书放进 secret 管理（GitHub Secrets、Vault、KMS）；
- 构建时写入临时文件，构建后立即删除；
- 优先使用云 KMS 签名，避免私钥落地；
- 在 CI 中执行 `apksigner verify` 和 `signtool verify` 作为质量门禁。

当前仓库的 CI **不包含签名**，因为需要真实凭据。签名属于发布流水线，不是 PR 检查。

## 5. 尚未完成

- Windows Authenticode 的实际证书签名验证（代码路径已就绪，未用真实证书跑通）；
- Android 16KB 真机验证；
- Google Play / AAB（明确不在当前范围）。
