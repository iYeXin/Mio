import { defineConfig } from 'vitepress'

const repo = 'https://github.com/iYeXin/Mio'
// The site is served under this sub-path; VitePress prefixes assets and links.
const base = '/mio/'

export default defineConfig({
  lang: 'zh-CN',
  base,
  title: 'Mio',
  description: '轻量的跨平台应用开发框架：用 Web 技术写界面，构建 Android 与 Windows 应用',
  // Maintainer notes and internal design docs stay in the repo, not on the site.
  srcExclude: ['local/**', 'architecture.md', 'template-maintenance.md', 'release.md'],
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo-light.svg` }],
    ['meta', { name: 'theme-color', content: '#fbfaf7' }],
  ],
  themeConfig: {
    logo: { light: '/logo-light.svg', dark: '/logo-dark.svg' },
    siteTitle: 'Mio',
    nav: [
      { text: '开始', link: '/quickstart' },
      { text: '配置', link: '/configuration' },
      { text: 'API', link: '/api' },
      { text: 'GitHub', link: repo },
    ],
    sidebar: [
      {
        text: '指南',
        items: [
          { text: '概览', link: '/' },
          { text: '开始使用', link: '/quickstart' },
          { text: '配置', link: '/configuration' },
        ],
      },
      {
        text: '参考',
        items: [
          { text: 'API v1', link: '/api' },
          { text: '原生库', link: '/native-extensions' },
        ],
      },
      {
        text: '发布',
        items: [{ text: '签名', link: '/signing' }],
      },
    ],
    outline: { level: [2, 3], label: '本页' },
    docFooter: { prev: '上一页', next: '下一页' },
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色',
    darkModeSwitchTitle: '切换到深色',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    lastUpdatedText: '最后更新',
    externalLinkIcon: true,
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
          modal: {
            displayDetails: '显示详情',
            resetButtonTitle: '清空',
            backButtonTitle: '返回',
            noResultsText: '没有结果',
            footer: {
              selectText: '选择',
              selectKeyAriaLabel: '回车',
              navigateText: '切换',
              navigateUpKeyAriaLabel: '上',
              navigateDownKeyAriaLabel: '下',
              closeText: '关闭',
              closeKeyAriaLabel: 'Esc',
            },
          },
        },
      },
    },
  },
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
    lineNumbers: false,
  },
})
