/**
 * Tool-pairing balance over a session surface. Compaction changes surface
 * positions, so safe cuts snap in current surface order. `step/end` closes
 * leftover tool-calls of that ended step so they do not freeze later cuts.
 * @module @deepseek-ai/dsh-compaction/tool-pairing
 */

import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'

/** Incremental balance state for one session surface generation. */
interface BalanceCache {
  /** Surface rewrite generation this state describes. */
  generation: number
  /**
   * Balance of every surface cut in current order: a surface of N sequences has
   * N + 1 cuts, entry `i` being the cut before sequence `i` and the final entry
   * the cut after the surface tail.
   */
  cutBalanced: readonly boolean[]
  /** Current surface position of each event seq, indexing {@link cutBalanced}. */
  indexBySeq: Map<SessionSeq, number>
  /** In-progress tool-call count after the processed surface tail. */
  inProgressToolCalls: number
  /** Unanswered tool-call count keyed by `turn:step`. */
  leftoverByStep: Map<string, number>
}

const balanceCacheBySession = new WeakMap<Session, BalanceCache>()

/** Stable map key for one turn/step pair. */
function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

/** Turn/step of a surface event that participates in pairing, if any. */
function stepKeyOf(event: SessionEvent): string | undefined {
  switch (event.type) {
    case 'assistant/message':
    case 'tool/result':
      return stepKey(event.data.turn, event.data.step)
    default:
      return undefined
  }
}

/**
 * Apply one surface event to per-step leftover counts.
 * @returns the change in the global in-progress count.
 */
function applyDelta(event: SessionEvent, leftoverByStep: Map<string, number>): number {
  switch (event.type) {
    case 'assistant/message': {
      const n = event.data.message.content.filter(block => block.type === 'tool-call').length
      if (n === 0) return 0
      const key = stepKey(event.data.turn, event.data.step)
      leftoverByStep.set(key, (leftoverByStep.get(key) ?? 0) + n)
      return n
    }
    case 'tool/result': {
      const key = stepKey(event.data.turn, event.data.step)
      leftoverByStep.set(key, (leftoverByStep.get(key) ?? 0) - 1)
      return -1
    }
    default:
      return 0
  }
}

/**
 * Whether `step/end` for this turn/step appears in the log after `afterSeq`
 * and before `untilSeq` (exclusive). `untilSeq` omitted means through the
 * current log tail. Does not read `untilSeq` itself.
 */
function logHasStepEnd(
  session: Session,
  afterSeq: SessionSeq,
  untilSeq: SessionSeq | undefined,
  turn: number,
  step: number,
): boolean {
  for (let cursor = Number(afterSeq) + 1; ; cursor += 1) {
    if (untilSeq !== undefined && cursor >= Number(untilSeq)) return false
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(cursor))
    if (event === undefined) return false
    if (event.type === 'step/end' && event.data.turn === turn && event.data.step === step) return true
  }
}

/**
 * Close leftover counts for steps whose `step/end` appears after `afterSeq`
 * and before `untilSeq`. Updates the cut after the last folded surface node
 * when any leftover is dropped. No log reads when nothing is in progress.
 */
function closeEndedStepsFromLog(
  session: Session,
  cache: BalanceCache,
  afterSeq: SessionSeq,
  untilSeq: SessionSeq | undefined,
): void {
  if (cache.inProgressToolCalls === 0) return
  let closed = false
  for (let cursor = Number(afterSeq) + 1; ; cursor += 1) {
    if (untilSeq !== undefined && cursor >= Number(untilSeq)) break
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(cursor))
    if (event === undefined) break
    if (event.type !== 'step/end') continue
    const key = stepKey(event.data.turn, event.data.step)
    const leftover = cache.leftoverByStep.get(key) ?? 0
    if (leftover <= 0) continue
    cache.inProgressToolCalls -= leftover
    cache.leftoverByStep.set(key, 0)
    closed = true
  }
  if (!closed || cache.cutBalanced.length === 0) return
  cache.cutBalanced = cache.cutBalanced.with(
    cache.cutBalanced.length - 1,
    cache.inProgressToolCalls === 0,
  )
}

/** Empty cache for a rebuild of the current replace generation. */
function emptyCache(generation: number): BalanceCache {
  return {
    generation,
    cutBalanced: [true],
    indexBySeq: new Map(),
    inProgressToolCalls: 0,
    leftoverByStep: new Map(),
  }
}

