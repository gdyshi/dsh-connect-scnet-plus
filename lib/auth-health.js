/**
 * Authorization health for the SCNet gateway.
 *
 * THE FAILURE THIS EXISTS FOR: nothing in the plugin ever asked the gateway
 * whether the discovered key is still accepted. When the scnet client's session
 * expired (or the key was revoked), the only symptom was a per-request failure
 * — and the failures actually seen in the field were *network* faults
 * (ETIMEDOUT, then "certificate has expired") surface as an opaque
 * `500 scnet_shim_error`, which reads exactly like "授权到期" in the UI. The
 * user then debugs the wrong layer.
 *
 * So: once a day, ask the gateway `GET /models` with the key we would send, and
 * record a verdict. When the verdict is "unauthorized", force one credential
 * re-scan — a re-login in the scnet client writes a NEW key file, and the plugin
 * should pick that up without a restart. Every other failure is classified as
 * network / TLS / timeout / rate-limit / upstream, so "授权" is never blamed for
 * a broken link.
 *
 * Pure module: no host peers, no network of its own (the probe is injected), so
 * `scripts/auth-health.test.mjs` asserts this real implementation with a clock
 * and a loopback mock.
 */

/** The default cadence: one authorization check per day. */
export const AUTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** One probe may not hang a session; /models answers in well under a second. */
export const AUTH_CHECK_TIMEOUT_MS = 15 * 1000;

/** First check after activation, so it does not compete with startup work. */
export const AUTH_CHECK_START_DELAY_MS = 10 * 1000;

/** A forced re-check (upstream 401) is debounced to this, per session. */
const AUTH_CHECK_FORCE_GAP_MS = 30 * 1000;

/**
 * Verdicts. `unchecked` only exists before the first probe.
 * @type {Record<string, string>}
 */
export const AUTH_VERDICT = {
  ok: "ok",
  unchecked: "unchecked",
  missingCredential: "missing-credential",
  unauthorized: "unauthorized",
  rateLimited: "rate-limited",
  upstreamError: "upstream-error",
  tls: "tls",
  timeout: "timeout",
  unreachable: "unreachable",
  unknown: "unknown"
};

/** Node network errno values that mean "the link is down", not "the key is bad". */
const NETWORK_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EHOSTUNREACH", "EHOSTDOWN",
  "ENETUNREACH", "ENETDOWN", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EADDRNOTAVAIL",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED"
]);

/** TLS leaf/chain problems. A wrong system clock or a proxy shows up here too. */
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_UNTRUSTED", "CERT_REVOKED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT", "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG", "EPROTO", "UND_ERR_TLS_CERT"
]);

/** Timeouts (DNS included: a dead resolver looks the same to the caller). */
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT", "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ABORT_ERR", "AbortError",
  "TimeoutError"
]);

/**
 * Dig the errno-ish code out of an error, its `cause` chain and fetch's
 * AggregateError, so a wrapped `TypeError: fetch failed` still yields
 * `ECONNREFUSED`.
 *
 * @param {unknown} error
 * @returns {string|undefined}
 */
export function errorCode(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.code === "string" && node.code !== "") return node.code;
    if (typeof node.name === "string" && (node.name === "AbortError" || node.name === "TimeoutError")) return node.name;
    if (node.name === "AggregateError" && Array.isArray(node.errors)) queue.push(...node.errors);
    if (node.cause !== undefined) queue.push(node.cause);
  }
  return undefined;
}

/**
 * Turn a probe failure into a verdict a human can act on.
 *
 * @param {{httpStatus?: number, error?: unknown}} [failure]
 * @returns {{verdict: string, ok: boolean, detail: string, hint: string, code?: string, httpStatus?: number, retryable: boolean}}
 */
