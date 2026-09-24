/** Draft storage survives controller disposal without activating cold Sessions. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { describe, expect, it, vi } from 'vitest'
import SessionController from '../src/index.ts'
import { SessionDraftController } from '../src/drafts.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const sessionId = SessionId('draft-cold')

async function harness(root: string, open = true) {
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/workspace' }
    const inspect = vi.fn(async () => ({ meta: header, events: [] }))
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header],
      inspect,
    }) as never)
    installSessionReadTestServices(ctx)
    const drafts = new SessionDraftController(ctx)
    if (open) await drafts.open()
    return { ctx, drafts, inspect }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

describe('durable Session composer drafts', () => {
  it('opens storage before publishing the Host API and releases it on plugin reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-drafts-'))
    const { ctx } = await harness(root, false)
    try {
      ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } as never)
      ctx.provide('attachments', {} as never)
      ctx.provide('fileUploads', { registerAgentResolver: () => () => {} } as never)
      ctx.provide('llm', {} as never)
      ctx.provide('typert', {
        lookups: { configure: () => () => {} },
        contexts: { configureHost: () => () => {} },
      } as never)
      ctx.provide('workspaceRegistry', {} as never)
      const owner = await ctx.plugin(SessionController, {})
      await expect(ctx.sessionController.setDraft({ sessionId, text: 'mounted draft' }))
        .resolves.toEqual({ text: 'mounted draft' })
      await expect(ctx.sessionController.getDraft({ sessionId })).resolves.toEqual({ text: 'mounted draft' })
      await owner.dispose()
      expect(ctx.get('sessionController')).toBeUndefined()
      await ctx.plugin(SessionController, {})
      await expect(ctx.sessionController.getDraft({ sessionId })).resolves.toEqual({ text: 'mounted draft' })
      expect(ctx.agents.get(sessionId)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains exact edits across reload, then deletes empty drafts without a transcript or Agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-drafts-'))
    const first = await harness(root)
    try {
      await expect(first.drafts.get({ sessionId })).resolves.toEqual({ text: '' })
      await expect(first.drafts.set({ sessionId, text: 'initial' })).resolves.toEqual({ text: 'initial' })
      const text = '修改\n' + 'long prompt '.repeat(20_000) + '\n'
      await expect(first.drafts.set({ sessionId, text })).resolves.toEqual({ text })
      expect(JSON.parse(await readFile(join(root, 'session_composer_drafts', 'drafts', `${sessionId}.json`), 'utf8')))
        .toEqual({ version: 1, record: { text } })
      expect(first.ctx.agents.get(sessionId)).toBeUndefined()
      expect(first.ctx.sessions.get(sessionId)).toBeUndefined()
      expect(first.inspect).toHaveBeenCalled()
      await first.ctx.fiber.dispose()

      const second = await harness(root)
      try {
        await expect(second.drafts.get({ sessionId })).resolves.toEqual({ text })
        await expect(second.drafts.set({ sessionId, text: '' })).resolves.toEqual({ text: '' })
        await expect(second.drafts.get({ sessionId })).resolves.toEqual({ text: '' })
        await expect(readFile(join(root, 'session_composer_drafts', 'drafts', `${sessionId}.json`)))
          .rejects.toMatchObject({ code: 'ENOENT' })
        expect(second.ctx.agents.get(sessionId)).toBeUndefined()
        expect(second.ctx.sessions.get(sessionId)).toBeUndefined()
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      await first.ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects unknown Sessions and preserves storage faults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-drafts-'))
    const { ctx, drafts } = await harness(root)
    try {
      const unknown = SessionId('missing-draft')
      await expect(drafts.get({ sessionId: unknown })).rejects.toMatchObject({ code: 'session/not-found' })
      await expect(drafts.set({ sessionId: unknown, text: 'not stored' })).rejects.toMatchObject({ code: 'session/not-found' })
      const failure = new Error('cold storage unavailable')
      vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValueOnce(failure)
      await expect(drafts.set({ sessionId, text: 'not stored' })).rejects.toBe(failure)
      await expect(drafts.get({ sessionId })).resolves.toEqual({ text: '' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves whitespace drafts and rejects operations after storage disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-drafts-'))
    const { ctx, drafts } = await harness(root)
    try {
      await drafts.set({ sessionId, text: '  \n' })
      await expect(drafts.get({ sessionId })).resolves.toEqual({ text: '  \n' })
      await ctx.fiber.dispose()
      await expect(drafts.set({ sessionId, text: 'late' })).rejects.toBeDefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
