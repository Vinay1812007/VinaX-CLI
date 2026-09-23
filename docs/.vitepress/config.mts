import { defineConfig } from 'vitepress';
import { tabsMarkdownPlugin } from 'vitepress-plugin-tabs';

const REPO = 'https://github.com/Vinay1812007/VinaX-CLI';

export default defineConfig({
  title: 'VinaX',
  description:
    'VinaX is an open-source agentic coding assistant for your terminal, powered by free-tier models from Groq and OpenRouter.',
  // Served from GitHub Pages at https://vinay1812007.github.io/VinaX-CLI/
  base: '/VinaX-CLI/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['README.md', 'PLAN.md'],
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/VinaX-CLI/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#14B8A6' }],
  ],
  markdown: {
    config(md) {
      md.use(tabsMarkdownPlugin);
    },
  },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'VinaX Docs',
    nav: [
      { text: 'Docs', link: '/', activeMatch: '^/(?!gateway|reference)' },
      { text: 'Gateway', link: '/gateway' },
      { text: 'CLI reference', link: '/cli-reference' },
      { text: 'Releases', link: `${REPO}/releases` },
      { text: 'npm', link: 'https://www.npmjs.com/package/@sirimillavinay/vinax' },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Quickstart', link: '/quickstart' },
          { text: 'Install and set up', link: '/setup' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Use VinaX',
        items: [
          { text: 'Interactive mode', link: '/interactive-mode' },
          { text: 'Commands and prefixes', link: '/commands' },
          { text: 'Permissions', link: '/permissions' },
          { text: 'Memory', link: '/memory' },
          { text: 'Sessions and context', link: '/sessions' },
          { text: 'Print mode and scripts', link: '/print-mode' },
        ],
      },
      {
        text: 'Configure',
        items: [
          { text: 'Models and rate limits', link: '/models' },
          { text: 'Settings', link: '/settings' },
          { text: 'Hooks', link: '/hooks' },
          { text: 'MCP servers', link: '/mcp' },
          { text: 'Sub-agents', link: '/sub-agents' },
        ],
      },
      {
        text: 'Gateway',
        items: [{ text: 'Run and connect a gateway', link: '/gateway' }],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI reference', link: '/cli-reference' },
          { text: 'Tools', link: '/tools' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'Releasing', link: '/releasing' },
          { text: 'Security policy', link: `${REPO}/blob/main/SECURITY.md` },
        ],
      },
    ],
    outline: { level: [2, 3], label: 'On this page' },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: REPO }],
    editLink: {
      pattern: `${REPO}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'VinaX CLI',
    },
  },
});