export function classifyGatewayFailure(failure = {}) {
  const { httpStatus, error } = failure;
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  /**
   * The status may ride on the error itself: `fetchGatewayCatalog` throws an
   * Error carrying `httpStatus`, and that is the only place the 401 survives.
   * Reading just the argument would classify a real 401 as "unknown" and skip
   * the credential re-scan.
   */
  const status = Number.isFinite(httpStatus)
    ? Number(httpStatus)
    : Number.isFinite(error?.httpStatus) ? Number(error.httpStatus) : undefined;

  if (status === 401 || status === 403) {
    return {
      verdict: AUTH_VERDICT.unauthorized,
      ok: false,
      httpStatus: status,
      retryable: false,
      detail: status === 403
        ? "授权被拒绝：网关返回 403（key 无权访问或已被封禁）"
        : "授权失效：网关返回 401（key 已过期、被吊销，或客户端登录态已更换）",
      hint: "在 scnet 客户端重新登录一次即可；插件会自动重扫凭据，无需重启 DSH。"
    };
  }
  if (status === 429) {
    return {
      verdict: AUTH_VERDICT.rateLimited,
      ok: false,
      httpStatus: status,
      retryable: true,
      detail: "网关限流：返回 429",
      hint: "稍后重试即可，与授权无关。"
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      verdict: AUTH_VERDICT.upstreamError,
      ok: false,
      httpStatus: status,
      retryable: true,
      detail: `网关自身错误：返回 ${status}`,
      hint: "上游故障，稍后重试；与授权无关。"
    };
  }
  if (status !== undefined) {
    return {
      verdict: AUTH_VERDICT.unknown,
      ok: false,
      httpStatus: status,
      retryable: false,
      detail: `网关拒绝了探测请求：返回 ${status}`,
      hint: "请求形状可能已随上游变更失效，请运行 node lib/bin.js 查看原始响应。"
    };
  }
  if (code !== undefined && TLS_CODES.has(code)) {
    return {
      verdict: AUTH_VERDICT.tls,
      ok: false,
      code,
      retryable: true,
      detail: `TLS/证书错误（${code}）：到网关的安全连接没建立起来`,
      hint: "这不是授权问题：多为本机代理/中间设备证书、或系统时间不对；换网络或校准时间后重试。"
    };
  }
  if (code !== undefined && TIMEOUT_CODES.has(code)) {
    return {
      verdict: AUTH_VERDICT.timeout,
      ok: false,
      code,
      retryable: true,
      detail: `连接网关超时（${code}）`,
      hint: "这不是授权问题：网络很慢或被阻断，换网络/代理后重试。"
    };
  }
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return {
      verdict: AUTH_VERDICT.unreachable,
      ok: false,
      code,
      retryable: true,
      detail: `网络不可达（${code}）：本机连不上 api.scnet.cn:443`,
      hint: "这不是授权问题：检查网络、代理或 VPN 后重试。"
    };
  }
  return {
    verdict: AUTH_VERDICT.unknown,
    ok: false,
    ...(code === undefined ? {} : { code }),
    retryable: true,
    detail: message === "" ? "网关探测失败，原因未知" : `网关探测失败：${message}`,
    hint: "无法判定是授权还是网络问题；运行 node lib/bin.js 可复现详细诊断。"
  };
}

/** Probe result → model count, tolerating both probe shapes. */
function modelCountOf(result) {
  if (Array.isArray(result)) return result.length;
  if (Number.isFinite(result?.modelCount)) return result.modelCount;
  if (Number.isFinite(result?.count)) return result.count;
  return undefined;
}

/**
 * Daily authorization monitor.
 *
 * @param {object} options
 * @param {() => Promise<string|undefined>} options.resolveApiKey the key a live request would use
 * @param {(probe: {apiKey: string, signal: AbortSignal}) => Promise<unknown>} options.probe
 *   resolves when the gateway accepts the key, throws otherwise
 * @param {() => Promise<unknown>} [options.rediscover] force a credential re-scan
 * @param {{info?: function, warn?: function, error?: function}} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.intervalMs] default: once a day
 * @param {number} [options.timeoutMs]
 * @param {number} [options.startDelayMs]
 * @param {{setTimeout: function, clearTimeout: function, setInterval: function, clearInterval: function}} [options.timers]
 */
