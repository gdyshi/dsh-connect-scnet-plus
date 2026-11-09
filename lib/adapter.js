/**
 * The DSH provider adapter for SCNet, mirroring the proven
 * dsh-connect-workbuddy shape:
 *
 * - provider built with pi-ai's `createProvider` + `openAICompletionsApi`
 *   (OpenAI-compatible: SSE streaming, tool calls, reasoning_content);
 * - every model's `baseUrl` points at the loopback shim, re-resolved per
 *   read so the ephemeral port applies from the first snapshot;
 * - a `PiAiAdapter` subclass that, like workbuddy's
 *   EffortNormalizingAdapter, keeps models WITHOUT reasoning metadata
 *   dispatchable: the host is told they support exactly the `off` tier, and
 *   `off` is pinned on the wire (which sends no reasoning field at all).
 */

import { createAssistantMessageEventStream, createProvider, isContextOverflow } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { ReasoningEffortId, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { SCNET_PROVIDER, SCNET_PROVIDER_DISPLAY_NAME } from "./provider-constants.js";

export { SCNET_PROVIDER, SCNET_PROVIDER_DISPLAY_NAME };
export const SCNET_STREAM_IDLE_TIMEOUT_MS = 300000;

/** Subscription-quota models have no per-token price we can know; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576
};

/**
 * Inert pi-ai auth plane: the route authenticates only through the shim
 * shared secret resolved per request, so pi-ai's own credential lifecycle
 * and ambient discovery must never manufacture a credential for it.
 */
export const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error("dsh-connect-scnet-plus: the scnet route has no pi-ai credential lifecycle");
    },
    async delete() {}
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    }
  }
};

const NO_REASONING_EFFORT = ReasoningEffortId("off");
/** What the host is told a reasoning-less model supports: exactly that tier. */
const NO_REASONING_EFFORTS = { efforts: [{ id: NO_REASONING_EFFORT, name: "Off" }] };

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
 *    a correctness repair, applied unconditionally (no switch), exactly as
 *    workbuddy does.
 * 3. Same-route model switches are NOT touched — those turns are this
 *    bundle's own and their reasoning may be worth keeping in the transcript.
 *    (workbuddy gates this leg behind its explicit `dropForeignThinking`
 *    switch; we have no switch yet, so the conservative default applies.)
 *
 * Structural hardening (content array, assistant `source`) is our own
 * addition: the host's dsh-llm-pi-ai layer reads `message.content.some(...)`
 * and `source.replayState` unconditionally, which crashed on deformed
 * foreign turns (the reported PI_AI_ERROR).
 */

/** The api value dsh-llm-pi-ai stamps on a replay it could not rebuild natively. */
const HOST_FOREIGN_API = "dsh-foreign";
const OWN_ROUTE = SCNET_PROVIDER;

/** Read `content` as a block array without assuming the shape. */
function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

