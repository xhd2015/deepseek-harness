// Web e2e scenario: a document opened on a well-formed `?session=<id>` starts
// focused — the frame's first rendered geometry is the rail, with no later
// collapse — while a document without a usable parameter keeps the default
// frame. The sidebar is decided from the query alone, before the Host list
// settles, so the scenario does not need the id to resolve; that is also why an
// unlisted id is covered here as a deliberate outcome.
//
// This scaffold has no Workspaces, so its plain documents select nothing: the
// seeded Session is what makes a listed id available at all.
//
// Zero model calls: the seeded Session is never prompted. The assertions read
// the frame's collapsed attribute and every column width the frame ever
// rendered, recorded from document start so an after-paint collapse cannot hide.
import { randomUUID } from 'node:crypto'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishContext, saveFailureShot } from './support.ts'

/** The frame element, used as the application-mounted barrier. */
const FRAME = '[class*="frame"]'
/** The frame while its sidebar is collapsed (ui-layout's own state attribute). */
const COLLAPSED = '[data-sidebar-collapsed="true"]'
/** The rail's leading track, and the default sidebar's. */
const RAIL_PREFIX = '56px'
const EXPANDED_PREFIX = '280px'
/**
 * Settling window for a document whose URL names no usable Session. The deep
 * link resolves as soon as the Host list lands, which the collapsing case below
 * proves happens well inside this window; this only has to outlast it.
 */
const SETTLE_MS = 5_000

/** Record every distinct sidebar track the frame renders, from document start. */
function recordFrameColumns(): void {
  const columns: string[] = []
  ;(globalThis as { __dshFrameColumns?: string[] }).__dshFrameColumns = columns
  const record = (): void => {
    const frame = document.querySelector<HTMLElement>('[class*="frame"]')
    const value = frame?.style.gridTemplateColumns ?? ''
    if (value !== '' && columns[columns.length - 1] !== value) columns.push(value)
  }
  // The Document node exists before the frame does, so this can start here
  // rather than waiting for a parsed documentElement.
  new MutationObserver(record).observe(document, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['style'],
  })
}

/** RpcResult envelope shared by the Host's client-request endpoints. */
interface RpcEnvelope<T> {
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
}

/**
 * Create one durable Session through the shipped Host API.
 * @param target - booted scaffold owning the authenticated Host.
 * @returns the created Session id.
 */
async function createSession(target: WebScaffold): Promise<string> {
  const response = await target.hostFetch('/api/session/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `deep-link-${randomUUID()}`,
      method: 'session/create',
      payload: { args: { request: { cwd: target.workspaceCwd } } },
    }),
  })
  if (!response.ok) throw new Error(`session/create failed over HTTP ${response.status}: ${await response.text()}`)
  const result = (await response.json() as RpcEnvelope<{ sessionId: string }>).result
  if (!result.ok) throw new Error(`session/create failed: ${result.error.code}: ${result.error.message}`)
  return result.value.sessionId
}

describe('web e2e: a deep-linked Session opens with the sidebar collapsed', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let context: BrowserContext
  let origin: string
  let sessionId: string

  /**
   * Open one scenario page in the authenticated context, recording frame
   * geometry from document start.
   * @param url - document URL to open.
   * @returns the page and its console tripwire.
   */
  async function openPage(url: string): Promise<{ page: Page; tripwire: ReturnType<typeof watchConsole> }> {
    const page = await context.newPage()
    const tripwire = watchConsole(page)
    await page.addInitScript(recordFrameColumns)
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForSelector(FRAME, { timeout: 30_000 })
    return { page, tripwire }
  }

  /** Every distinct sidebar track this document rendered, oldest first. */
  async function observedColumns(page: Page): Promise<string[]> {
    return await page.evaluate((): string[] =>
      (globalThis as { __dshFrameColumns?: string[] }).__dshFrameColumns ?? [])
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    origin = scaffold.baseUrl
    sessionId = await createSession(scaffold)
    // One context: the token exchange runs once in its first page, and every
    // scenario page below reuses the browser session cookie it establishes.
    context = await newEnglishContext(browser)
    const authenticated = await context.newPage()
    await authenticated.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await authenticated.waitForSelector(FRAME, { timeout: 30_000 })
    await authenticated.close()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders the rail from the first frame for a URL naming a listed Session', async () => {
    const { page, tripwire } = await openPage(`${origin}/?session=${encodeURIComponent(sessionId)}`)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deep-link-collapsed'))
    try {
      await page.locator(COLLAPSED).waitFor({ state: 'attached', timeout: 30_000 })
      const columns = await observedColumns(page)
      expect(columns.length).toBeGreaterThan(0)
      expect(columns.every(value => value.startsWith(RAIL_PREFIX))).toBe(true)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('renders the rail from the first frame for a well-formed unlisted id', async () => {
    const { page, tripwire } = await openPage(`${origin}/?session=session-missing-deep-link`)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deep-link-unlisted'))
    try {
      await page.locator(COLLAPSED).waitFor({ state: 'attached', timeout: 30_000 })
      const columns = await observedColumns(page)
      expect(columns.every(value => value.startsWith(RAIL_PREFIX))).toBe(true)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps the default frame for a document without a Session in its URL', async () => {
    const { page, tripwire } = await openPage(`${origin}/`)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deep-link-absent'))
    try {
      await page.waitForTimeout(SETTLE_MS)
      expect(await page.locator(COLLAPSED).count()).toBe(0)
      const columns = await observedColumns(page)
      expect(columns.length).toBeGreaterThan(0)
      expect(columns.every(value => value.startsWith(EXPANDED_PREFIX))).toBe(true)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps the default frame for a malformed id', async () => {
    const { page, tripwire } = await openPage(`${origin}/?session=a&session=b`)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deep-link-malformed'))
    try {
      await page.waitForTimeout(SETTLE_MS)
      expect(await page.locator(COLLAPSED).count()).toBe(0)
      const columns = await observedColumns(page)
      expect(columns.every(value => value.startsWith(EXPANDED_PREFIX))).toBe(true)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)
})
