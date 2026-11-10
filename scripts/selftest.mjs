#!/usr/bin/env node
/**
 * Unit self-test: credential discovery, catalog normalization, shim guards and
 * forwarding against a local mock upstream. No network beyond loopback except
 * the optional real-catalog check (read-only file).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import { discoverCredentials, maskKey } from "../lib/credentials.js";
import { normalizeLocalModel, loadLocalCatalog, scnetDisplayName, getCatalog, resetCatalogCache, filterCatalogBySelection, applyModelSelection, enabledModelIdsFromSwitches } from "../lib/catalog.js";
import { createScnetShim } from "../lib/shim.js";

let passed = 0;
function ok(label) {
  passed++;
  console.log("PASS", label);
}

// --- credentials -----------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "scnet-cred-"));
writeFileSync(join(dir, "a.json"), JSON.stringify({ scnet: { type: "api_key", key: "sk-aaaabbbbccccdddd" } }));
writeFileSync(join(dir, "b.json"), JSON.stringify({ scnet: { type: "api_key", key: "sk-eeeeffffgggghhhh" }, other: { type: "oauth", key: "not-this" } }));
writeFileSync(join(dir, "broken.json"), "{ not json");

const found = await discoverCredentials({ dir });
assert.equal(found.source, "files");
assert.equal(found.accounts.length, 2);
ok("credentials: file scan finds both api_key entries");

const masked = maskKey("sk-aaaabbbbccccdddd");
assert.ok(masked === "sk-aaa…dddd");
ok(`credentials: key masked as ${masked}`);

const manual = await discoverCredentials({ apiKey: " sk-manual " });
assert.equal(manual.source, "config");
assert.equal(manual.accounts[0].key, "sk-manual");
ok("credentials: explicit apiKey wins");

const empty = await discoverCredentials({ dir: join(dir, "missing") });
assert.deepEqual(empty, { source: "none", accounts: [] });
ok("credentials: missing dir answers none");

// --- catalog ---------------------------------------------------------------
assert.equal(scnetDisplayName({ id: "x", name: "SCNet-Max", priceLabel: "free" }), "SCNet-Max · 免费");
const norm = normalizeLocalModel({
  id: "m1", name: "Kimi-K3", input: ["text", "image"], contextWindow: 262144, maxTokens: 8192,
  tags: ["深度思考"], priceLabel: "none"
});
assert.equal(norm.image, true);
assert.equal(norm.reasoning, true);
assert.equal(norm.contextWindow, 262144);
ok("catalog: normalization (image / reasoning / free label)");

const defaults = normalizeLocalModel({ id: "m2" });
assert.equal(defaults.contextWindow, 128000);
assert.equal(defaults.image, false);
ok("catalog: defaults for minimal entry");

// read the real local cache (read-only) when present
const local = await loadLocalCatalog();
console.log(`catalog: local models.json yields ${local.length} visible models`);
assert.ok(local.length === 0 || local.every((m) => typeof m.id === "string"));
ok("catalog: local cache read is safe (0 or normalized models)");

// cache path + TTL
resetCatalogCache();
const first = await getCatalog({}); // local file → cached
const second = await getCatalog({}); // served from cache
if (local.length > 0) {
  assert.equal(first.source, "local-file");
  assert.equal(second.source, "cache");
  ok("catalog: 10-min cache serves repeat reads");

// --- model selection (enabledModelIds) -------------------------------------
const sample = [
  { id: "SCNet-Max", name: "SCNet-Max" },
  { id: "Kimi-K3", name: "Kimi-K3" },
  { id: "Qwen3.8-Max", name: "Qwen3.8-Max" }
];
assert.deepEqual(filterCatalogBySelection(sample, []).map((m) => m.id), sample.map((m) => m.id));
ok("selection: empty allowlist keeps every model (never configured = show all)");

assert.deepEqual(filterCatalogBySelection(sample, ["Kimi-K3"]).map((m) => m.id), ["Kimi-K3"]);
ok("selection: non-empty allowlist narrows to exactly those ids");

assert.deepEqual(filterCatalogBySelection(sample, ["Kimi-K3", "Gone-Model", "Kimi-K3"]).map((m) => m.id), ["Kimi-K3"]);
ok("selection: unknown ids and duplicates are harmless");

assert.deepEqual(filterCatalogBySelection(sample, ["", "  "]).map((m) => m.id), sample.map((m) => m.id));
ok("selection: blank entries count as no selection, not as a dead filter");

assert.deepEqual(filterCatalogBySelection(sample, undefined).map((m) => m.id), sample.map((m) => m.id));
ok("selection: an absent field behaves like an empty one");

// --- per-model switches (modelSwitches: checked = allowlist) ---------------
assert.deepEqual(applyModelSelection(sample, { modelSwitches: { "Kimi-K3": true } }).map((m) => m.id), ["Kimi-K3"]);
ok("switches: an explicit true narrows to that model");

assert.deepEqual(applyModelSelection(sample, { modelSwitches: { "Kimi-K3": true, "SCNet-Max": true } }).map((m) => m.id), ["SCNet-Max", "Kimi-K3"]);
ok("switches: several true ids narrow to exactly those");

assert.deepEqual(applyModelSelection(sample, { modelSwitches: {} }).map((m) => m.id), sample.map((m) => m.id));
ok("switches: empty map = no filter (fresh install never blanks the picker)");

assert.deepEqual(applyModelSelection(sample, { enabledModelIds: ["Kimi-K3", "SCNet-Max"], modelSwitches: { "Kimi-K3": true } }).map((m) => m.id), ["Kimi-K3"]);
ok("switches + allowlist compose as an intersection");

assert.deepEqual(applyModelSelection(sample, { modelSwitches: { "Unknown-Model": true } }).map((m) => m.id), []);
ok("switches: an unknown true narrows to nothing (never enables a ghost)");

assert.deepEqual([...enabledModelIdsFromSwitches(undefined)], []);
assert.deepEqual([...enabledModelIdsFromSwitches({ a: true, b: false, c: null })], ["a"]);
ok("switches: enabled-id extraction keeps only an explicit true");
} else {
  ok("catalog: no local cache present; gateway path untested here");
}

// --- shim ------------------------------------------------------------------
// mock upstream capturing the Authorization header
let upstreamAuth = "";
const upstream = createServer((req, res) => {
  upstreamAuth = req.headers.authorization;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echo: JSON.parse(body || "{}"), ok: true }));
  });
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;

const shim = createScnetShim({
  resolveApiKey: async () => "sk-real-key",
  getModels: () => [{ id: "m1" }, { id: "m2" }],
  status: async () => ({ ok: true, modelCount: 2 }),
  gatewayHost: "127.0.0.1",
  gatewayPort: upstreamPort,
  gatewaySecure: false
});
await shim.ready;

const secret = shim.token();
const base = shim.baseUrl();

// bad bearer rejected
const bad = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer nope" } });
assert.equal(bad.status, 401);
ok("shim: wrong bearer → 401");

// models served locally
const modelsRes = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
const modelsBody = await modelsRes.json();
assert.deepEqual(modelsBody.data.map((m) => m.id), ["m1", "m2"]);
ok("shim: GET /v1/models served from catalog");

// status endpoint
const statusRes = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${secret}` } });
assert.equal((await statusRes.json()).modelCount, 2);
ok("shim: GET /status diagnostics");

// forwarding replaces Authorization, passes body through
const chat = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })
});
const chatBody = await chat.json();
assert.equal(upstreamAuth, "Bearer sk-real-key");
assert.equal(chatBody.echo.model, "m1");
ok("shim: POST forwarded with real key injected, body intact");

// The thinking plumbing only works if the shim relays these fields verbatim:
// pi-ai writes them, the shim forwards them, the gateway acts on them. A shim
// that rebuilt the body from a known-fields list would silently drop the tier
// and put us back to "the picker changes nothing".
const thinkingRes = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body: JSON.stringify({
    model: "m1",
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
    reasoning_effort: "high"
  })
});
const thinkingBody = await thinkingRes.json();
assert.deepEqual(thinkingBody.echo.thinking, { type: "disabled" });
assert.equal(thinkingBody.echo.reasoning_effort, "high");
ok("shim: thinking / reasoning_effort reach upstream verbatim");

// wrong content-type refused
const wrongCt = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "text/plain", authorization: `Bearer ${secret}` },
  body: "x"
});
assert.equal(wrongCt.status, 415);
ok("shim: non-JSON content-type → 415");

// wrong host header refused (raw socket, bypassing fetch header rules)
import { request as rawRequest } from "node:http";
const badHostStatus = await new Promise((resolve, reject) => {
  const { port } = new URL(base);
  const req = rawRequest({ host: "127.0.0.1", port, path: "/v1/models", headers: { host: "evil.example.com", authorization: `Bearer ${secret}` } }, (res) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode));
  });
  req.on("error", reject);
  req.end();
});
assert.equal(badHostStatus, 403);
ok("shim: non-loopback Host refused");

shim.close();
upstream.close();
ok("shim: clean shutdown");

console.log(`\n${passed} checks passed`);