export function createAuthHealth(options = {}) {
  const {
    resolveApiKey,
    probe,
    rediscover,
    log = {},
    now = Date.now,
    intervalMs = AUTH_CHECK_INTERVAL_MS,
    timeoutMs = AUTH_CHECK_TIMEOUT_MS,
    startDelayMs = AUTH_CHECK_START_DELAY_MS,
    timers = { setTimeout, clearTimeout, setInterval, clearInterval }
  } = options;
  if (typeof resolveApiKey !== "function") throw new TypeError("createAuthHealth: resolveApiKey is required");
  if (typeof probe !== "function") throw new TypeError("createAuthHealth: probe is required");

  let state = {
    verdict: AUTH_VERDICT.unchecked,
    ok: false,
    detail: "尚未检查授权（每天检查一次）",
    checkedAt: undefined,
    intervalMs,
    checks: 0,
    consecutiveFailures: 0,
    recoveries: 0,
    latencyMs: undefined
  };
  let inflight = null;
  let firstTimer = null;
  let repeatTimer = null;

  /** Public, serializable view. Never contains the key. */
  function snapshot() {
    return {
      ...state,
      intervalMs,
      stale: state.checkedAt === undefined || now() - state.checkedAt >= intervalMs,
      ...(state.checkedAt === undefined ? {} : { nextCheckAt: state.checkedAt + intervalMs })
    };
  }

  /** One bounded probe; never throws. */
  async function runProbe(apiKey) {
    const startedAt = now();
    const controller = new AbortController();
    const abortTimer = timers.setTimeout(() => controller.abort(new Error("auth probe timed out")), timeoutMs);
    try {
      const result = await probe({ apiKey, signal: controller.signal });
      return { ok: true, modelCount: modelCountOf(result), latencyMs: now() - startedAt };
    } catch (error) {
      return { ok: false, error, latencyMs: now() - startedAt };
    } finally {
      timers.clearTimeout(abortTimer);
    }
  }

  /**
   * Commit a verdict and log only the transitions worth waking someone up for:
   * a fresh pass, a recovery, and every failure.
   */
  function record(next) {
    const previous = state;
    const ok = next.ok === true;
    state = {
      ...next,
      ok,
      checkedAt: now(),
      intervalMs,
      checks: previous.checks + 1,
      consecutiveFailures: ok ? 0 : previous.consecutiveFailures + 1,
      recoveries: previous.recoveries + (!ok || previous.ok || previous.checks === 0 ? 0 : 1),
      latencyMs: next.latencyMs
    };
    if (next.recovered === true) {
      // A re-scan that fixed a 401 is worth saying out loud even on the first run.
      log.info?.(`dsh-connect-scnet-plus: 授权恢复正常（${state.detail}）`);
    } else if (ok && previous.checks === 0) {
      log.info?.(`dsh-connect-scnet-plus: 授权检查通过（${state.detail}），每 ${Math.round(intervalMs / 3_600_000)} 小时复查一次`);
    } else if (ok) {
      log.info?.(`dsh-connect-scnet-plus: 授权恢复正常（${state.detail}）`);
    } else {
      log.warn?.(`dsh-connect-scnet-plus: 授权检查未通过（${state.verdict}）：${state.detail}${state.hint === undefined ? "" : ` ${state.hint}`}`);
    }
    return snapshot();
  }

  async function runCheck() {
    let apiKey;
    try {
      apiKey = await resolveApiKey();
    } catch (error) {
      return record({
        verdict: AUTH_VERDICT.unknown,
        ok: false,
        detail: `凭据解析失败：${String(error)}`,
        hint: "检查插件设置里的 apiKey，或确认 scnet 客户端已登录。"
      });
    }
    if (typeof apiKey !== "string" || apiKey === "") {
      return record({
        verdict: AUTH_VERDICT.missingCredential,
        ok: false,
        detail: "没有可用的 scnet 凭据，无法检查授权",
        hint: "在 scnet 客户端登录，或在插件设置里填写 apiKey。"
      });
    }

    let outcome = await runProbe(apiKey);
    if (outcome.ok) {
      return record({
        verdict: AUTH_VERDICT.ok,
        ok: true,
        detail: `网关接受当前凭据（GET /models 返回 ${outcome.modelCount ?? "?"} 个模型，${outcome.latencyMs}ms）`,
        latencyMs: outcome.latencyMs,
        ...(outcome.modelCount === undefined ? {} : { modelCount: outcome.modelCount })
      });
    }

    const failure = classifyGatewayFailure({ error: outcome.error });
    /**
     * A 401 is the one verdict with an automatic remedy: the scnet client may
     * have written a fresh key file (re-login) while our cached discovery still
     * points at the old one. Re-scan once; if the key changed, probe again.
     * If it did not change, the old key really is dead and the user has to log in.
     */
    if (failure.verdict === AUTH_VERDICT.unauthorized && typeof rediscover === "function") {
      let rescanned;
      try {
        rescanned = await rediscover();
      } catch (error) {
        log.warn?.("dsh-connect-scnet-plus: 授权失效后重扫凭据失败", error);
        rescanned = undefined;
      }
      let nextKey;
      try {
        nextKey = await resolveApiKey();
      } catch {
        nextKey = undefined;
      }
      if (typeof nextKey === "string" && nextKey !== "" && nextKey !== apiKey) {
        const retry = await runProbe(nextKey);
        if (retry.ok) {
          return record({
            verdict: AUTH_VERDICT.ok,
            ok: true,
            detail: `重扫凭据后授权恢复（新 key 已被网关接受，${retry.latencyMs}ms）`,
            latencyMs: retry.latencyMs,
            recovered: true,
            ...(retry.modelCount === undefined ? {} : { modelCount: retry.modelCount })
          });
        }
        const retryFailure = classifyGatewayFailure({ error: retry.error });
        return record({
          ...retryFailure,
          ok: false,
          detail: `${retryFailure.detail}（重扫到新 key 后仍然被拒）`,
          latencyMs: retry.latencyMs
        });
      }
      return record({
        ...failure,
        ok: false,
        detail: `${failure.detail}（已重扫凭据，key 未变化）`,
        latencyMs: outcome.latencyMs
      });
    }

    return record({ ...failure, ok: false, latencyMs: outcome.latencyMs });
  }

  /**
   * Check now, or reuse the last verdict when it is still fresh.
   * `force` bypasses the daily interval but not the short debounce that keeps a
   * burst of upstream 401s from turning into a probe storm.
   *
   * @param {{force?: boolean}} [options]
   */
  async function check({ force = false } = {}) {
    if (inflight !== null) return inflight;
    const age = state.checkedAt === undefined ? Infinity : now() - state.checkedAt;
    const due = state.checkedAt === undefined || age >= (force ? Math.min(AUTH_CHECK_FORCE_GAP_MS, intervalMs) : intervalMs);
    if (!due) return snapshot();
    inflight = runCheck().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /** Start the daily cadence: one check shortly after activation, then daily. */
  function start() {
    if (firstTimer !== null || repeatTimer !== null) return stop;
    firstTimer = timers.setTimeout(() => {
      firstTimer = null;
      void check({ force: true });
    }, startDelayMs);
    firstTimer?.unref?.();
    repeatTimer = timers.setInterval(() => {
      void check({ force: true });
    }, intervalMs);
    repeatTimer?.unref?.();
    return stop;
  }

  function stop() {
    if (firstTimer !== null) timers.clearTimeout(firstTimer);
    if (repeatTimer !== null) timers.clearInterval(repeatTimer);
    firstTimer = null;
    repeatTimer = null;
  }

  return { check, snapshot, start, stop, intervalMs };
}
