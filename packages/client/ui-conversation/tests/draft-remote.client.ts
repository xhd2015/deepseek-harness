/** Session text-draft Remote fixture for composer assembly tests. */
import type { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Install an instance-local durable-draft stand-in.
 * @param runtime - owning test context.
 * @returns records retained across composer remounts in this fixture.
 */
export function installDraftRemote(runtime: SlotTestRuntime): Map<SessionId, string> {
  const drafts = new Map<SessionId, string>()
  const session = {
    getDraft: async ({ sessionId }: { sessionId: SessionId }) => ({
      ok: true, value: { text: drafts.get(sessionId) ?? '' },
    }),
    setDraft: async ({ sessionId, text }: { sessionId: SessionId; text: string }) => {
      drafts.set(sessionId, text)
      return { ok: true, value: { text } }
    },
  }
  runtime.remote.provideNamespaces({ session })
  return drafts
}
