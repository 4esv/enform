import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
// @ts-expect-error the generator is a plain module without types (tools/*.mjs)
import { buildSite } from './site.mjs'

// Issue #266, DE-1, DE-5, MVP.md 11.6: the documentation site. The build
// renders every guide page, the charter documents and the ADRs, and each page
// carries what a search engine and a link preview read: one title of a sane
// length, one description, a canonical URL, Open Graph tags and JSON-LD. The
// internal links of the markdown resolve to pages of the site, the sitemap
// names every page and robots.txt names the sitemap.

const BASE = 'https://docs.example.test/enform/'
const REPO = join(import.meta.dirname, '..')

type Page = {
  readonly path: string
  readonly title: string
  readonly description: string
  readonly url: string
  readonly html: string
}

let out = ''
let pages: readonly Page[] = []

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'enform-site-'))
  pages = buildSite({ outDir: out, baseUrl: BASE }) as readonly Page[]
})

afterAll(() => {
  if (out !== '') rmSync(out, { recursive: true, force: true })
})

test('#266 the site renders every guide page, the charter and the ADRs with SEO metadata', () => {
  const guide = readdirSync(join(REPO, 'docs')).filter((name) => name.endsWith('.md'))
  const adrs = readdirSync(join(REPO, 'docs', 'adr')).filter(
    (name) => /^\d{4}-.*\.md$/.test(name) && !name.startsWith('0000-')
  )
  expect(pages.length).toBe(guide.length + 4 + 1 + adrs.length)
  expect(pages.map((page) => page.path)).toEqual(
    expect.arrayContaining(['', 'quick-setup/', 'cli/', 'api/', 'mvp/', 'stories/', 'adr/'])
  )

  for (const page of pages) {
    const file = join(out, page.path, 'index.html')
    expect(existsSync(file), `${page.path} is written`).toBe(true)
    const html = readFileSync(file, 'utf8')
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''
    expect(title.length, `${page.path} has a title`).toBeGreaterThan(5)
    expect(title.length, `${page.path} title fits a result line`).toBeLessThanOrEqual(70)
    const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? ''
    expect(description.length, `${page.path} has a description`).toBeGreaterThanOrEqual(50)
    expect(description.length, `${page.path} description fits a snippet`).toBeLessThanOrEqual(160)
    expect(html, `${page.path} has its canonical URL`).toContain(
      `<link rel="canonical" href="${BASE}${page.path}">`
    )
    expect(html).toContain('property="og:title"')
    expect(html).toContain('application/ld+json')
    expect(html).toContain('<html lang="en">')
    expect(html.match(/<h1[\s>]/g)?.length, `${page.path} has one h1`).toBe(1)
    // A link to a markdown file that is not a page of the site goes to GitHub.
    expect(html, `${page.path} has no markdown link left`).not.toMatch(
      /href="(?!https:\/\/github\.com\/)[^"]*\.md(#[^"]*)?"/
    )
  }
})

test('#266 every internal link of the site resolves to a page, and the sitemap and robots name them all', () => {
  const written = new Set(pages.map((page) => `${BASE}${page.path}`))
  for (const page of pages) {
    const html = readFileSync(join(out, page.path, 'index.html'), 'utf8')
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1]
      if (!href.startsWith(BASE)) continue
      const [target] = href.split('#')
      if (target.endsWith('.css') || target.endsWith('.xml')) continue
      expect(written.has(target), `${page.path} links to ${href}`).toBe(true)
    }
  }
  const sitemap = readFileSync(join(out, 'sitemap.xml'), 'utf8')
  for (const url of written) expect(sitemap).toContain(`<loc>${url}</loc>`)
  const robots = readFileSync(join(out, 'robots.txt'), 'utf8')
  expect(robots).toContain(`Sitemap: ${BASE}sitemap.xml`)
  expect(existsSync(join(out, '404.html'))).toBe(true)
  expect(existsSync(join(out, '.nojekyll'))).toBe(true)
})

test('#266 the API page lists every operation of the OpenAPI document', () => {
  const api = readFileSync(join(out, 'api', 'index.html'), 'utf8')
  for (const operation of [
    'POST /api/v1/operations',
    'GET /api/v1/log',
    'PUT /api/v1/flows/{slug}/draft',
    'POST /api/v1/flows/{slug}/dry-run',
    'GET /api/v1/inbox',
  ]) {
    expect(api, `${operation} is listed`).toContain(operation)
  }
})
