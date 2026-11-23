#!/usr/bin/env node
/**
 * Authorization health, asserted against the SHIPPED implementation
 * (lib/auth-health.js, lib/catalog.js, lib/shim.js, lib/doctor.js).
 *
 * WHY this gate exists: the field report was "SCNet 网络提示错误，应该是授权到期了"
 * while the gateway was happily accepting the key — the real faults were
 * ETIMEDOUT / "certificate has expired" surfaced as an opaque
 * `500 scnet_shim_error`. Two things must therefore stay true:
 *
 *   ① a failure is classified by LAYER (authorization vs TLS vs timeout vs
 *     unreachable vs 5xx), so "授权" is never blamed for a broken link;
 *   ② someone asks the gateway whether the key still works, once a day, and a
 *     401 triggers exactly one credential re-scan (a re-login writes a new key
 *     file) — never a probe storm.
 *
 * Hermetic: no network except loopback mocks started here, no ~/.sclaw, no host
 * peers, injected clock and timers.
 *
 * Usage: node scripts/auth-health.test.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  AUTH_CHECK_INTERVAL_MS,
  AUTH_VERDICT,
  classifyGatewayFailure,
  createAuthHealth,
  errorCode
} from "../lib/auth-health.js";
import { fetchGatewayCatalog } from "../lib/catalog.js";
import { collectStatus, runDoctor } from "../lib/doctor.js";
import { createScnetShim } from "../lib/shim.js";

/** Let every pending microtask/immediate settle. */
async function drain() {
  for (let index = 0; index < 25; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Fake clock + fake timers, so the daily cadence is asserted in milliseconds. */
function fakeClock(start = 1_700_000_000_000) {
  let time = start;
  let nextId = 0;
  const pending = new Map();
  const timers = {
    setTimeout(fn, delay) {
      const handle = ++nextId;
      pending.set(handle, { fn, at: time + delay, every: undefined });
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    setInterval(fn, delay) {
      const handle = ++nextId;
      pending.set(handle, { fn, at: time + delay, every: delay });
      return handle;
    },
    clearInterval(handle) {
      pending.delete(handle);
    }
  };
  return {
    now: () => time,
    timers,
    pending: () => pending.size,
    /** Advance the clock, firing everything that comes due on the way. */
    async advance(ms) {
      const target = time + ms;
      time = target;
      for (const [handle, entry] of [...pending]) {
        if (entry.at > target) continue;
        if (entry.every === undefined) pending.delete(handle);
        else entry.at = target + entry.every;
        entry.fn();
        await drain();
      }
      await drain();
    }
  };
}

/** Collect log lines so the test can assert what an operator would read. */
function recorder() {
  const lines = [];
  return {
    lines,
    info: (message) => lines.push({ level: "info", message }),
    warn: (message, error) => lines.push({ level: "warn", message, error }),
    of(level) {
      return lines.filter((line) => line.level === level);
    }
  };
}

/** Minimal loopback HTTP mock; returns its port and a close(). */
function startMock(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/** A loopback port that is guaranteed closed right now. */
async function closedPort() {
  const mock = await startMock((req, res) => res.end("unused"));
  await mock.close();
  return mock.port;
}

const CREDENTIALS = { source: "files", accounts: [{ file: "test.json", key: "sk-abcdefghijklmnop" }] };
const NO_CREDENTIALS = { source: "none", accounts: [] };
const CATALOG = {
  source: "local-file",
  catalog: [{ id: "scnet-chat", name: "scnet-chat", contextWindow: 128000, maxTokens: 8192, image: false, tags: [] }]
};

// ① classification: the verdict names the LAYER, and only 401/403 blames 授权.
{
  const unauthorized = classifyGatewayFailure({ httpStatus: 401, error: new Error("gateway /models answered 401") });
  assert.equal(unauthorized.verdict, AUTH_VERDICT.unauthorized);
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.httpStatus, 401);
  assert.equal(unauthorized.retryable, false);
  assert.match(unauthorized.detail, /401/);
  assert.match(unauthorized.hint, /重新登录/);
  assert.equal(classifyGatewayFailure({ httpStatus: 403 }).verdict, AUTH_VERDICT.unauthorized);

  const rateLimited = classifyGatewayFailure({ httpStatus: 429 });
  assert.equal(rateLimited.verdict, AUTH_VERDICT.rateLimited);
  assert.equal(rateLimited.retryable, true);
  assert.match(rateLimited.hint, /与授权无关/);

  const upstream = classifyGatewayFailure({ httpStatus: 503 });
  assert.equal(upstream.verdict, AUTH_VERDICT.upstreamError);
  assert.match(upstream.hint, /与授权无关/);

  assert.equal(classifyGatewayFailure({ httpStatus: 418 }).verdict, AUTH_VERDICT.unknown);
  console.log("PASS: ① HTTP status → verdict（401/403 才是授权）");
}

// ② transport errors are classified through fetch's wrappers, and each says
//    "not an authorization problem" in words an operator can act on.
{
  const expired = Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" })
  });
  assert.equal(errorCode(expired), "CERT_HAS_EXPIRED", "cause chain is walked");
  const tls = classifyGatewayFailure({ error: expired });
  assert.equal(tls.verdict, AUTH_VERDICT.tls);
  assert.equal(tls.code, "CERT_HAS_EXPIRED");
  assert.match(tls.hint, /这不是授权问题/);

  const aggregated = Object.assign(new Error("fetch failed"), {
    name: "AggregateError",
    errors: [Object.assign(new Error("tls alert"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })]
  });
  assert.equal(classifyGatewayFailure({ error: aggregated }).verdict, AUTH_VERDICT.tls);

  const timedOut = Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("connect ETIMEDOUT 223.68.195.135:443"), { code: "ETIMEDOUT" })
  });
  const timeout = classifyGatewayFailure({ error: timedOut });
  assert.equal(timeout.verdict, AUTH_VERDICT.timeout);
  assert.match(timeout.hint, /这不是授权问题/);

  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
  const unreachable = classifyGatewayFailure({ error: refused });
  assert.equal(unreachable.verdict, AUTH_VERDICT.unreachable);
  assert.match(unreachable.detail, /ECONNREFUSED/);
  assert.match(unreachable.hint, /这不是授权问题/);

  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(classifyGatewayFailure({ error: aborted }).verdict, AUTH_VERDICT.timeout);
  assert.equal(classifyGatewayFailure({}).verdict, AUTH_VERDICT.unknown);
  console.log("PASS: ② TLS / 超时 / 不可达 均判为「不是授权问题」");
}

