/**
 * SCNet model catalog.
 *
 * Priority: the local cache written by the scnet tooling
 * (`~/.sclaw/agent/models.json` → `providers.scnet.models`, filtered by
 * `visibleModelIds`), falling back to the gateway's OpenAI-compatible
 * `GET /models`. Results are cached in memory for 10 minutes.
 * Read-only: this module never writes models.json.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCNET_GATEWAY_BASE = "https://api.scnet.cn/api/llm/v1";
export const MODELS_CACHE_PATH = join(homedir(), ".sclaw", "agent", "models.json");
export const CATALOG_TTL_MS = 10 * 60 * 1000;

let cache = { at: 0, catalog: [] };

/** Does a local entry declare image input? */
function supportsImage(entry) {
  return Array.isArray(entry.input) && entry.input.some((m) => String(m).toLowerCase() === "image");
}

/** DSH-facing display name: free models are marked, per the tags/priceLabel. */
export function scnetDisplayName(entry) {
  const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : String(entry.id);
  if (entry.priceLabel === "free") return `${name} · 免费`;
  return name;
}

/** Normalize one local-cache entry into the plugin's catalog shape. */
export function normalizeLocalModel(entry) {
  if (entry === null || typeof entry !== "object" || typeof entry.id !== "string") return undefined;
  const contextWindow = Number.isFinite(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : 128000;
  const maxTokens = Number.isFinite(entry.maxTokens) && entry.maxTokens > 0 ? entry.maxTokens : Math.min(contextWindow, 8192);
  return {
    id: entry.id,
    name: scnetDisplayName(entry),
    contextWindow,
    maxTokens,
    image: supportsImage(entry),
    tags: Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === "string") : [],
    priceLabel: typeof entry.priceLabel === "string" ? entry.priceLabel : undefined,
    reasoning: entry.reasoning === true || (Array.isArray(entry.tags) && entry.tags.includes("深度思考"))
  };
}

/**
 * Read the local models.json cache.
 * @returns {Promise<Array>} normalized entries, empty when unreadable.
 */
export async function loadLocalCatalog(path = MODELS_CACHE_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  const provider = parsed?.providers?.scnet;
  if (provider === null || typeof provider !== "object" || !Array.isArray(provider.models)) return [];
  const visible = Array.isArray(provider.visibleModelIds)
    ? new Set(provider.visibleModelIds)
    : undefined;
  const out = [];
  const seen = new Set();
  for (const entry of provider.models) {
    const model = normalizeLocalModel(entry);
    if (model === undefined || seen.has(model.id)) continue;
    if (visible !== undefined && !visible.has(entry.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/** Fetch the gateway's OpenAI-compatible model list. Minimal metadata only. */
export async function fetchGatewayCatalog({ apiKey, base = SCNET_GATEWAY_BASE, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
  const response = await fetchImpl(`${base}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal
  });
  if (!response.ok) throw new Error(`gateway /models answered ${response.status}`);
  const body = await response.json();
  const data = Array.isArray(body?.data) ? body.data : [];
  return data
    .filter((entry) => typeof entry?.id === "string")
    .map((entry) => normalizeLocalModel({ id: entry.id, name: entry.id }));
}

/**
 * The catalog the provider serves: cache → local file → gateway.
 * @param {{apiKey?: string, force?: boolean, now?: () => number}} [options]
 */
export async function getCatalog(options = {}) {
  const now = options.now ?? Date.now;
  if (!options.force && cache.at > 0 && now() - cache.at < CATALOG_TTL_MS && cache.catalog.length > 0) {
    return { source: "cache", catalog: cache.catalog };
  }
  const local = await loadLocalCatalog();
  if (local.length > 0) {
    cache = { at: now(), catalog: local };
    return { source: "local-file", catalog: local };
  }
  if (typeof options.apiKey === "string" && options.apiKey !== "") {
    const gateway = await fetchGatewayCatalog({ apiKey: options.apiKey, signal: options.signal });
    if (gateway.length > 0) {
      cache = { at: now(), catalog: gateway };
      return { source: "gateway", catalog: gateway };
    }
  }
  return { source: cache.catalog.length > 0 ? "cache-stale" : "none", catalog: cache.catalog };
}

/**
 * Apply the user's model selection to a catalog.
 *
 * Semantics mirror dsh-connect-workbuddy's `enabledModelIds`: an EMPTY list
 * means "no selection was ever made" and therefore shows everything — a
 * non-empty list is an explicit allowlist. Unknown ids are ignored (a model
 * the upstream withdrew must not break the picker), and duplicates in the
 * selection are harmless.
 *
 * @param {Array} catalog - normalized catalog entries.
 * @param {Array<string>|undefined|null} enabledIds - the configured allowlist.
 * @returns {Array} the entries whose id is enabled.
 */
export function filterCatalogBySelection(catalog, enabledIds) {
  if (!Array.isArray(enabledIds) || enabledIds.length === 0) return catalog;
  const enabled = new Set(
    enabledIds
      .filter((id) => typeof id === "string")
      .map((id) => id.trim())
      .filter((id) => id !== "")
  );
  if (enabled.size === 0) return catalog;
  return catalog.filter((entry) => enabled.has(entry.id));
}

/** Model ids the per-model switches explicitly turned ON. */
export function enabledModelIdsFromSwitches(switches) {
  if (switches === null || typeof switches !== "object") return new Set();
  return new Set(Object.entries(switches).filter(([, on]) => on === true).map(([id]) => id));
}

/**
 * Apply BOTH selection mechanisms the plugin exposes.
 *
 * - `modelSwitches`: the settings card's per-model checkboxes. The card starts
 *   with NOTHING checked, and "nothing checked" means "the user never
 *   narrowed the list" — every model stays available. The moment at least one
 *   box is `true`, the switches become an explicit allowlist and only those
 *   models are served. This keeps the default (empty) state from blanking the
 *   model picker while still letting the user narrow down to a single model.
 * - `enabledModelIds`: the legacy advanced allowlist; empty means "no filter".
 *   When non-empty it narrows further.
 *
 * They compose as an intersection. Unknown ids never throw.
 *
 * @param {Array} catalog - normalized catalog entries.
 * @param {{enabledModelIds?: Array<string>, modelSwitches?: object}} [selection]
 * @returns {Array} the entries the picker should offer.
 */
export function applyModelSelection(catalog, selection = {}) {
  const enabled = enabledModelIdsFromSwitches(selection?.modelSwitches);
  const base = enabled.size === 0 ? catalog : catalog.filter((entry) => enabled.has(entry.id));
  return filterCatalogBySelection(base, selection?.enabledModelIds);
}

/** Test hook: reset the in-memory cache. */
export function resetCatalogCache() {
  cache = { at: 0, catalog: [] };
}
