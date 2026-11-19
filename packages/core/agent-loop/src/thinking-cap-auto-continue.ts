/**
 * Per-Session auto-continue after a reasoning-only `max-tokens` stop.
 *
 * @module @deepseek-ai/dsh-agent-loop/thinking-cap-auto-continue
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** Model-visible followup text after a thinking-cap auto-continue. */
export const THINKING_CAP_AUTO_CONTINUE_TEXT = 'continue(auto)'

/** Consecutive reasoning-only auto-continues before the interrupt returns. */
export const THINKING_CAP_AUTO_CONTINUE_LIMIT = 2

/**
 * Host fold of the per-Session thinking-cap auto-continue policy and its live
 * stop streak. Host-only: clients read the wire view, a single boolean.
 */
export interface ThinkingCapAutoContinueState {
  /** Latest durable policy; `false` until an `{ enabled: true }` event. */
  readonly enabled: boolean
  /** Whether the latest assistant message is a reasoning-only output-cap stop. */
  readonly lastAssistantIsThinkingCapStop: boolean
  /** How many consecutive prior max-tokens turns were auto-continued. */
  readonly consecutiveAutoContinues: number
  /** Whether the latest `turn/end` was `max-tokens` and still awaits the next user message. */
  readonly pendingMaxTokens: boolean
}

const stateSchema = z.object({
  enabled: z.boolean(),
  lastAssistantIsThinkingCapStop: z.boolean(),
  consecutiveAutoContinues: z.number().int().nonnegative(),
  pendingMaxTokens: z.boolean(),
})

const INITIAL_STATE: ThinkingCapAutoContinueState = {
  enabled: false,
  lastAssistantIsThinkingCapStop: false,
  consecutiveAutoContinues: 0,
  pendingMaxTokens: false,
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Host followup after a reasoning-only thinking-cap stop. */
    'thinking-cap-auto-continue': { kind: 'thinking-cap-auto-continue' }
  }
}

/** Host fold of the durable thinking-cap auto-continue policy. */
export const thinkingCapAutoContinueProjectionDefinition = {
  key: 'thinkingCapAutoContinue',
  stateVersion: 1,
  stateSchema,
  init: () => INITIAL_STATE,
  apply: applyThinkingCapAutoContinue,
  wire: {
    viewSchema: z.boolean(),
    view: (state: ThinkingCapAutoContinueState) => state.enabled,
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
      return { ...state, lastAssistantIsThinkingCapStop: isThinkingCapStop(event.data.message) }
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
        ? { ...state, pendingMaxTokens: false, consecutiveAutoContinues: state.consecutiveAutoContinues + 1 }
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
 * @param state - folded policy and streak for this Session.
 * @returns `true` when the policy, last assistant content, inbox, and cap agree.
 */
export function shouldFollowupThinkingCap(agent: Agent, state: ThinkingCapAutoContinueState): boolean {
  if (!state.enabled) return false
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
 * @param handle - the already-registered policy fold this listener reads.
 * @returns disposer that removes the listener.
 */
export function installThinkingCapAutoContinueListener(
  ctx: Context,
  handle: ProjectionHandle<ThinkingCapAutoContinueState>,
): () => void {
  return ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      if (!shouldFollowupThinkingCap(agent, handle.stateOf(agent.session))) return
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
