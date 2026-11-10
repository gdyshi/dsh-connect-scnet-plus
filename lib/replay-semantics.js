/**
 * Cross-provider history replay, following the semantics proven by
 * dsh-connect-workbuddy (alignAssistantIdentities / isCrossProviderAssistant /
 * crossProviderThinkingOf / dropThinkingBlocks). Independent implementation.
 *
 * pi-ai replays a historical `thinking` block as reasoning ONLY while
 * isSameModel holds — provider AND api AND model id all equal the request
 * (transform-messages.js). Everything else it FLATTENS into
 * `{type:'text', text: thinking}` — the answer channel. Three layers:
 *
 * 1. alignAssistantIdentities — repair assistant turns this bundle OWNS whose
 *    identity the host broke: `api: 'dsh-foreign'` (the host's fallback
 *    marker) is repaired back to 'openai-completions'. With a single route
 *    (`scnet`) the route id IS the stamped identity, so provider needs no
 *    rewrite; only the host fallback marker can mismatch.
 * 2. Cross-provider drop — a turn from ANOTHER provider (still `dsh-foreign`
 *    after alignment, or a foreign/missing provider field) carries unsigned
 *    thinking blocks that can never be replayed as reasoning; their only wire
 *    contribution is the prose pi-ai manufactures from them. Dropping them is
 *    a correctness repair, on by default and switchable off.
 * 3. Same-route model switches are NOT touched by that leg — those turns are
 *    this bundle's own and their reasoning may be worth keeping in the
 *    transcript. The broader `dropAllThinking` switch covers them for the
 *    reasoning-collapse case (workbuddy's issue #102).
 *
 * Structural hardening (content array, assistant `source`) is our own
 * addition: the host's dsh-llm-pi-ai layer reads `message.content.some(...)`
 * and `source.replayState` unconditionally, which crashed on deformed
 * foreign turns (the reported PI_AI_ERROR).
 *
 * Peer-free on purpose: adapter.js imports DSH host packages, so replay rules
 * defined there could not be exercised on a bare checkout. The test imports
 * THIS module, which means it asserts the shipped implementation instead of a
 * re-typed copy of it.
 */

import { SCNET_PROVIDER } from "./provider-constants.js";

/** The api value dsh-llm-pi-ai stamps on a replay it could not rebuild natively. */
const HOST_FOREIGN_API = "dsh-foreign";
const OWN_ROUTE = SCNET_PROVIDER;

/** Read `content` as a block array without assuming the shape. */
export function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

/** Layer 1: repair OWN assistant turns the host stamped `dsh-foreign`. */
export function alignAssistantIdentities(messages) {
  let changed = false;
  const next = messages.map((message) => {
    if (message === null || typeof message !== "object") return message;
    if (message.role !== "assistant") return message;
    if (message.provider !== OWN_ROUTE) return message;
    if (message.api !== HOST_FOREIGN_API) return message;
    changed = true;
    return { ...message, api: "openai-completions" };
  });
  return changed ? next : messages;
}

/**
 * Whether this assistant turn came from a DIFFERENT provider, rather than from
 * this bundle's own route. Runs AFTER alignAssistantIdentities, so an own turn
 * the host downgraded to `dsh-foreign` has already been repaired away and is
 * not misclassified.
 */
export function isCrossProviderAssistant(message) {
  if (message === null || typeof message !== "object") return false;
  if (message.role !== "assistant") return false;
  if (message.api === HOST_FOREIGN_API) return true;
  return typeof message.provider !== "string" || message.provider !== OWN_ROUTE;
}

/** Structural hardening so the route's own scan can never crash on a shape. */
export function hardenMessage(message) {
  if (message === null || typeof message !== "object") return message;
  let next = message;
  if (!Array.isArray(next.content)) {
    next = { ...next, content: typeof next.content === "string" && next.content.length > 0 ? [{ type: "text", text: next.content }] : [] };
  }
  if (next.role === "assistant" && (next.source === undefined || next.source === null || typeof next.source !== "object")) {
    next = { ...next, source: {} };
  }
  return next;
}

/**
 * Drop a foreign message's thinking blocks, following workbuddy's
 * foreignThinkingOf/dropThinkingBlocks: every `thinking` block of a
 * cross-provider turn is collected except `redacted` ones, because pi-ai
 * flattens all of them into visible answer text. (In practice these blocks
 * are unsigned — foreignAssistant() builds them without a signature.)
 */
export function dropForeignThinkingBlocks(message) {
  const content = blocksOf(message);
  const filtered = content.filter((block) => block === null || typeof block !== "object" || block.type !== "thinking" || block.redacted === true);
  return filtered.length !== content.length ? { ...message, content: filtered } : message;
}

/**
 * Drop EVERY thinking block of a message, keeping `redacted` ones.
 *
 * The second switch (`dropAllThinking`), for the case workbuddy documents as
 * issue #102: when the transcript carries reasoning the current request cannot
 * replay as reasoning, pi-ai flattens it into visible answer text, the model
 * reads that as "this is how I answer", and its own reasoning collapses into
 * the answer channel. Dropping at the source removes the material it copies.
 */
export function dropAllThinkingBlocks(message) {
  const content = blocksOf(message);
  const filtered = content.filter((block) => block === null || typeof block !== "object" || block.type !== "thinking" || block.redacted === true);
  return filtered.length !== content.length ? { ...message, content: filtered } : message;
}

/**
 * The single replay-preparation pass, in workbuddy's proven order:
 * align OWN identities first, then harden shapes, then drop the unsigned
 * thinking that the switches admit.
 *
 * The switches are the user's, not ours — dropping is a REPAIR (a replayed
 * thinking block the route cannot honour becomes answer prose), but which
 * history is worth repairing depends on the session, so the defaults
 * (`dropForeignThinking: true`, `dropAllThinking: false`) reproduce the
 * previous unconditional behaviour while both extremes stay reachable.
 *
 * @param {object} options - the DSH generate options carrying `messages`.
 * @param {{dropForeignThinking?: boolean, dropAllThinking?: boolean}} [policy]
 * @returns {object} the same object when nothing changed.
 */
export function sanitizeOptions(options, policy) {
  if (!Array.isArray(options?.messages) || options.messages.length === 0) return options;
  const dropForeign = policy?.dropForeignThinking !== false;
  const dropAll = policy?.dropAllThinking === true;
  if (!dropForeign && !dropAll) return options;
  const aligned = alignAssistantIdentities(options.messages);
  let changed = aligned !== options.messages;
  const messages = aligned.map((message) => {
    let next = hardenMessage(message);
    if (dropAll) {
      next = dropAllThinkingBlocks(next);
    } else if (isCrossProviderAssistant(next)) {
      next = dropForeignThinkingBlocks(next);
    }
    if (next !== message) changed = true;
    return next;
  });
  return changed ? { ...options, messages } : options;
}
