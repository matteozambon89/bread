import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid({
  title: 'bread',
  description:
    'Explicit by design. A file-system-convention framework for building, running, and observing AI agents on top of the Vercel AI SDK.',
  // Project site: https://matteozambon89.github.io/bread/
  base: '/bread/',

  // docs/*.md link into ../examples/* — real repo dirs (runnable code, not
  // doc pages), so they resolve fine on GitHub but aren't part of this site.
  ignoreDeadLinks: [/\.\.\/examples/],

  head: [
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/bread/favicon.ico' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/bread/favicon-32.png' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/bread/favicon-16.png' }],
    ['link', { rel: 'apple-touch-icon', href: '/bread/apple-touch-icon.png' }],
  ],

  themeConfig: {
    logo: {
      light: '/mark-light-512.png',
      dark: '/mark-dark-512.png',
    },

    nav: [
      { text: 'Guide', link: '/architecture' },
      { text: 'Reference', link: '/http-api' },
      { text: 'Changelog', link: 'https://github.com/matteozambon89/bread/releases' },
    ],

    // Grouped to mirror the README's own "Documentation" list order, so the
    // same mental map holds whether someone's reading the repo or the site.
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'CLI', link: '/cli' },
        ],
      },
      {
        text: 'Building agents',
        items: [
          { text: 'Agents', link: '/agents' },
          { text: 'Providers', link: '/providers' },
          { text: 'Tools', link: '/tools' },
          { text: 'Skills', link: '/skills' },
          { text: 'Sessions', link: '/sessions' },
          { text: 'HITL', link: '/hitl' },
        ],
      },
      {
        text: 'Composition',
        items: [
          { text: 'Pipelines', link: '/pipelines' },
          { text: 'Loops', link: '/loops' },
          { text: 'Tasks', link: '/tasks' },
          { text: 'Evals', link: '/evals' },
          { text: 'Plugins', link: '/plugins' },
        ],
      },
      {
        text: 'Distribution',
        items: [
          { text: 'Remote agents', link: '/remote-agents' },
          { text: 'Transports', link: '/transports' },
          { text: 'MCP client', link: '/mcp-client' },
          { text: 'MCP server', link: '/mcp-server' },
          { text: 'A2A server', link: '/a2a' },
          { text: 'A2UI', link: '/a2ui' },
          { text: 'Auth', link: '/auth' },
          { text: 'OTel', link: '/otel' },
          { text: 'AG-UI', link: '/ag-ui' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'HTTP API', link: '/http-api' },
          { text: 'Store', link: '/store' },
          { text: 'Glossary', link: '/glossary' },
        ],
      },
    ],

    search: {
      provider: 'local',
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/matteozambon89/bread' }],

    editLink: {
      pattern: 'https://github.com/matteozambon89/bread/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Matteo Zambon',
    },
  },
})
