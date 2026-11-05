#!/usr/bin/env node
// Issue #266, DE-1, DE-5, MVP.md 11.6: the documentation site. It renders the
// user documentation under docs/, the charter documents at the root and the
// ADRs into one static site with the metadata a search engine and a link
// preview read: one title and one description per page, a canonical URL,
// Open Graph and Twitter cards, JSON-LD, a sitemap and robots.txt. The pages
// are plain HTML with one stylesheet and no script, so they render anywhere
// and the build has no step beside this file. `node tools/site.mjs [out]`
// writes the site; the unit test builds it into a temporary directory.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'
import { parse as parseYaml } from 'yaml'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_URL = 'https://github.com/4esv/enform'
const DEFAULT_BASE_URL = 'https://4esv.github.io/enform/'
const SITE_NAME = 'enform'
const TITLE_LIMIT = 70
const DESCRIPTION_LIMIT = 160

/** The user documentation, in navigation order: source under docs/ and the URL path. */
const GUIDE = [
  ['index.md', '', 'Home'],
  ['quick-setup.md', 'quick-setup/', 'Quick setup'],
  ['concepts.md', 'concepts/', 'Concepts'],
  ['builder.md', 'builder/', 'The builder'],
  ['forms.md', 'forms/', 'Forms and conditions'],
  ['routing.md', 'routing/', 'Routing'],
  ['acting.md', 'acting/', 'Acting on work'],
  ['realtime-offline.md', 'realtime-offline/', 'Realtime and offline'],
  ['cli.md', 'cli/', 'CLI reference'],
  ['api.md', 'api/', 'API reference'],
  ['deployment.md', 'deployment/', 'Deployment'],
  ['operations.md', 'operations/', 'Operations'],
  ['security.md', 'security/', 'Security and privacy'],
]

/** The charter documents at the repository root, after the guide. */
const CHARTER = [
  ['MVP.md', 'mvp/', 'MVP charter'],
  ['STORIES.md', 'stories/', 'User stories'],
  ['CHANGELOG.md', 'changelog/', 'Changelog'],
  ['CONTRIBUTING.md', 'contributing/', 'Contributing'],
]

/**
 * Build the site into `outDir` with `baseUrl` as the canonical root. Returns
 * the pages it wrote, so a test can check each one.
 */
export function buildSite({ outDir, baseUrl = DEFAULT_BASE_URL } = {}) {
  if (outDir === undefined) throw new Error('buildSite needs outDir')
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const sources = collectSources()
  const byFile = new Map(sources.map((source) => [source.file, source]))
  const pages = sources.map((source) => renderPage(source, byFile, root))
  mkdirSync(outDir, { recursive: true })
  mkdirSync(join(outDir, 'assets'), { recursive: true })
  writeFileSync(
    join(outDir, 'assets', 'site.css'),
    readFileSync(join(REPO, 'docs', 'assets', 'site.css'))
  )
  for (const page of pages) {
    const dir = join(outDir, page.path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), page.html)
  }
  writeFileSync(join(outDir, 'sitemap.xml'), sitemap(pages, root))
  writeFileSync(
    join(outDir, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${root}sitemap.xml\n`
  )
  writeFileSync(join(outDir, '404.html'), notFound(root, pages))
  writeFileSync(join(outDir, '.nojekyll'), '')
  return pages
}

/** Every source page: the guide, the charter, the ADRs and their index. */
function collectSources() {
  const sources = []
  for (const [file, path, nav] of GUIDE) {
    sources.push(source(join(REPO, 'docs', file), path, 'guide', nav))
  }
  for (const [file, path, nav] of CHARTER) {
    sources.push(source(join(REPO, file), path, 'charter', nav))
  }
  const adrDir = join(REPO, 'docs', 'adr')
  const adrs = readdirSync(adrDir)
    .filter((name) => /^\d{4}-.*\.md$/.test(name) && !name.startsWith('0000-'))
    .sort()
  const adrPages = adrs.map((name) =>
    source(join(adrDir, name), `adr/${name.slice(0, -3)}/`, 'adr')
  )
  sources.push(adrIndex(adrPages))
  sources.push(...adrPages)
  return sources
}

/** Read one markdown source and its title and description. */
function source(file, path, section, nav) {
  const markdown = readFileSync(file, 'utf8')
  const title = (markdown.match(/^#\s+(.+?)\s*$/m) ?? [])[1] ?? relative(REPO, file)
  return { file, path, section, nav: nav ?? title, title: plainText(title), markdown }
}

/** The ADR index page, built from the ADR sources. */
function adrIndex(adrPages) {
  const rows = adrPages.map((page) => `- [${page.title}](${relative(REPO, page.file)})`).join('\n')
  const markdown = `# Architecture decisions\n\n<!-- description: The accepted architecture decision records of enform, each with its context, the decision and its consequences: the store, the identity broker, the event model, realtime, local drafts, the rules sandbox and more. -->\n\nEach decision applies until a later record changes it. The records are numbered in the order they were accepted.\n\n${rows}\n`
  return {
    file: join(REPO, 'docs', 'adr', 'index.md'),
    path: 'adr/',
    section: 'adr',
    nav: 'Architecture decisions',
    title: 'Architecture decisions',
    markdown,
  }
}

/** Render one page: the markdown to HTML with rewritten links, inside the layout. */
function renderPage(src, byFile, root) {
  const description = descriptionOf(src.markdown)
  const renderer = new marked.Renderer()
  const sourceDir = dirname(src.file)
  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens)
    const id = slugOf(plainText(text))
    return `<h${depth} id="${id}">${text}</h${depth}>\n`
  }
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens)
    const target = rewriteHref(href, sourceDir, byFile, root, src)
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
    const external = /^https?:\/\//.test(target) && !target.startsWith(root)
    const rel = external ? ' rel="noopener"' : ''
    return `<a href="${escapeHtml(target)}"${titleAttr}${rel}>${text}</a>`
  }
  marked.use({ gfm: true })
  const operations =
    src.path === 'api/'
      ? `\n\n## Operations\n\nEvery operation of the document, in its order.\n\n${apiOperationsTable()}\n`
      : ''
  const stripped = `${src.markdown.replace(/<!--\s*description:[\s\S]*?-->\s*/g, '')}${operations}`
  const body = marked.parse(stripped, { renderer, async: false })
  const url = `${root}${src.path}`
  const pageTitle =
    src.path === ''
      ? 'enform: the open-source multiplayer form builder'
      : `${src.title} · ${SITE_NAME}`
  const html = layout({ src, body, description, url, root, pageTitle, byFile })
  return { ...src, description, url, html }
}

