# @iyexin/mio-android-tools

Android APK 工具链封装。负责：

- 发现本机 Android SDK build-tools / Java，或使用 Mio 下载的工具包；
- `zipalign`（4KB / 16KB page size）；
- `apksigner` 签名（v1/v2/v3）；
- `apksigner verify` 解析；
- 调试 keystore 生成。

## 为什么需要它

Android APK 必须签名；targetSdk 30+ 只带 v1 的 APK 在 Android 11+ 无法安装。
`apksigner` 是目前最成熟的 v2+ 签名实现，但它需要 JVM。Mio 的策略是：

1. 优先复用系统 Java + Android SDK；
2. 没有时下载最小 JRE + `apksigner.jar` + `zipalign` 的工具包；
3. CLI 不要求开发者安装 Android Studio。

## 用法

```ts
import { discoverAndroidTools, signApk } from "@iyexin/mio-android-tools";

const tools = await discoverAndroidTools();

const result = await signApk({
  tools,
  input: "app-unsigned.apk",
  output: "app-release.apk",
  keystore: "release.p12",
  keystorePassword: process.env.MIO_KS_PASS!,
  keyAlias: "release",
  minSdkVersion: 24,
  pageSize: 16,
});

console.log(result.verify.v2, result.verify.v3);
```

`signApk` 的固定顺序是：**zipalign → apksigner sign → apksigner verify**。
`apksigner` 不负责对齐，`zipalign` 不能省。

## 工具包（无 Android SDK 的机器）

`installToolBundle` 负责下载、SHA-256 校验、解压和缓存：

```ts
import { installToolBundle } from "@iyexin/mio-android-tools";

const installed = await installToolBundle({
  manifest: "https://example.com/mio-android-tools.json",
  version: "0.1.0",
  // 默认读取 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
  proxy: "http://127.0.0.1:7897",
});

const result = await signApk({
  tools: installed.tools,
  ...
});
```

默认缓存目录：`~/.mio/tools/android/<version>/<platform>/`。
缓存命中条件：版本、平台、SHA-256 都匹配。

### 构建工具包

```bash
node scripts/build-bundle.mjs \
  --jre <jre-dir> \
  --apksigner <build-tools>/lib/apksigner.jar \
  --zipalign <build-tools>/zipalign.exe \
  --out artifacts/mio-android-tools-win32-x64.tar.gz
```

脚本会打印 manifest 里所需的 `sha256` 和 `size`。

## 测试

```bash
pnpm --filter @iyexin/mio-android-tools test
```

测试会使用本机 Android SDK/JAVA_HOME；没有配置时自动跳过签名集成测试。
`test/fixtures/base.apk` 是只用于签名测试的最小 APK，`test.p12` 是测试密钥，
都不是发布材料。
