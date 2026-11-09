/**
 * Context-overflow rescue, following the semantics proven by
 * dsh-connect-workbuddy (src/context-rescue.ts). Independent implementation.
 *
 * THE FAILURE THIS REPAIRS. When a request finally exceeds the upstream
 * window, the HOST also needs to compact the session — but the compaction
 * request itself replays the same oversized history, so the compaction
 * request can exceed the window too and the session deadlocks ("the
 * compaction request itself exceeds the limit").
 *
 * THE FIX. pi-ai reports a provider failure as an `error` event rather than a
 * throw, so the rescue runs while the failing assistant message is still in
 * hand: the oldest history is folded (compacted away) BEFORE the error event
 * continues on its way, and the host's retry then rebuilds its request
 * against a smaller surface. Nothing is swallowed — the error event is
 * forwarded unchanged, because deciding whether to retry is the host's
 * policy, not this transport's.
 *
 * Both gates are deliberate (same as workbuddy): without `sessionId` there is
 * no session to fold, and without a declared `contextWindow` there is no
 * budget to fold against; either absence leaves the stream untouched.
 */

/** Share of the window one fold chunk may consume, leaving room for the prompt. */
const CHUNK_FRACTION = 0.35;
/** Post-fold measurement target: comfortably below the window the route allows. */
const TARGET_FRACTION = 0.6;
/** A session is never folded more than this many times by one rescue. */
const MAX_ROUNDS = 8;
/** How many times one chunk may shrink its tail edge before giving up. */
const MAX_SHRINK = 24;
/** A single fold is abandoned after this long. */
const FOLD_TIMEOUT_MS = 180000;

/**
 * Create the rescue bound to a live host.
 *
 * @param {() => ({meter?: object, compaction?: object, agents?: object, log?: (message: string, error?: unknown) => void})} resolve
 *   Resolves host services at call time (tokenMeter / compaction / agents).
 * @returns {{ rescue: (sessionId: string, window: number) => Promise<boolean> }}
 *   The rescue handle the stream wrapper calls on a provider overflow.
 */
export function createContextRescue(resolve) {
  const inflight = new Set();
  return {
    async rescue(sessionId, window) {
      if (inflight.has(sessionId)) return false;
      inflight.add(sessionId);
      try {
        return await foldUntilFits(resolve(), sessionId, window);
      } catch (error) {
        resolve().log?.("dsh-connect-scnet-plus: context rescue failed", error);
        return false;
      } finally {
        inflight.delete(sessionId);
      }
    }
  };
}

async function foldUntilFits(deps, sessionId, window) {
  const { meter, compaction, agents } = deps;
  if (meter === undefined || compaction === undefined || agents === undefined) return false;
  const agent = agents.get(sessionId);
  if (agent === undefined) return false;
  const target = Math.max(1, Math.floor(window * TARGET_FRACTION));
  let foldedAny = false;
  let previous = Number.POSITIVE_INFINITY;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const measurement = meter.measure(agent.session);
    if (measurement.totalTokens <= target) return foldedAny;
    if (measurement.totalTokens >= previous) return foldedAny;
    previous = measurement.totalTokens;
    if (!(await foldOnce(deps, agent, measurement, window, target))) return foldedAny;
    foldedAny = true;
  }
  return foldedAny;
}

/**
 * Fold the oldest chunk that fits, shrinking its tail edge when the host
 * refuses the range.
 *
 * The host rejects a range whose edges split a tool call from its result, and
 * it rejects an active or missing range before appending anything — so a
 * refused attempt costs no durable state and the edge can simply move inward.
 *
 * @returns {Promise<boolean>} whether one chunk was folded.
 */
async function foldOnce(deps, agent, measurement, window, target) {
  const nodes = measurement.nodes;
  if (nodes.length < 2) return false;
  const budget = Math.floor(window * CHUNK_FRACTION);
  const excess = measurement.totalTokens - target;
  const chunk = Math.max(1, Math.min(budget, excess));
  const head = nodes[0];
  const compaction = deps.compaction;
  if (head === undefined || compaction === undefined) return false;
  let end = -1;
  let accumulated = 0;
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const node = nodes[index];
    if (node === undefined) break;
    accumulated += node.tokens;
    end = index;
    if (accumulated >= chunk) break;
  }
  if (end < 0) return false;
  const signal = AbortSignal.timeout(FOLD_TIMEOUT_MS);
  const floor = Math.max(0, end - MAX_SHRINK);
  for (; end >= floor; end -= 1) {
    const tail = nodes[end];
    if (tail === undefined) break;
    try {
      await compaction.compactRegion(head.seq, tail.seq, agent, signal);
      return true;
    } catch (error) {
      if (signal.aborted) {
        deps.log?.("dsh-connect-scnet-plus: context rescue timed out", error);
        return false;
      }
    }
  }
  deps.log?.("dsh-connect-scnet-plus: context rescue found no foldable range");
  return false;
}
