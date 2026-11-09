/**
 * Safety loopback shim for the SCNet gateway.
 *
 * Modeled on the dsh-connect-workbuddy shim pattern: a node:http server on
 * 127.0.0.1 at a random port guarded by a random per-process bearer secret.
 * The DSH provider's models point their baseUrl at this shim; the shim
 * REPLACES the Authorization header with the real scnet key and forwards to
 * `https://api.scnet.cn/api/llm/v1/...`, piping the upstream response (SSE
 * included) straight back. The sk-key therefore never reaches DSH settings.
 *
 * Guards (all fail closed):
 *   - Host header must name the loopback interface
 *   - Origin header, when present, must be a loopback origin
 *   - Authorization bearer must equal the process-local shared secret
 *     (constant-time comparison)
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const SCNET_GATEWAY_HOST = "api.scnet.cn";

function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const hostname = host.split(":", 1)[0].toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function isLoopbackOrigin(origin) {
  if (typeof origin !== "string" || origin === "") return true; // non-browser clients send none
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function bearerOf(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? undefined : match[1];
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function writeJson(res, status, payload) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function writeOpenAIError(res, status, message) {
  writeJson(res, status, { error: { message, type: "scnet_shim_error", code: status } });
}

/** Read the full request body (JSON, bounded). */
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {object} options
 * @param {() => Promise<string|undefined>} options.resolveApiKey called per request
 * @param {() => Array<{id: string}>} options.getModels served on GET /v1/models
 * @param {() => object|Promise<object>} [options.status] served on GET /status
 * @param {{warn?: function, error?: function}} [options.logger]
 * @param {string} [options.gatewayHost]
 */
export function createScnetShim(options) {
  const { resolveApiKey, getModels } = options;
  const logger = options.logger ?? {};
  const gatewayHost = options.gatewayHost ?? SCNET_GATEWAY_HOST;
  const gatewayPort = options.gatewayPort ?? 443;
  const gatewaySecure = options.gatewaySecure ?? gatewayPort === 443;
  const SHARED_SECRET = randomBytes(32).toString("base64url");
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error?.("dsh-connect-scnet-plus: shim handler failed", error);
      if (!res.headersSent) writeOpenAIError(res, 500, String(error));
      else res.end();
    });
  });
  let disposed = false;
  server.on("error", (error) => {
    logger.error?.("dsh-connect-scnet-plus: loopback listener error", error);
  });
  const ready = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("scnet shim has no listening address");
    return `http://127.0.0.1:${address.port}`;
  };

  async function handle(req, res) {
    if (!isLoopbackHost(req.headers.host)) {
      writeOpenAIError(res, 403, "Host header must name the loopback interface");
      return;
    }
    if (!isLoopbackOrigin(req.headers.origin)) {
      writeOpenAIError(res, 403, "Origin must be a loopback origin");
      return;
    }
    const bearer = bearerOf(req);
    if (bearer === undefined || !constantTimeEqual(bearer, SHARED_SECRET)) {
      writeOpenAIError(res, 401, "missing or invalid Authorization bearer");
      return;
    }
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && (url === "/status" || url === "/status/")) {
      writeJson(res, 200, typeof options.status === "function" ? await options.status() : { ok: true });
      return;
    }
    if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {      writeJson(res, 200, {
        object: "list",
        data: getModels().map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "scnet" }))
      });
      return;
    }
    if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
      await forward(req, res, `/api/llm/v1/chat/completions`);
      return;
    }
    writeOpenAIError(res, 404, `no such route: ${req.method} ${url}`);
  }

  /** Replace the Authorization header with the real key and pipe both ways (SSE included). */
  async function forward(req, res, url) {
    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.toLowerCase().includes("application/json")) {
      writeOpenAIError(res, 415, "Content-Type must be application/json");
      return;
    }
    let apiKey;
    try {
      apiKey = await resolveApiKey();
    } catch (error) {
      writeOpenAIError(res, 401, `no scnet credential: ${String(error)}`);
      return;
    }
    if (typeof apiKey !== "string" || apiKey === "") {
      writeOpenAIError(res, 401, "no scnet credential discovered");
      return;
    }
    const body = await readBody(req);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const upstream = (gatewaySecure ? httpsRequest : httpRequest)({
      host: gatewayHost,
      port: gatewayPort,
      path: url,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": body.length,
        "accept": req.headers.accept ?? "application/json",
        "authorization": `Bearer ${apiKey}`
      }
    });
    const done = new Promise((resolve, reject) => {
      upstream.on("error", reject);
      upstream.on("response", (upstreamRes) => {
        const headers = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue;
          headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
        upstreamRes.on("end", resolve);
        upstreamRes.on("error", reject);
      });
    });
    upstream.on("close", () => {
      // client aborted: tear down the upstream socket too
      if (res.destroyed) upstream.destroy();
    });
    upstream.end(body);
    await done;
  }

  return {
    token: () => SHARED_SECRET,
    baseUrl,
    ready,
    /** Loopback diagnostics, no auth required for local callers. */
    async fetchStatus() {
      await ready;
      const response = await fetch(`${baseUrl()}/status`, { headers: { authorization: `Bearer ${SHARED_SECRET}` } });
      return response.json();
    },
    close() {
      if (disposed) return;
      disposed = true;
      server.close();
    }
  };
}
