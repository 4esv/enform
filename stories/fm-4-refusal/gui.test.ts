import { chromium, type Page } from 'playwright'
import { expect, test } from 'vitest'
import { complete } from '../../engine/action.js'
import { instanceOf } from '../../engine/instances.js'
import type { Operation } from '../../engine/operation.js'
import { startApi } from '../../tools/harness/server.js'
import {
  claimedState,
  definition,
  grants,
  INSTANCE_ID,
  OKAFOR,
  OUTCOME,
  resolve,
  SLUG,
} from './scenario.js'

// Issue #106 criterion 2, FM-3, FM-4, FM-7, A9, I12, ADR 0009, ADR 0010: the
// requirement test for #106 criterion 2 and FM-4. The browser opens the task
// page of the instance that Dr. Okafor holds, renders the form for the current
// step and one control per outcome, and posts a completion intent through the
// generated client. The server runs the step's rules and validation again
// (FM-4) and refuses an empty required field with every error named by path;
// the browser shows the reason in `.status` and the message at the control.
// The accepted completion appends exactly the engine's operation, so the
// browser decided nothing (A9, I12).

/** The values that the browser collects when only the summary is filled (FM-7). */
const values = { summary: 'three extra credits', details: '', urgent: false }

/** The accepted completion's injected sources (I6), matching the page's injected sources. */
const sources = { clock: () => 1, ids: () => 'op-2' }

/** Wait for the in-process server to reach `length` events (one async browser submit). */
async function waitForLog(api: ReturnType<typeof startApi>, length: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (api.state().log.length < length) {
    if (Date.now() > deadline) {
      throw new Error('the interface did not append its event in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * Serve the claimed seed, open the task page of Dr. Okafor in Chromium and run
 * `body`. The page injects the same sources as the runner's gui mode (I6): a
 * fixed clock and the operation ID `op-2`, so the browser's completion can be
 * compared to the engine's golden operation.
 */
async function withTaskPage(
  body: (page: Page, api: ReturnType<typeof startApi>) => Promise<void>
): Promise<void> {
  const api = startApi(claimedState(), { grants, resolve })
  await new Promise<void>((listening) => api.server.listen(0, '127.0.0.1', listening))
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.addInitScript(`globalThis.__enformSources = { clock: () => 1, ids: () => 'op-2' }`)
    const url = new URL('/app/', `http://127.0.0.1:${api.port()}`)
    url.searchParams.set('slug', SLUG)
    url.searchParams.set('instance', INSTANCE_ID)
    url.searchParams.set('actor', OKAFOR)
    await page.goto(url.toString())
    await page.waitForSelector(`[data-outcome="${OUTCOME}"]`, { timeout: 5000 })
    await body(page, api)
  } finally {
    await browser.close()
    await new Promise<void>((closed, rejected) =>
      api.server.close((error) => (error ? rejected(error) : closed()))
    )
  }
}

test.fails('#106 FM-4 the browser shows a server refusal at its control by path', async () => {
  await withTaskPage(async (page, api) => {
    const before = api.state().log.length
    await page.click(`[data-outcome="${OUTCOME}"]`)

    // The refusal names the field: the reason is in `.status` and the message
    // sits at the summary control, not in a general error line (FM-4).
    const error = page.locator('[data-error-for="summary"]')
    await error.waitFor({ timeout: 5000 })
    expect(await error.textContent()).toBe('is required')
    expect(await page.textContent('.status')).toContain('summary is required')

    // A refused completion appends nothing (FM-4, I1): the server log is
    // unchanged after a bounded wait.
    await page.waitForTimeout(250)
    expect(api.state().log.length).toBe(before)
  })
}, 30_000)

test.fails('#106 FM-4 the holder completes the step and the browser appends the engine operation', async () => {
  await withTaskPage(async (page, api) => {
    const before = api.state().log.length
    const instance = instanceOf(api.state().log, INSTANCE_ID)
    if (instance === undefined) throw new Error('the seed log holds no instance')
    const expected = complete(
      instance,
      OKAFOR,
      OUTCOME,
      values,
      instance.version ?? 0,
      {
        flow: SLUG,
        definition,
        grants,
        resolve,
      },
      sources
    )
    expect(expected.accepted).toBe(true)
    if (expected.operation === undefined) throw new Error(expected.reason)

    await page.fill('[name="summary"]', values.summary)
    await page.click(`[data-outcome="${OUTCOME}"]`)
    await waitForLog(api, before + 1)
    await page.waitForFunction(
      () => document.querySelector('.status')?.textContent === 'Step completed',
      undefined,
      { timeout: 5000 }
    )

    // Exactly one completion, and it is the engine's operation: the server
    // resolved the step, the transition and the grants (A9, ADR 0010).
    const appended = api.state().log.slice(before)
    expect(appended).toHaveLength(1)
    const event = appended[0]
    const operation: Operation = {
      id: event.operationId,
      type: event.type,
      at: event.at,
      actor: event.actor,
      payload: event.payload,
    }
    expect(operation).toEqual(expected.operation)
  })
}, 30_000)