/** Fold surface sequences not yet in the cache into its balance state. */
function extendCache(
  session: Session,
  cache: BalanceCache,
  seqs: readonly SessionSeq[],
): BalanceCache {
  const processed = cache.cutBalanced.length - 1
  const tail = seqs.slice(processed)
  // Validate the unseen tail before mutating the live cache, so a corrupt
  // append cannot leave a partially advanced state behind.
  const tailEvents: SessionEvent[] = []
  for (const seq of tail) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(seq)
    if (event === undefined || event.seq !== seq) {
      throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    tailEvents.push(event)
  }
  const lastLocalByStep = new Map<string, number>()
  for (const [index, event] of tailEvents.entries()) {
    const key = stepKeyOf(event)
    if (key !== undefined) lastLocalByStep.set(key, index)
  }

  const pendingCuts: boolean[] = []
  let inProgressToolCalls = cache.inProgressToolCalls
  const leftoverByStep = new Map(cache.leftoverByStep)
  for (const [index, event] of tailEvents.entries()) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- tailEvents is built from tail
    const seq = tail[index]!
    inProgressToolCalls += applyDelta(event, leftoverByStep)
    if (inProgressToolCalls < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
    const key = stepKeyOf(event)
    const leftover = key === undefined ? 0 : leftoverByStep.get(key) ?? 0
    if (
      key !== undefined
      && leftover > 0
      && lastLocalByStep.get(key) === index
      && (event.type === 'assistant/message' || event.type === 'tool/result')
      && logHasStepEnd(session, seq, tail[index + 1], event.data.turn, event.data.step)
    ) {
      inProgressToolCalls -= leftover
      leftoverByStep.set(key, 0)
    }
    pendingCuts.push(inProgressToolCalls === 0)
  }

  tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset))
  cache.cutBalanced = cache.cutBalanced.concat(pendingCuts)
  cache.inProgressToolCalls = inProgressToolCalls
  cache.leftoverByStep = leftoverByStep
  return cache
}

/** Close leftovers whose `step/end` landed after the current surface tail. */
function closeTailEndedSteps(
  session: Session,
  cache: BalanceCache,
  seqs: readonly SessionSeq[],
): BalanceCache {
  if (seqs.length === 0) return cache
  // oxlint-disable-next-line typescript/no-non-null-assertion -- length checked above
  closeEndedStepsFromLog(session, cache, seqs[seqs.length - 1]!, undefined)
  return cache
}

/** Return balance state synchronized with the current session surface. */
function balanceCache(session: Session): BalanceCache {
  const surface = session.surface
  const seqs = surface.nodes
  const generation = surface.replaceGeneration
  const cached = balanceCacheBySession.get(session)

  if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
    // A rebuild is the same fold started from the empty-surface state, whose
    // single leading cut is trivially balanced.
    const rebuilt = closeTailEndedSteps(session, extendCache(session, emptyCache(generation), seqs), seqs)
    balanceCacheBySession.set(session, rebuilt)
    return rebuilt
  }
  if (cached.cutBalanced.length - 1 < seqs.length) {
    const processed = cached.cutBalanced.length - 1
    if (processed > 0) {
      closeEndedStepsFromLog(
        session,
        cached,
        // oxlint-disable-next-line typescript/no-non-null-assertion -- processed > 0
        seqs[processed - 1]!,
        seqs[processed],
      )
    }
    return closeTailEndedSteps(session, extendCache(session, cached, seqs), seqs)
  }
  return closeTailEndedSteps(session, cached, seqs)
}

/** Balance of the cut at a sequence's position plus offset, rejecting seqs outside current membership. */
function cutBalance(cache: BalanceCache, seq: SessionSeq, offset: 0 | 1): boolean {
  const index = cache.indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset]
  if (balanced === undefined) {
    throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  }
  return balanced
}

/**
 * Whether the cut immediately before a current surface sequence is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param seq - event sequence whose leading cut is checked.
 * @returns true when no unanswered live-step tool call crosses the cut.
 *   Leftover calls of a step that already has `step/end` do not count.
 * @throws when the seq is absent from the current surface, a surface sequence has no
 * matching log event, or a tool result has no preceding open call.
 */
export function toolPairingBalancedBefore(session: Session, seq: SessionSeq): boolean {
  return cutBalance(balanceCache(session), seq, 0)
}

/**
 * Whether the cut immediately after a current surface sequence is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param seq - event sequence whose trailing cut is checked.
 * @returns true when no unanswered live-step tool call crosses the cut.
 *   Leftover calls of a step that already has `step/end` do not count.
 * @throws when the seq is absent from the current surface, a surface sequence has no
 * matching log event, or a tool result has no preceding open call.
 */
export function toolPairingBalancedAfter(session: Session, seq: SessionSeq): boolean {
  return cutBalance(balanceCache(session), seq, 1)
}