/** The description: the `<!-- description: -->` comment, or the first paragraph. */
function descriptionOf(markdown) {
  const explicit = markdown.match(/<!--\s*description:\s*([\s\S]*?)\s*-->/)
  const text = explicit ? explicit[1].replace(/\s+/g, ' ') : firstParagraph(markdown)
  return truncate(text, DESCRIPTION_LIMIT)
}

function firstParagraph(markdown) {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').split('\n')
  const paragraph = []
  let seenHeading = false
  for (const line of lines) {
    if (/^#/.test(line)) {
      seenHeading = true
      continue
    }
    if (!seenHeading) continue
    if (line.trim() === '' || /^[>|\-*`\d]/.test(line.trim())) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(line.trim())
  }
  return plainText(paragraph.join(' '))
}

function truncate(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  return `${cut.slice(0, space > 40 ? space : cut.length).replace(/[,;:]$/, '')}…`
}

/** Markdown inline syntax to plain text, for titles and descriptions. */
function plainText(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function slugOf(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  )
}

/**
 * Rewrite a markdown link: a relative `.md` link to a page of the site becomes
 * its URL, a relative link to any other repository file becomes its GitHub
 * URL, and anything else stays.
 */
function rewriteHref(href, sourceDir, byFile, root, src) {
  if (/^(https?:|mailto:|#)/.test(href)) return href
  const [pathPart, anchor] = href.split('#')
  const resolved = resolve(sourceDir, pathPart)
  const page = byFile.get(resolved)
  if (page !== undefined) return `${root}${page.path}${anchor ? `#${anchor}` : ''}`
  const repoPath = relative(REPO, resolved)
  if (repoPath.startsWith('..')) {
    throw new Error(`${relative(REPO, src.file)} links outside the repository: ${href}`)
  }
  const kind = /\.[^/]+$/.test(repoPath) ? 'blob' : 'tree'
  return `${REPOSITORY_URL}/${kind}/main/${repoPath}${anchor ? `#${anchor}` : ''}`
}

/** The HTML document around one page's body. */
function layout({ src, body, description, url, root, pageTitle, byFile }) {
  const nav = navigation(byFile, root, src)
  const breadcrumbs = [{ name: 'enform', item: root }]
  if (src.section === 'adr' && src.path !== 'adr/') {
    breadcrumbs.push({ name: 'Architecture decisions', item: `${root}adr/` })
  }
  if (src.path !== '') breadcrumbs.push({ name: src.title, item: url })
  const jsonLd =
    src.path === ''
      ? homeJsonLd(root, description)
      : articleJsonLd(src, url, description, breadcrumbs)
  const title = truncate(pageTitle, TITLE_LIMIT)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(url)}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#1f3a5f">
<meta property="og:type" content="${src.path === '' ? 'website' : 'article'}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${escapeHtml(src.path === '' ? pageTitle : src.title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(src.path === '' ? pageTitle : src.title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<link rel="stylesheet" href="${assetPrefix(src.path)}assets/site.css">
<link rel="sitemap" type="application/xml" href="${root}sitemap.xml">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top">
<a class="brand" href="${root}">enform</a>
<nav aria-label="Primary"><a href="${root}quick-setup/">Quick setup</a><a href="${root}concepts/">Concepts</a><a href="${root}cli/">CLI</a><a href="${root}api/">API</a><a href="${REPOSITORY_URL}" rel="noopener">GitHub</a></nav>
</header>
<div class="page">
<aside class="side" aria-label="Documentation">
${nav}
</aside>
<main id="content" class="content">
<article>
${body}</article>
<footer class="foot">
<p>enform is open source under the MIT license. <a href="${REPOSITORY_URL}/blob/main/${escapeHtml(relative(REPO, src.file))}" rel="noopener">Edit this page on GitHub</a>.</p>
</footer>
</main>
</div>
</body>
</html>
`
}

/** The sidebar: the guide, the charter and the ADR index, with the current page marked. */
function navigation(byFile, root, current) {
  const groups = [
    ['Guide', GUIDE.map(([file]) => byFile.get(join(REPO, 'docs', file)))],
    [
      'Project',
      [
        ...CHARTER.map(([file]) => byFile.get(join(REPO, file))),
        byFile.get(join(REPO, 'docs', 'adr', 'index.md')),
      ],
    ],
  ]
  return groups
    .map(([heading, pages]) => {
      const items = pages
        .filter((page) => page !== undefined)
        .map((page) => {
          const here = page.path === current.path ? ' aria-current="page"' : ''
          return `<li><a href="${root}${page.path}"${here}>${escapeHtml(page.nav)}</a></li>`
        })
        .join('\n')
      return `<section><h2>${heading}</h2>\n<ul>\n${items}\n</ul>\n</section>`
    })
    .join('\n')
}

function homeJsonLd(root, description) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: SITE_NAME,
        url: root,
        description,
      },
      {
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Linux, Docker',
        license: 'https://opensource.org/licenses/MIT',
        url: root,
        codeRepository: REPOSITORY_URL,
        description,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    ],
  }
}

