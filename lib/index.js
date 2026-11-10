/**
 * dsh-connect-scnet-plus — cordis plugin entry.
 *
 * Registers the `scnet` provider (超算互联网 / 计算服务) into DSH:
 *   1. read-only credential discovery (config → env → ~/.sclaw credential files)
 *   2. a loopback shim that injects the real sk-key per request
 *   3. provider + adapter registration on the host's llm service
 *   4. diagnostics served on the shim's GET /status (see lib/doctor.js)
 */

import { readFileSync } from "node:fs";

import z from "@deepseek-ai/schemastery";

import { discoverCredentials, maskKey, primaryKey } from "./credentials.js";
import { applyModelSelection, getCatalog, enabledModelIdsFromSwitches, MODELS_CACHE_PATH, normalizeLocalModel } from "./catalog.js";
import { createScnetShim } from "./shim.js";
import { createScnetAdapter } from "./adapter.js";
import { createContextRescue } from "./context-rescue.js";
import { SCNET_PROVIDER, SCNET_PROVIDER_DISPLAY_NAME } from "./provider-constants.js";
import { collectStatus, runDoctor } from "./doctor.js";

/** Stable cordis plugin name. */
export const name = "dsh-connect-scnet-plus";

/** The model registry required before the provider can register. */
export const inject = ["llm", "settings"];

export { collectStatus, runDoctor };

/**
 * Per-model switches, materialized into the Config schema at module load.
 *
 * The settings form is derived from the plugin's static Config schema, so the
 * model list has to exist before the settings page renders. Reading the local
 * models.json cache here (best effort, read-only) gives the form one boolean
 * per model — the settings card then renders real checkboxes instead of asking
 * the user to type ids. Every box starts UNCHECKED (`default(false)`): the
 * card's empty state means "no filter", so all models stay available until
 * the user checks one, at which point the checked set becomes the allowlist.

 */
function modelSwitchSchema() {
  const switches = {};
  try {
    const parsed = JSON.parse(readFileSync(MODELS_CACHE_PATH, "utf8"));
    const provider = parsed?.providers?.scnet;
    const entries = Array.isArray(provider?.models) ? provider.models : [];
    const visible = Array.isArray(provider?.visibleModelIds) ? new Set(provider.visibleModelIds) : undefined;
    const seen = new Set();
    for (const entry of entries) {
      const model = normalizeLocalModel(entry);
      if (model === undefined || seen.has(model.id)) continue;
      if (visible !== undefined && !visible.has(model.id)) continue;
      seen.add(model.id);
      switches[model.id] = z.boolean().default(false).description(model.name);
    }
  } catch {
    // no local cache yet: the form simply carries no model switches
  }
  return z.object(switches);
}

export const Config = z.object({
  apiKey: z.string().default("").description("手动指定的 SCNet API Key（sk-…）。留空则读 SCNET_API_KEY 环境变量，再回落到 ~/.sclaw/agent/scnet-credentials/ 下的账号文件（只读）。"),
  enabled: z.boolean().default(true).description("是否向 DSH 注册 scnet provider。"),
  modelSwitches: modelSwitchSchema().description("按模型启用：默认全部不勾选 = 不做限制（所有模型可用）；勾选任意模型后，只有勾选的会出现在模型选择器里。"),
  enabledModelIds: z.array(z.string()).default([]).description("高级：只启用这些模型 id，留空 = 不过滤（仍受上面的开关约束）。可用 id 见 dsh-connect-scnet-plus 诊断输出。"),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description("逐模型上下文预算（token）。留空 = 用模型原生窗口；填写后取 min(原生, 预算)，只会缩小。可用 id 见诊断输出。"),
  dropForeignThinking: z.boolean().default(true).description("跨 provider 历史里的 thinking 块：true = 丢弃（默认，pi-ai 会把它压成可见正文），false = 原样保留。"),
  dropAllThinking: z.boolean().default(false).description("历史里所有 thinking 块都丢弃（含本路由自己的）。仅在实测到「推理塌缩进正文」时开启。")
}).description("超算互联网（计算服务）连接设置").volatile();

/** How long one credential discovery result may serve before a re-scan. */
const CREDENTIALS_TTL_MS = 5 * 60 * 1000;

/** Masked, comparable description of one discovered account set. */
function describeAccounts(credentials) {
  return credentials.accounts.map((account) => `${account.file} [${maskKey(account.key)}]`).join(", ");
}

