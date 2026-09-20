/** Initial Web drafts remain editable and durable without entering a model turn. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const EXPECTED_DIR = fileURLToPath(new URL('./expected/web-open-draft', import.meta.url))
const MODE = webSnapshotMode()
const SESSION_ID = SessionId('web-open-draft')
const INITIAL = 'Inspect the task before running.\n保留这段草稿。'
const EDITED = 'Review my edited task before running.\n只修改草稿。'
const COMPOSER = '[data-composer-input][contenteditable="true"]'

describe('web e2e: initial prompt draft lifecycle', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []
  let promptCalls = (): number => 0
  let restorePrompt = (): void => {}

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      if (session.id === SESSION_ID) events.push(event)
    })
    const prompt = vi.spyOn(scaffold.ctx.sessionController, 'prompt')
    promptCalls = () => prompt.mock.calls.length
    restorePrompt = () => { prompt.mockRestore() }
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await scaffold.ctx.sessionController.create({ sessionId: SESSION_ID, workspaceId: workspace.id })
    await scaffold.ctx.sessionController.setDraft({ sessionId: SESSION_ID, text: INITIAL })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    const url = new URL(scaffold.authenticatedUrl)
    url.searchParams.set('session', SESSION_ID)
    await page.goto(url.href, { waitUntil: 'load' })
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      restorePrompt()
      await scaffold?.close()
    }
  })

  it('loads the draft, persists edits across reload, and does not reseed cleared text', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-web-open-draft'))
    const composer = page.locator(COMPOSER).first()
    await composer.waitFor({ timeout: 30_000 })
    // Programmatic drafts render one paragraph per newline; innerText inserts extra paragraph separators.
    await expect.poll(() => composer.locator(':scope > p').allTextContents(), { timeout: 15_000 }).toEqual(INITIAL.split('\n'))
    expect(await scaffold.ctx.sessionController.getDraft({ sessionId: SESSION_ID })).toEqual({ text: INITIAL })
    const snapshots = ['# Initial draft', '', await captureStableAria(page, COMPOSER, scaffold.workspaceCwd)]

    await composer.fill(EDITED)
    await expect.poll(() => scaffold.ctx.sessionController.getDraft({ sessionId: SESSION_ID }), { timeout: 15_000 })
      .toEqual({ text: EDITED })
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => composer.locator(':scope > p').allTextContents(), { timeout: 15_000 }).toEqual(EDITED.split('\n'))
    snapshots.push('', '# Edited draft after reload', '', await captureStableAria(page, COMPOSER, scaffold.workspaceCwd))

    await scaffold.ctx.sessionController.setDraft({ sessionId: SESSION_ID, text: '' })
    await page.reload({ waitUntil: 'load' })
    await composer.waitFor({ timeout: 30_000 })
    await expect.poll(() => composer.textContent(), { timeout: 15_000 }).toBe('')
    expect(await scaffold.ctx.sessionController.getDraft({ sessionId: SESSION_ID })).toEqual({ text: '' })
    snapshots.push('', '# Host-cleared draft after reload', '', await captureStableAria(page, COMPOSER, scaffold.workspaceCwd))

    await composer.fill(EDITED)
    await expect.poll(() => scaffold.ctx.sessionController.getDraft({ sessionId: SESSION_ID }), { timeout: 15_000 })
      .toEqual({ text: EDITED })
    await composer.fill('')
    await expect.poll(() => scaffold.ctx.sessionController.getDraft({ sessionId: SESSION_ID }), { timeout: 15_000 })
      .toEqual({ text: '' })
    await page.reload({ waitUntil: 'load' })
    await composer.waitFor({ timeout: 30_000 })
    await expect.poll(() => scaffold.ctx.sessionController.getDraft({ sessionId: SESSION_ID }), { timeout: 15_000 })
      .toEqual({ text: '' })
    expect(await composer.textContent()).toBe('')
    snapshots.push('', '# Discarded draft after reload', '', await captureStableAria(page, COMPOSER, scaffold.workspaceCwd))

    expect(promptCalls()).toBe(0)
    expect(events.filter(event => event.type === 'user/message' || event.type === 'turn/start' || event.type === 'request/header')).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    snapshots.push('', '# Execution', '', 'Prompt requests: 0', 'User messages: 0', 'Turns started: 0', 'Model requests: 0')
    await compareOrRefreshGolden(join(EXPECTED_DIR, 'draft-lifecycle.expected.md'), snapshots.join('\n'), MODE)
    await assertFixtureInventory(EXPECTED_DIR, ['draft-lifecycle.expected.md'])
  })
})
