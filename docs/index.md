---
layout: home

hero:
  name: MIO
  text: 轻量的跨平台开发框架
  tagline: 用 Web 技术写界面，构建成 Android 与 Windows 应用。预编译的运行时、类型化的 API、需要时可以加载自己的原生库。
  actions:
    - theme: brand
      text: 开始使用
      link: /quickstart
    - theme: alt
      text: API 参考
      link: /api

features:
  - title: 一份代码，两端应用
    details: 同一个 Web 项目构建成 Android APK 与 Windows 桌面应用，界面、逻辑和 API 调用完全一致。
  - title: 构建不需要原生工具链
    details: 运行时由 Mio 提供并预编译，构建只做资源打包与签名。不需要安装 Flutter、Android Studio 或 Visual Studio。
  - title: 完整的应用 API
    details: 文件、HTTP 与代理、通知、相册、剪贴板、托盘、窗口、分享与前台服务，按平台能力直接暴露。
  - title: TypeScript 优先
    details: 类型化的 @iyexin/mio-api、Vite 脚手架、Promise 化的调用与结构化错误码，编辑器里能直接补全。
  - title: 可以与原生代码协作
    details: 需要时加载自己的 .so / .dll，调用导出函数、接收事件，在稳定的边界内做重活。
  - title: 面向发布的构建
    details: Android 自动对齐与签名并校验，Windows 支持 Authenticode 钩子，产物可以直接分发。
---