// ③ the 401 the gateway really returns survives the catalog fetch as a status.
{
  const mock = await startMock((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Authentication Failed", type: "invalid_request_error", code: "401" } }));
  });
  try {
    await assert.rejects(
      fetchGatewayCatalog({ apiKey: "sk-bogus", base: `http://127.0.0.1:${mock.port}/api/llm/v1` }),
      (error) => {
        assert.equal(error.httpStatus, 401, "the HTTP status must reach the classifier");
        assert.match(error.message, /answered 401/);
        return true;
      }
    );
    const verdict = classifyGatewayFailure({ httpStatus: 401 });
    assert.equal(verdict.verdict, AUTH_VERDICT.unauthorized);
  } finally {
    await mock.close();
  }
  console.log("PASS: ③ /models 401 带着 httpStatus=401 抛出");
}

// ④ the shim reports a dead gateway as a classified 502, not a raw 500 dump.
{
  const port = await closedPort();
  const logs = recorder();
  const shim = createScnetShim({
    resolveApiKey: async () => "sk-abcdefghijklmnop",
    getModels: () => [],
    gatewayHost: "127.0.0.1",
    gatewayPort: port,
    logger: logs
  });
  await shim.ready;
  try {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: "scnet-chat", messages: [{ role: "user", content: "hi" }] })
    });
    const body = await response.json();
    assert.equal(response.status, 502, "an unreachable gateway is a 502, not a 500");
    assert.equal(body.error.type, "scnet_gateway_error");
    assert.equal(body.error.verdict, AUTH_VERDICT.unreachable);
    assert.match(body.error.message, /ECONNREFUSED/);
    assert.match(body.error.message, /这不是授权问题/);
    assert.ok(logs.of("warn").some((line) => /网关失败（unreachable/.test(line.message)), "the transition is logged");
  } finally {
    shim.close();
  }
  console.log("PASS: ④ 网关不可达 → 502 scnet_gateway_error（可诊断，不再裸 500）");
}

