# 文档

## 使用

- [API v1](api.md) — 命名空间、事件、错误码、原生调用签名
- [示例应用](../examples/native-demo/README.md) — 最小可运行的原生库示例

## 理解实现

- [架构](architecture.md) — 模板、归档、桥、WebView 的分层
- [原生能力](native-extensions.md) — `nativeApi` 与 `processApi` 的边界和实现
- [签名](signing.md) — Android `apksigner`、Windows Authenticode

## 维护

- [模板维护](template-maintenance.md) — 改壳后重建并发布模板
- [发布流程](release.md) — 版本模型、检查清单、npm 发布
- [手工验证应用](../tools/verification/README.md) — 原生 API 18 项 / 进程 API 5 项