/**
 * Credential discovery with a TTL. THE FAILURE THIS AVOIDS: a promise cached
 * for the whole host session would keep serving a key the scnet client has
 * already rotated (re-login writes a new credential file), and every request
 * would 401 until the host restarts. Re-scanning is read-only and cheap.
 */
export function createCredentialResolver(ctx, config) {
  const unwrapValue = (value) => (value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value);
  let cache = { at: 0, credentials: undefined };
  let inflight = null;
  let signature = "";
  const resolveCredentials = async () => {
    const now = Date.now();
    if (cache.credentials !== undefined && now - cache.at < CREDENTIALS_TTL_MS) return cache.credentials;
    if (inflight === null) {
      inflight = discoverCredentials({ apiKey: unwrapValue(config).apiKey })
        .then((credentials) => {
          cache = { at: Date.now(), credentials };
          const next = `${credentials.source}|${credentials.accounts.map((account) => account.file).join(",")}`;
          if (signature === "") {
            if (credentials.accounts.length === 0) {
              ctx.logger.warn("dsh-connect-scnet-plus: 未发现 scnet 凭据（config / SCNET_API_KEY / ~/.sclaw/agent/scnet-credentials 均为空），provider 将注册但请求会返回 401");
            } else {
              ctx.logger.info(`dsh-connect-scnet-plus: 发现 ${credentials.accounts.length} 个 scnet 账号（来源 ${credentials.source}，key 已脱敏）: ${describeAccounts(credentials)}`);
            }
          } else if (next !== signature) {
            ctx.logger.info(`dsh-connect-scnet-plus: scnet 账号集合变化，已重新发现 ${credentials.accounts.length} 个账号（来源 ${credentials.source}）: ${describeAccounts(credentials)}`);
          }
          signature = next;
          inflight = null;
          return credentials;
        })
        .catch((error) => {
          inflight = null;
          throw error;
        });
    }
    return inflight;
  };
  return resolveCredentials;
}

/**
 * Plugin activation: start the loopback shim, register the provider, refresh
 * the catalog every 10 minutes.
 */