// ⑤ an upstream 401 still passes through unchanged, AND wakes the auth monitor.
{
  const upstreamBody = JSON.stringify({ error: { message: "Authentication Failed", code: "401" } });
  const mock = await startMock((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(upstreamBody);
  });
  const seen = [];
  const shim = createScnetShim({
    resolveApiKey: async () => "sk-abcdefghijklmnop",
    getModels: () => [],
    gatewayHost: "127.0.0.1",
    gatewayPort: mock.port,
    onUpstreamStatus: (status) => seen.push(status),
    logger: recorder()
  });
  await shim.ready;
  try {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
      body: "{}"
    });
    assert.equal(response.status, 401);
    assert.equal(await response.text(), upstreamBody, "the gateway body is never rewritten");
    assert.deepEqual(seen, [401], "the host is told about the gateway status");
  } finally {
    shim.close();
    await mock.close();
  }
  console.log("PASS: ⑤ 上游 401 原样透传，并触发 onUpstreamStatus(401)");
}

// ⑥ the daily cadence: probe once, reuse, then probe again after 24h.
{
  const clock = fakeClock();
  const logs = recorder();
  let probes = 0;
  const health = createAuthHealth({
    resolveApiKey: async () => "sk-abcdefghijklmnop",
    probe: async () => {
      probes += 1;
      return [{ id: "a" }, { id: "b" }];
    },
    now: clock.now,
    timers: clock.timers,
    log: logs
  });
  assert.equal(health.intervalMs, AUTH_CHECK_INTERVAL_MS);
  assert.equal(health.snapshot().verdict, AUTH_VERDICT.unchecked);
  assert.equal(health.snapshot().stale, true);

  const first = await health.check();
  assert.equal(probes, 1);
  assert.equal(first.verdict, AUTH_VERDICT.ok);
  assert.equal(first.ok, true);
  assert.equal(first.modelCount, 2);
  assert.equal(first.stale, false);
  assert.equal(first.nextCheckAt, clock.now() + AUTH_CHECK_INTERVAL_MS);
  assert.ok(logs.of("info").some((line) => /授权检查通过/.test(line.message)));

  await health.check();
  assert.equal(probes, 1, "a fresh verdict is reused — no probe per request");
  await health.check({ force: true });
  assert.equal(probes, 1, "a forced check is debounced: no probe storm from upstream 401s");

  await clock.advance(AUTH_CHECK_INTERVAL_MS);
  assert.equal(health.snapshot().stale, true);
  const second = await health.check();
  assert.equal(probes, 2, "the daily interval yields a new probe");
  assert.equal(second.verdict, AUTH_VERDICT.ok);
  console.log("PASS: ⑥ 每天一次：首检 → 复用 → 24h 后复查");
}

// ⑦ start(): first check after the activation delay, then on the daily timer,
//    and stop() really cancels it.
{
  const clock = fakeClock();
  let probes = 0;
  const health = createAuthHealth({
    resolveApiKey: async () => "sk-abcdefghijklmnop",
    probe: async () => {
      probes += 1;
      return [];
    },
    now: clock.now,
    timers: clock.timers,
    log: recorder()
  });
  const stop = health.start();
  await clock.advance(9_000);
  assert.equal(probes, 0, "the first check waits for the start delay");
  await clock.advance(1_500);
  assert.equal(probes, 1, "the first check runs shortly after activation");
  await clock.advance(AUTH_CHECK_INTERVAL_MS);
  assert.equal(probes, 2, "then once a day");
  stop();
  await clock.advance(AUTH_CHECK_INTERVAL_MS * 3);
  assert.equal(probes, 2, "stop() cancels the daily timer");
  console.log("PASS: ⑦ start()/stop() 的定时器只跑一次/天");
}

// ⑧ 401 → exactly one credential re-scan; a NEW working key recovers on the spot.
{
  let key = "sk-old-key-000000";
  let rescans = 0;
  const probed = [];
  const logs = recorder();
  const health = createAuthHealth({
    resolveApiKey: async () => key,
    probe: async ({ apiKey }) => {
      probed.push(apiKey);
      if (apiKey === "sk-old-key-000000") throw Object.assign(new Error("gateway /models answered 401"), { httpStatus: 401 });
      return [{ id: "m1" }];
    },
    rediscover: async () => {
      rescans += 1;
      key = "sk-new-key-111111";
    },
    log: logs
  });
  const snapshot = await health.check();
  assert.equal(rescans, 1);
  assert.deepEqual(probed, ["sk-old-key-000000", "sk-new-key-111111"]);
  assert.equal(snapshot.verdict, AUTH_VERDICT.ok);
  assert.equal(snapshot.recovered, true);
  assert.match(snapshot.detail, /重扫凭据后授权恢复/);
  assert.ok(logs.of("info").some((line) => /授权恢复正常/.test(line.message)));
  console.log("PASS: ⑧ 401 → 重扫凭据 → 新 key 可用即恢复");
}

