#!/usr/bin/env node
/**
 * Cross-provider replay semantics, asserted against the SHIPPED implementation
 * (lib/replay-semantics.js). This used to re-type align/dropForeign inside the
 * test file, which meant the test could stay green while the implementation
 * changed — the most expensive kind of false green.
 *
 * Semantics under guard:
 *   ① own turn stamped `dsh-foreign` is aligned back and keeps its thinking;
 *   ② foreign turn loses unsigned thinking, keeps text;
 *   ③ own signed thinking is kept;
 *   ④ own unsigned (same-route model switch) thinking is kept;
 *   ⑤ aligned own turn keeps redacted + signed thinking;
 *   ⑥ deformation hardening: string content, missing assistant source, junk.
 *
 * Usage: node scripts/replay-semantics.test.mjs
 */

import assert from "node:assert/strict";

import {
  alignAssistantIdentities,
  dropForeignThinkingBlocks,
  hardenMessage,
  isCrossProviderAssistant,
  sanitizeOptions
} from "../lib/replay-semantics.js";

const OWN_ROUTE = "scnet";
const HOST_FOREIGN_API = "dsh-foreign";

const messages = [
  { role: "assistant", provider: "scnet", api: "dsh-foreign", content: [{ type: "thinking", thinking: "a" }, { type: "text", text: "b" }] },
  { role: "assistant", provider: "workbuddy", api: "dsh-foreign", content: [{ type: "thinking", thinking: "x".repeat(100) }, { type: "text", text: "y" }] },
  { role: "assistant", provider: "scnet", api: "openai-completions", content: [{ type: "thinking", thinking: "sig", thinkingSignature: "s1" }] },
  { role: "assistant", provider: "scnet", api: "openai-completions", content: [{ type: "thinking", thinking: "unsigned-own" }] },
  {
    role: "assistant",
    provider: "scnet",
    api: "dsh-foreign",
    content: [{ type: "thinking", thinking: "redacted", redacted: true }, { type: "thinking", thinking: "normal", thinkingSignature: "s2" }]
  }
];

const sanitized = sanitizeOptions({ messages }).messages;

// ① own dsh-foreign api aligned; thinking kept because it is our own turn now
assert.equal(sanitized[0].api, "openai-completions");
assert.equal(sanitized[0].content.length, 2);
console.log("PASS: ① own dsh-foreign api aligned, thinking kept");

// ② foreign thinking dropped
assert.deepEqual(sanitized[1].content, [{ type: "text", text: "y" }]);
console.log("PASS: ② foreign thinking dropped");

// ③ own signed thinking kept
assert.equal(sanitized[2].content.length, 1);
assert.equal(sanitized[2].content[0].thinkingSignature, "s1");
console.log("PASS: ③ own signed thinking kept");

// ④ own unsigned (same-route switch) thinking kept
assert.equal(sanitized[3].content.length, 1);
assert.equal(sanitized[3].content[0].thinking, "unsigned-own");
console.log("PASS: ④ own unsigned (same-route switch) kept");

// ⑤ aligned own turn keeps redacted + signed thinking
assert.equal(sanitized[4].api, "openai-completions");
assert.equal(sanitized[4].content.length, 2);
assert.equal(sanitized[4].content[0].type, "thinking");
assert.equal(sanitized[4].content[0].redacted, true);
assert.equal(sanitized[4].content[1].thinkingSignature, "s2");
console.log("PASS: ⑤ aligned own: redacted + signed kept");

// ⑥ deformation hardening
assert.equal(hardenMessage({ role: "user", content: "plain" }).content[0].text, "plain", "string content becomes a text block");
assert.deepEqual(hardenMessage({ role: "user", content: "" }).content, [], "empty string content becomes []");
assert.deepEqual(hardenMessage({ role: "assistant", content: [] }).source, {}, "assistant source is defaulted");
assert.equal(hardenMessage(null), null, "null messages pass through");
assert.equal(sanitizeOptions(undefined), undefined, "absent options pass through");
assert.deepEqual(sanitizeOptions({ messages: [] }).messages, [], "empty message list passes through untouched");
console.log("PASS: ⑥ deformation hardening and pass-through");

// layers exposed for targeted reasoning about a regression
assert.equal(alignAssistantIdentities([{ role: "assistant", provider: OWN_ROUTE, api: HOST_FOREIGN_API }])[0].api, "openai-completions");
assert.equal(isCrossProviderAssistant({ role: "assistant", provider: "other", api: "openai-completions" }), true);
assert.equal(isCrossProviderAssistant({ role: "assistant", provider: OWN_ROUTE, api: "openai-completions" }), false);
assert.equal(dropForeignThinkingBlocks({ content: [{ type: "thinking" }, { type: "text", text: "t" }] }).content.length, 1);
console.log("PASS: layers behave individually");

console.log("\nALL REPLAY SEMANTICS PASS");
