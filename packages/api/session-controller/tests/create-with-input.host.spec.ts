/**
 * Creating a Session with its first input already in place.
 *
 * The feature exists so a caller never has to make two RPCs and invent an answer
 * for "the Session exists but the input did not land". These tests hold that
 * shape: the input is written through the same paths `setDraft` and `prompt`
 * use, so a Session created here is indistinguishable from one created and then
 * given input, and a failure keeps the Session rather than leaking or faking.
 */

import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { describe, expect, it, vi } from 'vitest'
import SessionController from '../src/index.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const sessionId = SessionId('create-with-input')
/** A real 1x1 PNG: admission inspects the bytes, so a placeholder would be refused. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** The mounted service, with the Sessions it may be asked to reuse. */
async function harness(root: string, headers: readonly SessionHeader[] = []) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  await ctx.plugin(AgentRegistry)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: async () => [...headers],
    inspect: async () => ({ meta: headers[0], events: [] }),
  }) as never)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture' }),
  } as never)
  // The real store: admission validates and commits the bytes, so a test that
  // reads the image back is proving storage rather than a mock's return value.
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'dsh-home') })
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, bindPrompt: () => ({ commit: () => {} }) } as never)
  ctx.provide('llm', { resolveCallConfig: async () => ({}), resolveModelInfo: async () => ({}) } as never)
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
    resources: { register: () => () => {} },
  } as never)
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [], archivedSessionIds: [] } as never)
  // Creation canonicalizes its directory through `fs`; these tests use real
  // temporary paths, so the identity mapping is the honest stub.
  ctx.provide('fs', {
    resolve: async (target: string) => ({ kind: 'native', path: target }),
    processPath: (target: { path?: string }) => target.path ?? '',
  } as never)
  ctx.provide('remoteAccess', { allows: () => true } as never)
  ctx.provide('typertGateway', { getPendingRemoteEvents: () => [] } as never)
  return ctx
}