/** Layer 1: repair OWN assistant turns the host stamped `dsh-foreign`. */
function alignAssistantIdentities(messages) {
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
function isCrossProviderAssistant(message) {
  if (message === null || typeof message !== "object") return false;
  if (message.role !== "assistant") return false;
  if (message.api === HOST_FOREIGN_API) return true;
  return typeof message.provider !== "string" || message.provider !== OWN_ROUTE;
}

/** Structural hardening so the route's own scan can never crash on a shape. */
function hardenMessage(message) {
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
function dropForeignThinkingBlocks(message) {
  const content = blocksOf(message);
  const filtered = content.filter((block) => block === null || typeof block !== "object" || block.type !== "thinking" || block.redacted === true);
  return filtered.length !== content.length ? { ...message, content: filtered } : message;
}

/**
 * The single replay-preparation pass, in workbuddy's proven order:
 * align OWN identities first, then harden shapes, then drop the foreign
 * unsigned thinking that survives alignment.
 */
function sanitizeOptions(options) {
  if (!Array.isArray(options?.messages) || options.messages.length === 0) return options;
  const aligned = alignAssistantIdentities(options.messages);
  let changed = aligned !== options.messages;
  const messages = aligned.map((message) => {
    let next = hardenMessage(message);
    if (isCrossProviderAssistant(next)) next = dropForeignThinkingBlocks(next);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? { ...options, messages } : options;
}

/**
 * Layer the host-side context-overflow rescue onto a provider's streams
 * (workbuddy's withContextRescue). Wraps the pi-ai api object BEFORE it is
 * handed to createProvider, so every route — stream() and streamSimple() —
 * is covered.
 *
 * @param {object} api - the pi-ai api implementation.
 * @param {(() => {rescue: (sessionId: string, window: number) => Promise<boolean>} | undefined) | undefined} resolve
 */
export function withContextRescue(api, resolve) {
  if (resolve === undefined) return api;
  const wrap = (inner) => (model, context, options) => {
    const source = inner(model, context, options);
    const rescue = resolve();
    const sessionId = options?.sessionId;
    const window = model.contextWindow;
    if (rescue === undefined || sessionId === undefined || window === undefined) return source;
    const out = createAssistantMessageEventStream();
    let final;
    (async () => {
      try {
        for await (const event of source) {
          if (event.type === "done") final = event.message;
          if (event.type === "error") final = event.error;
          if (event.type === "error" && isContextOverflow(event.error)) await rescue.rescue(sessionId, window);
          out.push(event);
        }
        out.end(final);
      } catch {
        out.end(final);
      }
    })();
    return out;
  };
  return {
    ...api,
    stream: wrap(api.stream),
    streamSimple: wrap(api.streamSimple)
  };
}

/**
 * pi-ai adapter that keeps a model without reasoning metadata dispatchable.
 * `off` is the one tier pi-ai offers for such a model, and the host's own
 * translation of it is "send no reasoning field at all" — so pinning it
 * neither invents a capability nor changes a byte of the upstream request.
 */
class ScnetAdapter extends PiAiAdapter {
  constructor(config) {
    super(config);
  }
  async resolveModel(provider, model, signal) {
    return this.advertiseOffOnly(await super.resolveModel(provider, model, signal));
  }
  async prepareCall(provider, model, signal) {
    const call = await super.prepareCall(provider, model, signal);
    return {
      model: this.advertiseOffOnly(call.model),
      stream: (options) => call.stream(this.pinEffort(sanitizeOptions(options)))
    };
  }
  stream(options) {
    return super.stream(this.pinEffort(sanitizeOptions(options)));
  }
  advertiseOffOnly(info) {
    return info.reasoning === undefined ? { ...info, reasoning: NO_REASONING_EFFORTS } : info;
  }
  pinEffort(options) {
    return options.reasoningEffort === NO_REASONING_EFFORT ? options : { ...options, reasoningEffort: NO_REASONING_EFFORT };
  }
}

/** Map one catalog entry to a pi-ai model descriptor pointing at the shim. */
export function toScnetModel(info, baseUrl, identity = SCNET_PROVIDER) {
  return {
    id: info.id,
    name: info.name,
    api: "openai-completions",
    provider: identity,
    baseUrl,
    input: info.image === true ? ["text", "image"] : ["text"],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: false,
    compat: { supportsReasoningEffort: false }
  };
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read.
 *
 * @param {{shim: object, catalog: () => Array, providerId?: string, displayName?: string}} options
 */
export function createScnetAdapter(options) {
  const { shim, catalog } = options;
  const providerId = options.providerId ?? SCNET_PROVIDER;
  const providerName = options.displayName ?? SCNET_PROVIDER_DISPLAY_NAME;
  const identity = providerId;
  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`;
    return catalog().map((info) => toScnetModel(info, baseUrl, identity));
  };
  const provider = {
    ...createProvider({
      id: providerId,
      name: providerName,
      auth: {
        apiKey: {
          name: "SCNet loopback shim token",
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: "SCNet shim" };
          }
        }
      },
      models: buildModels(),
      api: withContextRescue(openAICompletionsApi(), options.resolveContextRescue)
    }),
    getModels: () => buildModels()
  };
  const profileFor = (key) => ({
    provider: key,
    displayName: providerName,
    streamIdleTimeoutMs: SCNET_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-connect-scnet-plus retryPolicy"),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    /** Route-wide fallback tier, pinned to what pi-ai would fill in anyway. */
    reasoning: "high",
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: key === providerId ? provider : { ...provider, id: key }
  });
  const buildProfiles = () => new Map([[providerId, profileFor(providerId)]]);
  let profiles = buildProfiles();
  return {
    adapter: new ScnetAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
      /**
       * WorkBuddy's wiring: hand the Host's durable attachment service to
       * pi-ai so a history containing image blocks can replay instead of
       * failing with "pi-ai image input requires the durable attachment
       * service" (UNSUPPORTED_CONTENT) the moment a model advertises image
       * input. Soft-get semantics: undefined simply keeps the old failure.
       */
      ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments }
    }),
    invalidate: () => {
      profiles = buildProfiles();
    }
  };
}