export function apply(ctx, config) {
  const unwrap = (value) => (value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value);

  if (unwrap(config).enabled === false) {
    ctx.logger.info("dsh-connect-scnet-plus: 配置中已禁用（enabled = false），不注册 scnet provider");
    return;
  }

  const resolveCredentials = createCredentialResolver(ctx, config);
  const resolveApiKey = async () => primaryKey(await resolveCredentials());

  /** Host-side context-overflow rescue (see lib/context-rescue.js). */
  const hostService = (name) => ctx.get?.(name);
  const contextRescue = createContextRescue(() => ({
    meter: hostService("tokenMeter"),
    compaction: hostService("compaction"),
    agents: hostService("agents"),
    log: (message, error) => ctx.logger.warn(message, error)
  }));

  let catalogState = { source: "loading", catalog: [] };
  /** The user's model allowlist, read live so a settings edit needs no restart of its own. */
  const enabledModelIds = () => {
    const configured = unwrap(config).enabledModelIds;
    return Array.isArray(configured) ? configured : [];
  };
  /** Model ids the per-model switches explicitly turned OFF. */
  const switchedOnIds = () => [...enabledModelIdsFromSwitches(unwrap(config).modelSwitches)];
  /**
   * The catalog the provider actually serves. Both selections filter at READ
   * time, so a picker opened after the settings save already sees them; the
   * watcher below rebuilds the adapter's model table so long-lived surfaces
   * (the already-open picker, the model registry snapshot) agree too.
   */
  const catalog = () => applyModelSelection(catalogState.catalog, {
    enabledModelIds: enabledModelIds(),
    modelSwitches: unwrap(config).modelSwitches
  });
  /** Set once the adapter exists so refreshes rebuild its model table. */
  let onCatalogChanged = null;
  const refreshCatalog = async () => {
    try {
      const apiKey = await resolveApiKey();
      const result = await getCatalog({ apiKey, force: true });
      catalogState = result;
      const visible = catalog().length;
      const total = result.catalog.length;
      ctx.logger.info(`dsh-connect-scnet-plus: 模型目录加载完成（来源 ${result.source}，${total} 个模型${visible === total ? "" : `，已启用 ${visible} 个`}）`);
      onCatalogChanged?.();
    } catch (error) {
      ctx.logger.warn("dsh-connect-scnet-plus: 模型目录加载失败" + (catalogState.catalog.length > 0 ? "；沿用上次结果" : ""), error);
    }
  };
  const catalogTimer = setInterval(refreshCatalog, 10 * 60 * 1000);
  catalogTimer.unref?.();
  /**
   * Watch the selection for live changes. A settings write applies to the
   * profile patch and the host reloads the entry's config; whether that
   * recreates this plugin instance is a host detail, so the cheap 10s check
   * keeps a long-lived instance in sync either way.
   */
  let appliedSelection = JSON.stringify([enabledModelIds(), switchedOnIds()]);
  const selectionTimer = setInterval(() => {
    const next = JSON.stringify([enabledModelIds(), switchedOnIds()]);
    if (next === appliedSelection) return;
    appliedSelection = next;
    const ids = enabledModelIds();
    const on = switchedOnIds();
    ctx.logger.info(`dsh-connect-scnet-plus: 模型启用列表变化（白名单: ${ids.length === 0 ? "不过滤" : ids.join(", ")}；已勾选: ${on.length === 0 ? "无" : on.join(", ")}）`);
    void refreshCatalog();
  }, 10 * 1000);
  selectionTimer.unref?.();

  const shim = createScnetShim({
    resolveApiKey,
    getModels: catalog,
    status: () => collectStatus({ credentials: resolveCredentials(), catalog: catalogState, gateway: undefined }),
    logger: {
      warn: (message, error) => ctx.logger.warn(message, error),
      error: (message, error) => ctx.logger.error(message, error)
    }
  });

  ctx.effect(() => () => {
    clearInterval(catalogTimer);
    clearInterval(selectionTimer);
    shim.close();
  });

  void shim.ready.then(async () => {
    const settingsNs = ctx?.fiber?.entry?.options?.id ?? "scnet";
    try {
      /** Load the catalog first so models exist when the adapter registers. */
      await refreshCatalog();
      const { adapter, invalidate } = createScnetAdapter({
        shim,
        catalog,
        providerId: SCNET_PROVIDER,
        displayName: SCNET_PROVIDER_DISPLAY_NAME,
        /**
         * Host services resolve at CALL time, not capture time (workbuddy's
         * hostService pattern): the llm/compaction services are registered by
         * other bundles whose load order is not guaranteed here.
         */
        resolveContextRescue: () => contextRescue,
        /** Durable attachments so image-bearing history can replay on scnet. */
        resolveAttachments: () => ctx.get("attachments"),
        /** Per-model window caps, read live so a settings edit applies at once. */
        contextBudgets: () => unwrap(config).contextBudgets ?? {},
        /** The user's replay switches, read live for the same reason. */
        replayPolicy: () => ({
          dropForeignThinking: unwrap(config).dropForeignThinking !== false,
          dropAllThinking: unwrap(config).dropAllThinking === true
        })
      });
      onCatalogChanged = invalidate;
      const releaseAdapter = ctx.llm.registerAdapter([SCNET_PROVIDER], adapter);
      const releaseDirectory = ctx.llm.registerConfigurableProviders([{
        provider: SCNET_PROVIDER,
        displayName: SCNET_PROVIDER_DISPLAY_NAME,
        settingsNs,
        settingsPath: [],
        declared: false
      }]);
      /** Feed the models settings page / picker, like workbuddy does. */
      const releaseDiscovery = ctx.llm.registerModelDiscovery?.(settingsNs, async (request, signal) => {
        void signal;
        if (request && request.provider !== undefined && request.provider !== SCNET_PROVIDER) return [];
        /**
         * `includeHidden` is this plugin's own request flag for its settings
         * card: the card must list models the user switched OFF, otherwise an
         * unchecked model could never be checked again.
         */
        const source = request?.includeHidden === true ? catalogState.catalog : catalog();
        return source.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          inputModalities: model.image === true ? ["text", "image"] : ["text"]
        }));
      });
      ctx.effect(() => () => {
        releaseAdapter?.();
        releaseDirectory?.();
        releaseDiscovery?.();
      });
      ctx.logger.info(`dsh-connect-scnet-plus: provider "${SCNET_PROVIDER}"（${SCNET_PROVIDER_DISPLAY_NAME}）已注册，loopback shim ${shim.baseUrl()}`);
    } catch (error) {
      ctx.logger.error("dsh-connect-scnet-plus: provider 注册失败", error);
      return;
    }
  }).catch((error) => {
    ctx.logger.error("dsh-connect-scnet-plus: loopback shim 启动失败；provider 未注册", error);
  });
}