async function withService(
  run: (ctx: Context, cwd: string) => Promise<void>,
  headers: readonly SessionHeader[] = [],
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-create-with-input-'))
  // Creation ensures its cwd exists, so the Session's directory is a real one.
  const cwd = join(root, 'workspace')
  await mkdir(cwd, { recursive: true })
  const ctx = await harness(root, headers)
  try {
    await ctx.plugin(SessionController, {})
    // Creation itself is covered by commands-create-fork; these tests are about
    // what happens to the input afterwards. Publishing a real Session keeps the
    // draft write and prompt admission running against real storage.
    const commands = (ctx.sessionController as unknown as { commands: { create: (input: unknown) => Promise<unknown> } }).commands
    vi.spyOn(commands, 'create').mockImplementation(async () => {
      ctx.sessions.create(sessionId, { meta: { cwd } })
      return { sessionId }
    })
    await run(ctx, cwd)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

describe('creating a Session with its first input', () => {
  it('leaves a draft in the composer without submitting anything', async () => {
    await withService(async (ctx, cwd) => {
      const created = await ctx.sessionController.createWithInput({
        cwd,
        sessionId,
        draft: 'staged, not sent',
      }, new AbortController().signal)

      expect(created).toEqual({ sessionId })
      await expect(ctx.sessionController.getDraft({ sessionId })).resolves.toEqual({ text: 'staged, not sent' })
      // A draft is not a turn: the transcript holds no user message.
      const events = ctx.sessions.get(sessionId)?.events ?? []
      expect(events.filter(event => event.type === 'user/message')).toHaveLength(0)
    })
  })

  it('creates a Session with no input at all when neither is named', async () => {
    await withService(async (ctx, cwd) => {
      const created = await ctx.sessionController.createWithInput({ cwd, sessionId }, new AbortController().signal)
      expect(created).toEqual({ sessionId })
      await expect(ctx.sessionController.getDraft({ sessionId })).resolves.toEqual({ text: '' })
    })
  })

  it('refuses a draft and a prompt together instead of picking one', async () => {
    await withService(async (ctx, cwd) => {
      // Which of the two ran would otherwise be a thing every caller remembers.
      await expect(ctx.sessionController.createWithInput({
        cwd,
        sessionId,
        draft: 'left behind',
        prompt: 'sent now',
      }, new AbortController().signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    })
  })

  it('refuses images without a prompt: an image is part of a message', async () => {
    await withService(async (ctx, cwd) => {
      await expect(ctx.sessionController.createWithInput({
        cwd,
        sessionId,
        images: [{ mediaType: 'image/png', data: 'AAAA' }],
      }, new AbortController().signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    })
  })

  it('keeps the created Session when the draft cannot be written', async () => {
    await withService(async (ctx, cwd) => {
      vi.spyOn(ctx.sessionController, 'getDraft')
      const failure = new Error('storage went away')
      const drafts = (ctx.sessionController as unknown as { drafts: { set: (input: unknown) => Promise<unknown> } }).drafts
      vi.spyOn(drafts, 'set').mockRejectedValueOnce(failure)

      const created = await ctx.sessionController.createWithInput({
        cwd,
        sessionId,
        draft: 'nowhere to put it',
      }, new AbortController().signal)

      // The identity is published and the caller keeps it to retry the input;
      // the failure is reported rather than swallowed or rolled back.
      expect(created.sessionId).toBe(sessionId)
      expect(created.inputError).toContain('storage went away')
    })
  })

  it('reports a refused prompt without discarding the Session', async () => {
    await withService(async (ctx, cwd) => {
      vi.spyOn(ctx.sessionController, 'prompt').mockRejectedValueOnce(new Error('agent busy'))

      const created = await ctx.sessionController.createWithInput({
        cwd,
        sessionId,
        prompt: 'take this',
      }, new AbortController().signal)

      expect(created.sessionId).toBe(sessionId)
      expect(created.inputError).toContain('agent busy')
    })
  })

  it('honours cancellation before any input is written', async () => {
    await withService(async (ctx, cwd) => {
      const controller = new AbortController()
      controller.abort()
      await expect(ctx.sessionController.createWithInput({
        cwd,
        sessionId,
        draft: 'too late',
      }, controller.signal)).rejects.toBeDefined()
      expect(ctx.agents.get(sessionId)).toBeUndefined()
    })
  })
})

describe('a draft that carries images', () => {
  it('stores the pixels and leaves them pending, with nothing submitted', async () => {
    await withService(async (ctx, cwd) => {
      const created = await ctx.sessionController.createWithInput({
        cwd,
        sessionId,
        draft: 'look at these before you start',
        draftImages: [{ mediaType: 'image/png', data: PNG_1X1, name: 'shot.png' }],
      }, new AbortController().signal)

      expect(created).toEqual({ sessionId })
      const draft = await ctx.sessionController.getDraft({ sessionId })
      expect(draft.text).toBe('look at these before you start')
      expect(draft.attachments).toHaveLength(1)
      const ref = draft.attachments?.[0]
      expect(ref?.mediaType).toBe('image/png')
      expect(ref?.name).toBe('shot.png')
      // The bytes the reader will see are the bytes that were admitted.
      const stored = await ctx.attachments.readImage(ref!)
      expect(Buffer.from(stored.data).equals(Buffer.from(PNG_1X1, 'base64'))).toBe(true)
      // A draft admits no prompt, so the transcript still holds no message.
      const events = ctx.sessions.get(sessionId)?.events ?? []
      expect(events.filter(event => event.type === 'user/message')).toHaveLength(0)
    })
  })

  it('reports an image the store refuses, leaving no draft behind', async () => {
    await withService(async (ctx, cwd) => {
      const created = await ctx.sessionController.createWithInput({
        cwd,
        sessionId,
        draft: 'not canonical base64',
        draftImages: [{ mediaType: 'image/png', data: 'not base64!' }],
      }, new AbortController().signal)
      // The Session exists and is kept; the input failed, so the caller retries
      // the input against this id rather than creating a second Session.
      expect(created.sessionId).toBe(sessionId)
      expect(created.inputError).toContain('base64')
      // The bytes were admitted before the record was written, so no draft
      // claims an image the store refused.
      await expect(ctx.sessionController.getDraft({ sessionId })).resolves.toEqual({ text: '' })
    })
  })

  it('submits prompt images as admitted attachments', async () => {
    await withService(async (ctx, cwd) => {
      const prompt = vi.spyOn(ctx.sessionController, 'prompt')
      await ctx.sessionController.createWithInput({
        cwd,
        sessionId,
        prompt: 'look at this',
        images: [{ mediaType: 'image/png', data: PNG_1X1 }],
      }, new AbortController().signal)
      const content = prompt.mock.calls[0]?.[0].content ?? []
      expect(content.map(part => part.type)).toEqual(['text', 'image'])
      await expect(ctx.sessionController.getDraft({ sessionId })).resolves.toEqual({ text: '' })
    })
  })
})
