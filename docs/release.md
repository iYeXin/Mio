# 发布流程

## 版本模型

Mio 有三个独立演进的版本号：

| 版本 | 位置 | 含义 |
|---|---|---|
| `MIO_CLI_VERSION` | `packages/cli/src/constants.ts`、各 `package.json` | CLI 与 npm 包的版本，本次发布是 `0.1.0` |
| `MIO_API_VERSION` | `packages/cli/src/constants.ts`、`shell/lib/src/api.dart`、`@iyexin/mio-api` | 桥契约版本，当前 `1.0.0` |
| `mioTemplateVersion` | `shell/lib/src/api.dart` | 壳模板版本 |

规则：

- CLI 版本按 SemVer 递增；
- **桥契约的 major 只在破坏性变更时提升**。壳启动时会拒绝 `requires.apiVersion` 更高的
  应用，所以提升 major 等于宣布旧模板不再兼容新应用；
- 模板是二进制产物，改壳就要重发模板（见 [template-maintenance.md](template-maintenance.md)）。
  只改 CLI、不改壳时，模板可以不动。

## 发布前检查清单

按顺序做完再打标签。能自动化的部分跑 `scripts/verify-release.ps1`。

1. **版本一致**
   - 根 `package.json`、`packages/*/package.json` 的 `version` 相同；
   - `MIO_CLI_VERSION` 与它们一致；
   - `MIO_API_VERSION` 在 `constants.ts`、`api.dart`、`@iyexin/mio-api` 三处一致。
2. **许可证**
   - 根目录有 `LICENSE`；
   - `packages/android-tools/THIRD_PARTY_NOTICES.md` 覆盖新增依赖。
3. **文档**
   - [API](api.md) 覆盖 `api.dart` 里所有 `case 'x.y'`；
   - 错误码表覆盖代码里出现的所有 `MIO/ FS_/PROCESS_/NATIVE_` 码；
   - [CHANGELOG](https://github.com/iYeXin/Mio/blob/main/CHANGELOG.md) 有本次条目。
4. **模板**
   - `packages/cli/templates/android/mio-shell-universal.apk`、`mio-shell-arm64.apk` 存在；
   - `packages/cli/templates/windows/` 完整（含 `data/`）；
   - `libapp.so` / `app.so` 与 `shell/build` 的最新构建一致。
5. **模板资产**
   - 模板不入库；Release 需要 `manifest.json` + `mio-shell-universal.apk` +
     `mio-shell-arm64.apk` + `mio-shell-x64.apk` + `mio-windows.zip`；
   - 打标签后由 `.github/workflows/release.yml` 自动构建并挂到 Release；
   - 本地重建用 `./scripts/build-templates.ps1`（会被 `mio build` 优先使用）。
6. **测试**
   - `pnpm -r typecheck && pnpm -r build && pnpm -r test`
   - `cd shell && flutter analyze && flutter test`
   - 端到端：`tools/verification/native` 的 18 项检查在 Windows 与 Android 真机通过。
7. **手动验证**
   - 至少一台 Android 真机安装、启动、调用；
   - 至少一台 Windows 机器启动、WebView 加载。

## 打标签

```powershell
git status --short           # 必须干净
git tag -a v0.1.0 -m "Mio 0.1.0"
git push --follow-tags
```

标签名与 CLI 版本一致（`v0.1.0`），CHANGELOG 用同一节。

## 本次发布（0.1.0）的实际结论

- 版本：CLI / API 包 `0.1.0`，桥契约 `1.0.0`；
- 模板：universal ≈ 54 MB、arm64 ≈ 19 MB、Windows 目录 ≈ 29 MB，全部与源码同批构建；
- 测试：`flutter test` 97、CLI 8、android-tools 15，端到端 18/18（Windows 11 + Android 12）；
- npm 包：`@iyexin/mio-cli`、`@iyexin/mio-api`、`@iyexin/mio-android-tools`，均已去掉
  `private`、补齐 `files` / `license` / `repository`；CLI 的发布体积约 39 kB（模板作为
  Release 资产，不随包分发）。

## npm 发布

首次版本需要手动发（npm 的 2FA 策略只在网页/CLI 允许一次），之后交给 Trusted
Publishing。

1. 手动发第一版（本地有 2FA 时用 npm 网页或 `npm publish --otp`）：

   ```powershell
   pnpm -r build
   pnpm --filter @iyexin/mio-android-tools publish --access public --no-git-checks
   pnpm --filter @iyexin/mio-api publish --access public --no-git-checks
   pnpm --filter @iyexin/mio-cli publish --access public --no-git-checks
   ```

2. 在 npmjs.com 每个包的 Settings → Trusted Publishing 里登记：
   仓库 `iYeXin/Mio`，工作流 `npm-publish.yml`，环境留空。

3. 之后发版：GitHub Releases 里发布一个 release（或手动触发 `Publish npm`），
   工作流用 OIDC 拿短期令牌，`npm publish --provenance` 自动完成，不需要 `NPM_TOKEN`。

   `Publish npm` 也支持 `dry_run`，只打包不上传。

## 未随本次发布的事

- Google Play AAB / 商店合规；
- Windows 安装包（MSIX / Inno）与 CA 证书签名；
- Windows 上把原生库放进独立进程（崩溃隔离）；
- 自动更新。
