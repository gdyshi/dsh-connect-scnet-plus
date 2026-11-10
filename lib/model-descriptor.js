/**
 * The pi-ai model descriptor this route publishes, and the thinking vocabulary
 * it publishes alongside it.
 *
 * WHY THIS IS ITS OWN MODULE (not inline in adapter.js): adapter.js imports the
 * DSH host package `@deepseek-ai/dsh-llm-pi-ai`, so anything defined there can
 * only be exercised inside a running host. The descriptor is where the two
 * user-visible capabilities are decided — which thinking tiers a model offers
 * and how much context it claims — so it has to be testable on a bare checkout.
 * Same split as `rescue-wrap.js` and `pi-ai-runtime.js`.
 *
 * THINKING, AND WHY IT MATTERS (the defect this encodes the fix for):
 * `off` is not a wire instruction. pi-ai's `openai-completions` translates it
 * to *omitting* the reasoning option, which is byte-for-byte the request a
 * caller that names no tier sends — so a model whose upstream default is to
 * think keeps thinking with `off` selected. Publishing `off` as the ONLY tier
 * therefore yields a picker that cannot change anything. SCNet does honour two
 * instructions, measured against the gateway:
 *
 *   reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
 *       → the returned reasoning prose changes with the tier;
 *   thinking: {type: "disabled"}
 *       → reasoning disappears entirely.
 *
 * pi-ai's `thinkingFormat: "deepseek"` emits exactly that pair, driven by
 * `thinkingLevelMap`, so the map is all this route has to publish.
 *
 * A model with no vocabulary (`thinkingMode` absent in the scnet cache) keeps
 * the historical `off`-only shape, where omitting the option IS the honest
 * request: the route cannot express anything else.
 */

/** The thinking tiers measured to work on the SCNet gateway, in pi-ai order. */
export const SCNET_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** pi-ai's tier id for "no reasoning"; also the wire value this route accepts. */
export const OFF_EFFORT = "off";

/** What the host is told a model with no tier vocabulary supports. */
export const OFF_ONLY_REASONING = { efforts: [{ id: OFF_EFFORT, name: "Off" }] };

/**
 * The `thinkingLevelMap` for one catalog entry, or `undefined` when SCNet
 * publishes no tier vocabulary for it.
 *
 * Every level maps to itself: the gateway takes pi-ai's level names verbatim as
 * `reasoning_effort`. `off` maps to the STRING `"off"`, never `null` — pi-ai's
 * `openai-completions` reads `thinkingLevelMap.off !== null` to decide whether
 * it may send a thinking-disabled request, and `"deepseek"` then emits
 * `thinking: {type: "disabled"}`.
 *
 * @param {{thinking?: string}} info - one normalized catalog entry.
 * @returns {Record<string, string> | undefined}
 */
export function thinkingLevelMapFor(info) {
  if (info?.thinking !== "levels") return undefined;
  const map = {};
  for (const level of SCNET_THINKING_LEVELS) map[level] = level;
  map.off = OFF_EFFORT;
  return map;
}

/**
 * The window one model should claim, plus the native window when a user budget
 * narrowed it.
 *
 * A budget can only SHRINK: `min(native, budget)` means a stale or over-large
 * setting can never claim more room than the upstream model really has. The
 * native value rides along as `nativeContextWindow` so a diagnostics view can
 * still say what the model really serves (pi-ai ignores the extra field).
 *
 * @param {number} native - the model's own context window.
 * @param {number} [budget] - the user's cap for this model, if any.
 * @returns {{contextWindow: number, nativeContextWindow?: number}}
 */
export function budgetedWindow(native, budget) {
  const usable = Number.isFinite(budget) && budget > 0 && budget < native;
  if (!usable) return { contextWindow: native };
  return { contextWindow: Math.floor(budget), nativeContextWindow: native };
}

/**
 * Map one catalog entry to a pi-ai model descriptor pointing at the shim.
 *
 * @param {object} info - normalized catalog entry.
 * @param {string} baseUrl - the loopback shim's /v1 URL.
 * @param {string} [identity] - the `provider` pi-ai resolves the route by.
 * @param {number} [contextBudget] - the user's per-model window cap, if any.
 * @returns {object} a pi-ai `Model` descriptor.
 */
export function toScnetModel(info, baseUrl, identity, contextBudget) {
  const thinkingLevelMap = thinkingLevelMapFor(info);
  const window = budgetedWindow(info.contextWindow, contextBudget);
  return {
    id: info.id,
    name: info.name,
    api: "openai-completions",
    provider: identity,
    baseUrl,
    input: info.image === true ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: window.contextWindow,
    ...(window.nativeContextWindow === undefined ? {} : { nativeContextWindow: window.nativeContextWindow }),
    maxTokens: info.maxTokens,
    reasoning: thinkingLevelMap !== undefined,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    compat: {
      supportsReasoningEffort: thinkingLevelMap !== undefined,
      ...(thinkingLevelMap === undefined ? {} : { thinkingFormat: "deepseek" })
    }
  };
}

/**
 * Whether a tier request must be replaced with `off` before it reaches pi-ai.
 *
 * Only a model with no tier vocabulary needs pinning: for it, `off` is what the
 * request looks like anyway. Pinning a capable model (the previous behaviour)
 * is what made every tier request identical on the wire.
 *
 * @param {string} requested - the tier the host resolved for this call.
 * @param {boolean} capable - whether this exact model publishes a vocabulary.
 * @returns {string} the tier to send.
 */
export function effectiveEffort(requested, capable) {
  if (capable) return requested;
  return OFF_EFFORT;
}