function articleJsonLd(src, url, description, breadcrumbs) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        headline: src.title,
        description,
        url,
        isPartOf: { '@type': 'WebSite', name: SITE_NAME },
        author: { '@type': 'Organization', name: 'enform contributors', url: REPOSITORY_URL },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: breadcrumbs.map((crumb, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: crumb.name,
          item: crumb.item,
        })),
      },
    ],
  }
}

function sitemap(pages, root) {
  const urls = pages
    .map((page) => `  <url><loc>${escapeHtml(`${root}${page.path}`)}</loc></url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

function notFound(root, pages) {
  const home = pages.find((page) => page.path === '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found · enform</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="${root}assets/site.css">
</head>
<body>
<main class="content"><article><h1>Page not found</h1><p>There is no page at this address. Start from the <a href="${root}">${escapeHtml(home?.title ?? 'home page')}</a> or the <a href="${root}quick-setup/">quick setup</a>.</p></article></main>
</body>
</html>
`
}

/** The relative prefix from a page at `path` back to the site root, so a local preview of the output also styles. */
function assetPrefix(path) {
  const depth = path.split('/').filter((part) => part !== '').length
  return depth === 0 ? './' : '../'.repeat(depth)
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The API operations from the OpenAPI document, as a markdown table (DX-1). */
export function apiOperationsTable() {
  const document = parseYaml(readFileSync(join(REPO, 'api', 'openapi.yaml'), 'utf8'))
  const rows = []
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = item[method]
      if (operation === undefined) continue
      rows.push(`| \`${method.toUpperCase()} ${path}\` | ${operation.summary ?? ''} |`)
    }
  }
  return ['| Operation | Summary |', '|---|---|', ...rows].join('\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? join(REPO, 'site'))
  const baseUrl = process.env.SITE_URL ?? DEFAULT_BASE_URL
  const pages = buildSite({ outDir, baseUrl })
  process.stdout.write(`wrote ${pages.length} pages to ${outDir} for ${baseUrl}\n`)
}
