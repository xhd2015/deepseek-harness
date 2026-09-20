/** Durable text-only composer drafts, separate from Session transcript events. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { SessionDraftRequest, SessionDraftValue, SessionSetDraftRequest } from './types.ts'

const draftRecord = z.object({ text: z.string() })
const draftDomain = defineDomain({
  name: 'session_composer_drafts',
  version: 1,
  layout: 'per-record',
  tables: { drafts: domainTable<SessionId, SessionDraftValue>(draftRecord) },
})

/** Cold Session validation and durable last-write-wins composer text. */
export class SessionDraftController {
  private table?: KvTable<SessionId, SessionDraftValue>

  /** @param ctx - Host context carrying storage domains and cold Session queries. */
  constructor(private readonly ctx: Context) {}

  /** Open the draft domain and bind its drain-and-close operation to plugin disposal. */
  async open(): Promise<void> {
    const domain = await this.ctx.storageDomain.open(draftDomain)
    this.ctx.effect(() => () => domain.close(), 'session-controller.drafts')
    this.table = domain.table('drafts')
  }

  /**
   * Read one draft without resuming its Agent.
   * @param request - Session identity.
   * @returns saved text, or empty text when no draft is stored.
   * @throws RemoteError when the Session is unknown.
   */
  async get(request: SessionDraftRequest): Promise<SessionDraftValue> {
    await this.requireSession(request.sessionId)
    return this.requireTable().get(request.sessionId) ?? { text: '' }
  }

  /**
   * Replace one draft durably without changing the transcript or activating an Agent.
   * Concurrent writes are last-write-wins; callers serialize dependent edits.
   * @param request - Session identity and exact text; empty text deletes the record.
   * @returns the text after this write reaches durable storage.
   * @throws RemoteError when the Session is unknown.
   */
  async set(request: SessionSetDraftRequest): Promise<SessionDraftValue> {
    await this.requireSession(request.sessionId)
    const table = this.requireTable()
    if (request.text === '') await table.delete(request.sessionId)
    else await table.put(request.sessionId, { text: request.text })
    return { text: request.text }
  }

  private requireTable(): KvTable<SessionId, SessionDraftValue> {
    if (this.table === undefined) throw new Error('session composer draft storage is not open')
    return this.table
  }

  private async requireSession(sessionId: SessionId): Promise<void> {
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
      void observation
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw error
    }
  }
}
