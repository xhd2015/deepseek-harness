/** Durable composer drafts, text and pending images, separate from Session transcript events. */

import { AttachmentId, admitEncodedImages, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { SessionDraftRequest, SessionDraftValue, SessionSetDraftRequest } from './types.ts'

// `attachments` is optional so a record written before images existed still
// reads: a missing list is a draft with no pending images.
const imageRefRecord = z.object({
  attachmentId: z.string(),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  name: z.string().optional(),
  originalDimensions: z.object({ width: z.number(), height: z.number() }).optional(),
})
const draftRecord = z.object({
  text: z.string(),
  attachments: z.array(imageRefRecord).optional(),
})
/**
 * One stored draft, as the schema parses it. `attachments` is absent on records
 * written before images existed, so an old record still reads.
 */
type DraftRecord = z.infer<typeof draftRecord>

/** A stored record as the wire value, re-branding each id the store issued. */
function draftValue(record: DraftRecord): SessionDraftValue {
  return {
    text: record.text,
    ...(record.attachments === undefined ? {} : {
      attachments: record.attachments.map((ref): ImageAttachmentRef => ({
        attachmentId: AttachmentId(ref.attachmentId),
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
        ...(ref.originalDimensions === undefined ? {} : { originalDimensions: ref.originalDimensions }),
      })),
    }),
  }
}

const draftDomain = defineDomain({
  name: 'session_composer_drafts',
  version: 1,
  layout: 'per-record',
  tables: { drafts: domainTable<SessionId, DraftRecord>(draftRecord) },
})

/** Cold Session validation and durable last-write-wins composer text. */
export class SessionDraftController {
  private table?: KvTable<SessionId, DraftRecord>

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
    const stored = this.requireTable().get(request.sessionId)
    return stored === undefined ? { text: '' } : draftValue(stored)
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
    if (request.text === '' && (request.images ?? []).length === 0) {
      await table.delete(request.sessionId)
      return { text: '' }
    }
    // Admit the bytes before touching the record, so a refused image cannot
    // leave a draft that claims an attachment the store does not hold.
    const admitted = (request.images ?? []).length === 0
      ? []
      : await admitEncodedImages(this.requireAttachments(), request.images ?? [])
    const record: DraftRecord = {
      text: request.text,
      ...(admitted.length === 0 ? {} : {
        attachments: admitted.map(ref => ({
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
          ...(ref.originalDimensions === undefined ? {} : { originalDimensions: ref.originalDimensions }),
        })),
      }),
    }
    // No text and no images is a cleared draft, not a stored empty one.
    if (record.text === '' && admitted.length === 0) await table.delete(request.sessionId)
    else await table.put(request.sessionId, record)
    return draftValue(record)
  }

  private requireAttachments() {
    return this.ctx.attachments
  }

  private requireTable(): KvTable<SessionId, DraftRecord> {
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
