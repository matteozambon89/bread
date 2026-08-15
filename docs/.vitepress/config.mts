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

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Agents', link: '/agents' },
          { text: 'CLI', link: '/cli' },
          { text: 'Glossary', link: '/glossary' },
        ],
      },
      {
        text: 'Core Concepts',
        items: [
          { text: 'Sessions', link: '/sessions' },
          { text: 'Pipelines & Supervisors', link: '/pipelines' },
          { text: 'Agent-driven Loops', link: '/loops' },
          { text: 'Tasks', link: '/tasks' },
          { text: 'Tools', link: '/tools' },
          { text: 'Skills', link: '/skills' },
          { text: 'Human-in-the-loop', link: '/hitl' },
          { text: 'Storage', link: '/store' },
        ],
      },
      {
        text: 'Protocols & Transports',
        items: [
          { text: 'Transports', link: '/transports' },
          { text: 'Remote Agents', link: '/remote-agents' },
          { text: 'A2A Server', link: '/a2a' },
          { text: 'AG-UI', link: '/ag-ui' },
          { text: 'A2UI', link: '/a2ui' },
          { text: 'MCP Client', link: '/mcp-client' },
          { text: 'MCP Server', link: '/mcp-server' },
        ],
      },
      {
        text: 'Extensions',
        items: [
          { text: 'Auth', link: '/auth' },
          { text: 'OpenTelemetry', link: '/otel' },
          { text: 'Plugins', link: '/plugins' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Providers', link: '/providers' },
          { text: 'HTTP API', link: '/http-api' },
          { text: 'Evals', link: '/evals' },
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
