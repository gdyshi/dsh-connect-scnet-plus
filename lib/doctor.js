/**
 * doctor / status diagnostics. Kept free of host-only peer imports so the
 * CLI (`lib/bin.js`) works standalone without a DSH host.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCredentials, maskKey, primaryKey } from "./credentials.js";
import { applyModelSelection, SCNET_GATEWAY_BASE, fetchGatewayCatalog, getCatalog } from "./catalog.js";
import { SCNET_PROVIDER, SCNET_PROVIDER_DISPLAY_NAME } from "./provider-constants.js";

export const PLUGIN_NAME = "dsh-connect-scnet-plus";

/**
 * The @earendil-works/pi-ai version THIS plugin resolves — found by walking
 * node_modules up from this module (the same walk Node's resolver does), then
 * reading the package's own file. pi-ai's `exports` exposes no `require`
 * condition, so `require.resolve` cannot be used here. THE FAILURE THIS CHECKS
 * (workbuddy issue #24, hit by this plugin too): the HOST normalizes the
 * context (system prompt folded into `messages`) when its pi-ai is 0.87+/1.x,
 * while a plugin-resolved pi-ai older than 0.87 cannot estimate such a
 * transcript and throws `reading 'length'` inside `estimateMessageTokens` —
 * every request dies before any upstream traffic. Read-only + try/catch so
 * the CLI stays standalone-safe without the peer.
 */
function resolvePiAiVersion() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "@earendil-works", "pi-ai", "package.json"), "utf8"));
      if (parsed?.name === "@earendil-works/pi-ai") return String(parsed.version ?? "");
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** True when a pi-ai release understands normalized transcripts (0.87+ / 1.x). */
function isModernPiAiVersion(version) {
  if (typeof version !== "string") return false;
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  return major >= 1 || (major === 0 && Number.isFinite(minor) && minor >= 87);
}

/**
 * Assemble a diagnostics document. Never includes a full key.
 * @param {{credentials?, catalog?, gateway?: {ok: boolean, detail?: string}}} [snapshot]
 */
export async function collectStatus(snapshot = {}) {
  const credentials = snapshot.credentials instanceof Promise
    ? await snapshot.credentials
    : snapshot.credentials ?? await discoverCredentials();
  let catalogInfo = snapshot.catalog;
  if (catalogInfo === undefined) {
    try {
      catalogInfo = await getCatalog({ apiKey: primaryKey(credentials) });
    } catch (error) {
      catalogInfo = { source: "none", catalog: [], error: String(error) };
    }
  }
  let gateway = snapshot.gateway;
  let gatewayModelIds;
  if (gateway === undefined && typeof primaryKey(credentials) === "string") {
    try {
      const models = await fetchGatewayCatalog({ apiKey: primaryKey(credentials) });
      gatewayModelIds = models.map((model) => model.id);
      gateway = { ok: true, modelCount: models.length };
    } catch (error) {
      gateway = { ok: false, error: String(error) };
    }
  }
  const localIds = new Set(catalogInfo.catalog.map((model) => model.id));
  const gatewayOnlyModels = gatewayModelIds === undefined ? undefined : gatewayModelIds.filter((id) => !localIds.has(id));
  const piAiVersion = resolvePiAiVersion();
  const enabledIds = Array.isArray(snapshot.enabledModelIds) ? snapshot.enabledModelIds : [];
  const selected = applyModelSelection(catalogInfo.catalog, {
    enabledModelIds: enabledIds,
    modelSwitches: snapshot.modelSwitches
  });
  const visibleIds = new Set(selected.map((model) => model.id));
  return {
    plugin: PLUGIN_NAME,
    provider: SCNET_PROVIDER,
    displayName: SCNET_PROVIDER_DISPLAY_NAME,
    gatewayBase: SCNET_GATEWAY_BASE,
    accounts: credentials.accounts.map((account) => ({
      source: account.file,
      key: maskKey(account.key)
    })),
    accountCount: credentials.accounts.length,
    credentialSource: credentials.source,
    catalogSource: catalogInfo.source,
    modelCount: catalogInfo.catalog.length,
    enabledModelCount: visibleIds.size,
    models: catalogInfo.catalog.map((model) => ({ id: model.id, name: model.name, image: model.image === true, enabled: visibleIds.has(model.id) })),
    ...(gatewayModelIds !== undefined ? { gatewayOnlyModels } : {}),
    piAi: { version: piAiVersion ?? "(unresolved)", modern: isModernPiAiVersion(piAiVersion) },
    ...(gateway !== undefined ? { gateway } : {})
  };
}

/** doctor: the status document with an explicit verdict per check. */
export async function runDoctor() {
  const status = await collectStatus();
  const piAiUnresolved = status.piAi.version === "(unresolved)";
  const checks = [
    {
      name: "credentials",
      ok: status.accountCount > 0,
      detail: status.accountCount > 0
        ? `发现 ${status.accountCount} 个账号（来源 ${status.credentialSource}）：${status.accounts.map((a) => `${a.source} [${a.key}]`).join(", ")}`
        : "未发现任何 scnet API Key。请确认 scnet 工具链已登录，或在设置中手动填写 apiKey。"
    },
    {
      name: "catalog",
      ok: status.modelCount > 0,
      detail: `模型目录来源 ${status.catalogSource}，共 ${status.modelCount} 个可见模型。`
    }
  ];
  if (status.gateway !== undefined) {
    checks.push({
      name: "gateway",
      ok: status.gateway.ok === true,
      detail: status.gateway.ok
        ? `网关 ${SCNET_GATEWAY_BASE} 连通（/models 返回 ${status.gateway.modelCount} 个模型）`
        : `网关不通：${status.gateway.error}`
    });
  } else {
    checks.push({ name: "gateway", ok: false, detail: "没有可用凭据，未探测网关" });
  }
  if (Array.isArray(status.gatewayOnlyModels) && status.gatewayOnlyModels.length > 0) {
    checks.push({
      name: "gateway-only-models",
      ok: true,
      detail: `信息（非故障）：网关有而本地 models.json 没有的 ${status.gatewayOnlyModels.length} 个模型不可见（目录以本地缓存为准）: ${status.gatewayOnlyModels.join(", ")}`
    });
  }
  checks.push({
    name: "model-selection",
    ok: true,
    detail: status.enabledModelCount === status.modelCount
      ? `全部 ${status.modelCount} 个模型可见（未配置开关 = 不过滤）`
      : status.enabledModelCount === 0
        ? `未启用任何模型（所有开关都未勾选且无 allowlist — 请检查配置）`
        : `已启用 ${status.enabledModelCount}/${status.modelCount} 个；未启用: ${status.models.filter((model) => !model.enabled).map((model) => model.id).join(", ")}`
  });
  checks.push({
    name: "pi-ai",
    ok: piAiUnresolved || status.piAi.modern === true,
    detail: piAiUnresolved
      ? "无法从当前目录解析 @earendil-works/pi-ai 版本（在插件目录外运行？宿主内应可解析）"
      : status.piAi.modern
        ? `插件解析到 pi-ai ${status.piAi.version}——能理解宿主 normalizeContext 后的 transcript 形状`
        : `插件解析到 pi-ai ${status.piAi.version}，过老：宿主（0.87+/1.x 世代）会把 system prompt 折进 messages，旧版 estimate 会以 reading 'length' 崩溃（workbuddy issue #24 同款）。请对齐宿主内置版本`
  });
  return { ...status, ok: checks.every((check) => check.ok), checks };
}
