#!/usr/bin/env node
/**
 * WIRE test: what the descriptor actually puts on the request body.
 *
 * The unit gate (`thinking-context.test.mjs`) proves the descriptor SHAPE. This
 * one proves the EFFECT: it hands the descriptor to the real pi-ai
 * `openai-completions` implementation, points it at a loopback server, and
 * reads the JSON body pi-ai would have sent upstream.
 *
 * WHY THIS IS THE GATE THAT MATTERS. The defect being fixed was invisible from
 * the outside: the picker offered tiers and the descriptor looked fine, but
 * pi-ai translates the `off` tier into *omitting* the reasoning option — so
 * every tier produced the identical request and a thinking-by-default model
 * kept thinking. Only the wire body can tell those apart.
 *
 * WHAT THE GATEWAY WAS MEASURED TO HONOUR (live probes against
 * api.scnet.cn, `SCNet-Max`, reading `reasoning_content` back):
 *
 *   reasoning_effort: minimal|low|medium|high|xhigh  → reasoning prose changes
 *   thinking: {type: "disabled"}                    → reasoning disappears
 *   unknown fields                                  → silently ignored (200)
 *
 * pi-ai's `thinkingFormat: "deepseek"` emits exactly that pair. The assertions
 * below pin the pair, not the prose lengths (which vary run to run).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { toScnetModel } from "../lib/model-descriptor.js";

/**
 * pi-ai is an OPTIONAL peer: a bare checkout (and any CI leg that installed
 * without it) has no copy, so the gate SKIPS loudly instead of failing on an
 * import error. CI installs it from the lockfile, where it runs for real — the
 * skip is for the half of the matrix that has no peer, and it says so.
 */
let openAICompletionsApi;
try {
  ({ openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy"));
} catch (error) {
  console.log(`SKIP thinking-wire: @earendil-works/pi-ai is not installed here (${error.code ?? error.message}).`);
  console.log("The descriptor shape is covered by thinking-context.test.mjs; this gate needs the real peer to read the wire body.");
  process.exit(0);
}

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`PASS ${name}`);
};

/** One SSE completion body, enough for pi-ai to finish cleanly. */
const SSE = [
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}`,
  "",
  "data: [DONE]",
  "",
  ""
].join("\n");

/** Start a loopback server that records every request body and answers with SSE. */
async function capture() {
  const bodies = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      bodies.push(raw === "" ? undefined : JSON.parse(raw));
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(SSE);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/** Drive one pi-ai request and return the body it sent. */
async function send(captured, model, reasoning) {
  const api = openAICompletionsApi();
  const context = { messages: [{ role: "user", content: "hi" }] };
  const stream = api.streamSimple(model, context, { apiKey: "test-token", reasoning });
  // Draining is what actually dispatches; the body is captured on the way in.
  for await (const _event of stream) {
    // discard
  }
  return captured.bodies.at(-1);
}

const info = {
  id: "SCNet-Max",
  name: "SCNet-Max",
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  image: true,
  thinking: "levels"
};
const noVocab = { ...info, thinking: undefined };

const captured = await capture();
try {
  const model = toScnetModel(info, captured.baseUrl, "scnet");

  // --- the tier the user picked reaches the wire -------------------------
  const high = await send(captured, model, "high");
  assert.equal(high.thinking?.type, "enabled", "a chosen tier must enable thinking");
  assert.equal(high.reasoning_effort, "high", "the tier name is the wire value");
  ok("wire: reasoning=high sends thinking{enabled} + reasoning_effort=high");

  for (const tier of ["minimal", "low", "medium", "xhigh"]) {
    const body = await send(captured, model, tier);
    assert.equal(body.reasoning_effort, tier, `${tier} reaches the wire verbatim`);
    assert.equal(body.thinking?.type, "enabled");
  }
  ok("wire: minimal/low/medium/xhigh each reach the wire as themselves");

  // --- `off` now actually turns thinking off ------------------------------
  // This is the line the whole fix exists for: before, `off` omitted the
  // option, which is byte-for-byte the same request as naming no tier.
  const off = await send(captured, model, "off");
  assert.equal(off.thinking?.type, "disabled", "off must send the measured disable instruction");
  assert.equal(off.reasoning_effort, undefined, "off must not name a tier");
  ok("wire: reasoning=off sends thinking{disabled} — a real instruction, not an omission");

  // --- a model with no vocabulary sends nothing ---------------------------
  const plain = toScnetModel(noVocab, captured.baseUrl, "scnet");
  const plainOff = await send(captured, plain, "off");
  assert.equal(plainOff.thinking, undefined, "no vocabulary → no thinking field");
  assert.equal(plainOff.reasoning_effort, undefined);
  ok("wire: a model with no vocabulary sends neither field (the honest request)");

  // A tier the model cannot express must also not invent a field.
  const plainHigh = await send(captured, plain, "high");
  assert.equal(plainHigh.thinking, undefined, "a clamped tier still sends no thinking field");
  assert.equal(plainHigh.reasoning_effort, undefined);
  ok("wire: an inexpressible tier on a no-vocabulary model sends neither field");

  // --- budgets narrow the claimed window ---------------------------------
  const budgeted = toScnetModel(info, captured.baseUrl, "scnet", 200_000);
  assert.equal(budgeted.contextWindow, 200_000);
  assert.equal(budgeted.nativeContextWindow, 1_048_576);
  ok("wire: a context budget reaches the descriptor without touching the prompt");

  // --- the request itself still carries what it must ----------------------
  assert.equal(high.model, "SCNet-Max");
  assert.deepEqual(high.messages, [{ role: "user", content: "hi" }]);
  ok("wire: model id and messages are unchanged by the thinking plumbing");
} finally {
  await captured.close();
}

console.log(`\n${passed} checks passed`);
