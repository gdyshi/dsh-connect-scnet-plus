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
import { createRescueWrapper } from "./rescue-wrap.js";
import { sanitizeOptions } from "./replay-semantics.js";
import { piAiRuntimeInfo, withTranscriptShape } from "./pi-ai-runtime.js";
import {
  OFF_EFFORT,
  OFF_ONLY_REASONING,
  SCNET_THINKING_LEVELS,
  effectiveEffort,
  thinkingLevelMapFor,
  toScnetModel
} from "./model-descriptor.js";

export { SCNET_PROVIDER, SCNET_PROVIDER_DISPLAY_NAME };
export { SCNET_THINKING_LEVELS, thinkingLevelMapFor, toScnetModel };
export const SCNET_STREAM_IDLE_TIMEOUT_MS = 300000;

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

const NO_REASONING_EFFORT = ReasoningEffortId(OFF_EFFORT);
/** What the host is told a reasoning-less model supports: exactly that tier. */
const NO_REASONING_EFFORTS = OFF_ONLY_REASONING;

/**
 * Layer the host-side context-overflow rescue onto a provider's streams
 * (workbuddy's withContextRescue). The pi-ai primitives are injected so the
 * wrapper is peer-free and unit-testable on a bare checkout; the runtime code
 * path is unchanged (see lib/rescue-wrap.js).
 */
export const withContextRescue = createRescueWrapper({
  createEventStream: createAssistantMessageEventStream,
  isOverflow: isContextOverflow
});

/**
 * pi-ai adapter that keeps BOTH kinds of SCNet model dispatchable.
 *
 * A model with no tier vocabulary gets the `off`-only advertisement and is
 * pinned to it. A model WITH a vocabulary is left alone: the user's chosen tier
 * flows to pi-ai, which maps it through `thinkingLevelMap` onto `thinking` /
 * `reasoning_effort`. Pinning every model to `off` (the previous behaviour) was
 * the defect — `off` is translated to *omitting* the option, so a model whose
 * upstream default is to think kept thinking no matter what the picker said.
 * The decision itself lives in `model-descriptor.js` so it is testable.
 */
class ScnetAdapter extends PiAiAdapter {
  /**
   * @param {object} config - the PiAiAdapter options.
   * @param {{
   *   effortCapable: (modelId: string) => boolean,
   *   replayPolicy?: () => {dropForeignThinking?: boolean, dropAllThinking?: boolean}
   * }} hooks - live predicates read per call; captured values would go stale
   *   when the catalog refreshes or the user edits settings mid-session.
   */
  constructor(config, hooks) {
    super(config);
    this.effortCapable = hooks.effortCapable;
    this.replayPolicy = hooks.replayPolicy ?? (() => undefined);
  }
  async resolveModel(provider, model, signal) {
    return this.advertiseOffOnly(await super.resolveModel(provider, model, signal));
  }
  async prepareCall(provider, model, signal) {
    const call = await super.prepareCall(provider, model, signal);
    return {
      model: this.advertiseOffOnly(call.model),
      stream: (options) => call.stream(this.pinEffort(this.prepareOptions(options)))
    };
  }
  stream(options) {
    return super.stream(this.pinEffort(this.prepareOptions(options)));
  }
  /** Replay repair with the user's switches applied (see replay-semantics). */
  prepareOptions(options) {
    return sanitizeOptions(options, this.replayPolicy());
  }
  advertiseOffOnly(info) {
    if (info.reasoning !== undefined) return info;
    return { ...info, reasoning: NO_REASONING_EFFORTS };
  }
  pinEffort(options) {
    const effort = ReasoningEffortId(effectiveEffort(options.reasoningEffort, this.effortCapable(options.model)));
    return options.reasoningEffort === effort ? options : { ...options, reasoningEffort: effort };
  }
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read.
 *
 * @param {{
 *   shim: object,
 *   catalog: () => Array,
 *   providerId?: string,
 *   displayName?: string,
 *   contextBudgets?: () => Record<string, number>,
 *   replayPolicy?: () => {dropForeignThinking?: boolean, dropAllThinking?: boolean},
 *   resolveContextRescue?: () => object | undefined,
 *   resolveAttachments?: () => object | undefined
 * }} options
 */
export function createScnetAdapter(options) {
  const { shim, catalog } = options;
  const providerId = options.providerId ?? SCNET_PROVIDER;
  const providerName = options.displayName ?? SCNET_PROVIDER_DISPLAY_NAME;
  const identity = providerId;
  /** The user's per-model window caps, read live so a settings edit applies. */
  const budgets = () => options.contextBudgets?.() ?? {};
  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`;
    const caps = budgets();
    return catalog().map((info) => toScnetModel(info, baseUrl, identity, caps[info.id]));
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
      api: withContextRescue(
        withTranscriptShape(openAICompletionsApi(), piAiRuntimeInfo().generation),
        options.resolveContextRescue
      )
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
    }, {
      /** Whether this exact model publishes a tier vocabulary, read live. */
      effortCapable: (modelId) => catalog().some((info) => info.id === modelId && thinkingLevelMapFor(info) !== undefined),
      /** The user's replay switches, read live. */
      replayPolicy: options.replayPolicy
    }),
    invalidate: () => {
      profiles = buildProfiles();
    }
  };
}