// ⑨ 401 with an unchanged key stays unauthorized, and says what to do.
{
  const logs = recorder();
  let rescans = 0;
  const health = createAuthHealth({
    resolveApiKey: async () => "sk-dead-key-222222",
    probe: async () => {
      throw Object.assign(new Error("gateway /models answered 401"), { httpStatus: 401 });
    },
    rediscover: async () => {
      rescans += 1;
    },
    log: logs
  });
  const snapshot = await health.check();
  assert.equal(rescans, 1, "one re-scan, not a loop");
  assert.equal(snapshot.verdict, AUTH_VERDICT.unauthorized);
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.detail, /已重扫凭据，key 未变化/);
  const warnings = logs.of("warn");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /授权检查未通过/);
  assert.match(warnings[0].message, /重新登录/);
  console.log("PASS: ⑨ key 未变 → 判 unauthorized，并给出重新登录指引");
}

// ⑩ no credential is its own verdict — not a network error, not a 401 probe.
{
  let probes = 0;
  const health = createAuthHealth({
    resolveApiKey: async () => undefined,
    probe: async () => {
      probes += 1;
      return [];
    },
    log: recorder()
  });
  const snapshot = await health.check();
  assert.equal(probes, 0, "no key, no pointless probe");
  assert.equal(snapshot.verdict, AUTH_VERDICT.missingCredential);
  assert.match(snapshot.hint, /登录/);
  console.log("PASS: ⑩ 无凭据 → missing-credential（不探测、不误判网络）");
}

// ⑪ collectStatus: the CLI derives the same verdict from its gateway probe, and
//    the running plugin's daily snapshot wins when injected.
{
  const failed = await collectStatus({
    credentials: CREDENTIALS,
    catalog: CATALOG,
    gateway: { ok: false, error: "gateway /models answered 401", httpStatus: 401 }
  });
  assert.equal(failed.authorization.verdict, AUTH_VERDICT.unauthorized);
  assert.equal(failed.authorization.ok, false);
  assert.match(failed.authorization.hint, /重新登录/);

  const ok = await collectStatus({ credentials: CREDENTIALS, catalog: CATALOG, gateway: { ok: true, modelCount: 2 } });
  assert.equal(ok.authorization.verdict, AUTH_VERDICT.ok);
  assert.match(ok.authorization.detail, /网关接受当前凭据/);

  const injected = { verdict: AUTH_VERDICT.timeout, ok: false, detail: "injected by the daily monitor" };
  const passed = await collectStatus({ credentials: CREDENTIALS, catalog: CATALOG, gateway: { ok: true, modelCount: 2 }, authorization: injected });
  assert.equal(passed.authorization.detail, "injected by the daily monitor");

  const empty = await collectStatus({ credentials: NO_CREDENTIALS, catalog: CATALOG });
  assert.equal(empty.authorization.verdict, AUTH_VERDICT.missingCredential);
  console.log("PASS: ⑪ collectStatus 的 authorization 段（派生 + 注入）");
}

// ⑫ runDoctor exposes it as a first-class check (host detail page + `bin.js`).
{
  const report = await runDoctor({ credentials: CREDENTIALS, catalog: CATALOG, gateway: { ok: true, modelCount: 2 } });
  const check = report.checks.find((entry) => entry.name === "authorization");
  assert.ok(check !== undefined, "an authorization check must exist");
  assert.equal(check.ok, true);
  assert.match(check.detail, /每天自动复核/);

  const failing = await runDoctor({
    credentials: CREDENTIALS,
    catalog: CATALOG,
    gateway: { ok: false, error: "gateway /models answered 401", httpStatus: 401 }
  });
  const failedCheck = failing.checks.find((entry) => entry.name === "authorization");
  assert.equal(failedCheck.ok, false);
  assert.match(failedCheck.detail, /重新登录/);
  assert.equal(failing.ok, false, "a dead key makes doctor fail");
  console.log("PASS: ⑫ runDoctor 输出 authorization 检查项");
}

console.log("\nALL AUTHORIZATION HEALTH PASS");
