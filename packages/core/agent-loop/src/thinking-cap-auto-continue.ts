/**
 * Per-Session auto-continue after a reasoning-only `max-tokens` stop.
 *
 * @module @deepseek-ai/dsh-agent-loop/thinking-cap-auto-continue
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ThinkingCapAutoContinueState } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  errorChain,
  type AssistantMessage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'

/** Model-visible followup text after a thinking-cap auto-continue. */
export const THINKING_CAP_AUTO_CONTINUE_TEXT = 'continue(auto)'

/** Consecutive reasoning-only auto-continues before the interrupt returns. */
export const THINKING_CAP_AUTO_CONTINUE_LIMIT = 2

const thinkingCapAutoContinueStateSchema: zod.ZodType<ThinkingCapAutoContinueState> = zod.object({
  enabled: zod.boolean(),
  lastAssistantIsThinkingCapStop: zod.boolean(),
  consecutiveAutoContinues: zod.number().int().nonnegative(),
  pendingMaxTokens: zod.boolean(),
})

const thinkingCapAutoContinueViewSchema = zod.boolean()

const INITIAL_STATE: ThinkingCapAutoContinueState = {
  enabled: false,
  lastAssistantIsThinkingCapStop: false,
  consecutiveAutoContinues: 0,
  pendingMaxTokens: false,
}

/** Host fold of the durable thinking-cap auto-continue policy. */
export const thinkingCapAutoContinueProjectionDefinition = {
  key: 'thinkingCapAutoContinue',
  stateVersion: 1,
  stateSchema: thinkingCapAutoContinueStateSchema,
  init: () => INITIAL_STATE,
  apply: applyThinkingCapAutoContinue,
  wire: {
    viewSchema: thinkingCapAutoContinueViewSchema,
    view: state => state.enabled,
  },
} satisfies ProjectionDefinition<'thinkingCapAutoContinue', ThinkingCapAutoContinueState>

/**
 * Advance thinking-cap auto-continue fold state by one Session event.
 * @param state - fold state before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced fold state.
 */
export function applyThinkingCapAutoContinue(
  state: ThinkingCapAutoContinueState,
  event: SessionEvent,
): ThinkingCapAutoContinueState {
  switch (event.type) {
    case 'session/thinking-cap-auto-continue':
      return state.enabled === event.data.enabled ? state : { ...state, enabled: event.data.enabled }
    case 'assistant/message':
      return {
        ...state,
        lastAssistantIsThinkingCapStop: isThinkingCapStop(event.data.message),
      }
    case 'turn/end':
      return event.data.reason.kind === 'max-tokens'
        ? { ...state, pendingMaxTokens: true }
        : { ...state, pendingMaxTokens: false, consecutiveAutoContinues: 0 }
    case 'user/message':
      if (!state.pendingMaxTokens) {
        return isThinkingCapAutoContinueMessage(event.data)
          ? state
          : { ...state, consecutiveAutoContinues: 0 }
      }
      return isThinkingCapAutoContinueMessage(event.data)
        ? {
          ...state,
          pendingMaxTokens: false,
          consecutiveAutoContinues: state.consecutiveAutoContinues + 1,
        }
        : { ...state, pendingMaxTokens: false, consecutiveAutoContinues: 0 }
    default:
      return state
  }
}

/**
 * Whether an assistant message is a thinking-only output-cap stop.
 * @param message - last assistant message of the stopping step.
 * @returns `true` when reasoning is present and nothing visible remains.
 */
export function isThinkingCapStop(message: AssistantMessage): boolean {
  const hasVisible = message.content.some((block) => {
    if (block.type === 'reasoning') return false
    if (block.type === 'text') return block.text.trim().length > 0
    return true
  })
  return !hasVisible && message.content.some(block => block.type === 'reasoning')
}

/**
 * Whether the stopping turn should queue `continue(auto)` as the next turn.
 * @param agent - live Agent whose turn is about to close.
 * @returns `true` when the policy, last assistant content, inbox, and cap agree.
 */
export function shouldFollowupThinkingCap(agent: Agent): boolean {
  const state = agent.ctx.sessionProjections.stateOf(agent.session, 'thinkingCapAutoContinue')
  if (state === undefined || !state.enabled) return false
  if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) return false
  if (!state.lastAssistantIsThinkingCapStop) return false
  return state.consecutiveAutoContinues < THINKING_CAP_AUTO_CONTINUE_LIMIT
}

/**
 * Build the model-visible auto-continue followup.
 * @returns a user message whose text is {@link THINKING_CAP_AUTO_CONTINUE_TEXT}.
 */
export function createThinkingCapAutoContinueMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: THINKING_CAP_AUTO_CONTINUE_TEXT }],
    source: { kind: 'thinking-cap-auto-continue' },
  })
}

/**
 * Follow up a reasoning-only `max-tokens` stop from `agent/turn-stopping`.
 * @param ctx - AgentLoop service context that receives every Agent's stopping event.
 * @returns disposer that removes the listener.
 */
export function installThinkingCapAutoContinue(ctx: Context): () => void {
  return ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      if (!shouldFollowupThinkingCap(agent)) return
      agent.followup(createThinkingCapAutoContinueMessage())
    } catch (error: unknown) {
      ctx.logger.warn(`agent-loop: thinking-cap auto-continue failed: ${errorChain(error)}`)
    }
  })
}

function isThinkingCapAutoContinueMessage(message: UserMessage): boolean {
  const block = message.content[0]
  return message.source.kind === 'thinking-cap-auto-continue'
    && message.content.length === 1
    && block?.type === 'text'
    && block.text === THINKING_CAP_AUTO_CONTINUE_TEXT
}
