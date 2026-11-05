import { chromium, type Page } from 'playwright'
import { expect, test } from 'vitest'
import { startApi } from '../../tools/harness/server.js'
import { CLOSED_SLUG, grants, NOBODY, publishedState, resolve, SAM, SLUG } from './scenario.js'

// Issue #269, ID-3, AC-1, S06, A4, ADR 0009: the shell of the interface in
// Chromium. The form of a flow that allows anonymous access carries a
// visible label (ID-3), the page is styled by its one stylesheet, and a
// person who may not start the flow reads the refusal that names the scope
// that would allow it (S06, AC-1). The harness serves the published flow
// and authorizes the start through the engine, so the browser decides
// nothing (A9).

/** Open the form of the flow as `actor` and run `body`. */
async function withForm(
  slug: string,
  actor: string,
  body: (page: Page) => Promise<void>
): Promise<void> {
  // The grants apply to the principals they name (AC-1), not to whoever acts.
  const api = startApi(publishedState(), { bootstrap: grants, resolve })
  await new Promise<void>((listening) => api.server.listen(0, '127.0.0.1', listening))
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const url = new URL('/app/', `http://127.0.0.1:${api.port()}`)
    url.searchParams.set('slug', slug)
    url.searchParams.set('actor', actor)
    await page.goto(url.toString())
    await page.waitForSelector('form', { timeout: 5000 })
    await body(page)
  } finally {
    await browser.close()
    await new Promise<void>((closed, rejected) =>
      api.server.close((error) => (error ? rejected(error) : closed()))
    )
  }
}

test('#269 ID-3 the form of an anonymous flow carries a visible label, and the page is styled', async () => {
  await withForm(SLUG, SAM, async (page) => {
    // The label is on the page, in words, not only in the builder (ID-3).
    const label = page.locator('[data-anonymous]')
    await label.waitFor({ timeout: 5000 })
    expect(await label.textContent()).toContain('Anonymous access')

    // One stylesheet, loaded and applied: the body is not the browser's default.
    const styled = await page.evaluate(() => {
      const sheets = Array.from(document.styleSheets).filter((sheet) =>
        (sheet.href ?? '').endsWith('/app/app.css')
      )
      const rules = sheets.reduce((count, sheet) => count + sheet.cssRules.length, 0)
      return { rules, font: getComputedStyle(document.body).fontFamily }
    })
    expect(styled.rules).toBeGreaterThan(10)
    expect(styled.font.toLowerCase()).toContain('system-ui')
  })
})

test('#269 S06 AC-1 a person who may not start the flow reads the refusal with the scope it needs', async () => {
  // The closed flow is not anonymous, so the start is authorized (AC-1).
  await withForm(CLOSED_SLUG, NOBODY, async (page) => {
    await page.click('[data-submit]')
    // The server refuses the start and names the scope (AC-1); the page shows
    // the refusal as the server wrote it (A9).
    await page
      .locator('.status', { hasText: 'requires the scope instance.start' })
      .waitFor({ timeout: 5000 })
  })
})
