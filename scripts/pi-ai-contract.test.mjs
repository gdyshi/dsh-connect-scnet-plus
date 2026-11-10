#!/usr/bin/env node
/**
 * Generation CONTRACT test: prove the adapter's output survives the REAL
 * estimator of each pi-ai generation.
 *
 * WHY THIS EXISTS. The bug this pins is the one that took four rounds to find:
 * pi-ai is an OPTIONAL peer, so a profile can resolve an OLD copy (0.82/0.85)
 * while the host normalizes contexts (0.87+/1.x). The old estimator has no
 * `system` branch, so it iterates the system message's content as if it were a
 * block array; with a string content every character becomes a "block", falls
 * through to `block.name.length`, and throws:
 *
 *     TypeError: Cannot read properties of undefined (reading 'length')
 *
 * The `pi-ai` gate proves the FOLDING logic. This gate proves the fold is
 * actually consumable: it replays the real estimator implementations, copied
 * verbatim from both releases, against what the adapter emits. That makes the
 * failure detectable in CI without downloading an old package, on every
 * platform, forever.
 *
 * WHY COPY THE ESTIMATOR INSTEAD OF IMPORTING IT. Importing `pi-ai` would test
 * whichever version happens to be installed, which is exactly the variable
 * under test — CI installs 1.x, so an import-based test can never see the
 * legacy branch. The two functions below are the parts that decide whether a
 * context is safe; they are small, stable, and version-pinned by the comments.
 */
import assert from "node:assert/strict";
import { foldModernContext, adaptLegacyContext, generationOf } from "../lib/pi-ai-runtime.js";

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`PASS ${name}`);
};

// ---------------------------------------------------------------------------
// The real estimator from @earendil-works/pi-ai 0.82.1 (dist/utils/estimate.js).
// Verbatim except for the export keyword. NOTE the missing `system` branch: a
// system message falls into the block loop, which is the crash.
// ---------------------------------------------------------------------------
const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content) {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
  return chars;
}

function legacyEstimateMessageTokens(message) {
  let chars = 0;
  if (message.role === "user") return Math.ceil(estimateTextAndImageContentChars(message.content) / CHARS_PER_TOKEN);
  if (message.role === "toolResult") return Math.ceil(estimateTextAndImageContentChars(message.content) / CHARS_PER_TOKEN);
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else chars += block.name.length + JSON.stringify(block.arguments ?? {}).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// The modern estimator (0.87+/1.x): it understands a `system` message, and it
// reads the string content directly. This is the shape the host produces.
// ---------------------------------------------------------------------------
function modernEstimateMessageTokens(message) {
  if (message.role === "system") {
    const text = typeof message.content === "string" ? message.content : "";
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
  return legacyEstimateMessageTokens(message);
}

/** Estimate a whole transcript the way each generation does. */
const estimateAll = (estimator, context) =>
  context.messages.reduce((sum, message) => sum + estimator(message), 0);

// --- 1. the crash is real (a control, so a refactor cannot silently "fix" it) ---
{
  const normalized = { messages: [{ role: "system", content: "you are scnet", timestamp: 0 }] };
  assert.throws(
    () => estimateAll(legacyEstimateMessageTokens, normalized),
    /Cannot read properties of undefined \(reading 'length'\)/
  );
  ok("control: a normalized transcript CRASHES the legacy estimator (the shipped bug)");
}

// --- 2. the fix: adaptLegacyContext makes that same transcript safe ---
{
  const normalized = {
    messages: [
      { role: "system", content: "you are scnet", toolsAdded: [{ name: "read" }], timestamp: 0 },
      { role: "user", content: "hi", timestamp: 1 }
    ]
  };
  const legacy = adaptLegacyContext(normalized);
  const tokens = estimateAll(legacyEstimateMessageTokens, legacy);
  assert.ok(tokens > 0);
  assert.equal(legacy.systemPrompt, "you are scnet");
  assert.deepEqual(legacy.tools, [{ name: "read" }]);
  ok("fix: the legacy branch folds the system message into flat fields and estimates cleanly");
}

// --- 3. modern: a raw envelope is folded, then estimates cleanly ---
{
  const raw = {
    systemPrompt: "you are scnet",
    tools: [{ name: "read" }],
    messages: [{ role: "user", content: "hi", timestamp: 1 }]
  };
  const folded = foldModernContext(raw);
  const tokens = estimateAll(modernEstimateMessageTokens, folded);
  assert.ok(tokens > 0);
  assert.equal(folded.messages[0].role, "system");
  ok("modern: the raw envelope folds onto a system message and estimates cleanly");
}

// --- 4. the round trip preserves the prompt TEXT (not its token count) ----
// NOTE: the legacy estimator deliberately ignores `systemPrompt` — that field
// is handed to the api separately and never enters the messages budget. So a
// token-count comparison between generations is meaningless here; what must
// survive is the prompt itself, which is what a dropped system message loses.
{
  const prompt = "a fairly long system prompt that must not be dropped";
  const raw = {
    systemPrompt: prompt,
    tools: [{ name: "read" }],
    messages: [{ role: "user", content: "hi", timestamp: 1 }]
  };
  const folded = foldModernContext(raw);
  const back = adaptLegacyContext(folded);
  assert.equal(folded.messages[0].content, prompt);
  assert.equal(back.systemPrompt, prompt);
  // Both sides estimate their messages without throwing, and the user turn
  // still counts on each generation.
  assert.ok(estimateAll(modernEstimateMessageTokens, folded) > 0);
  assert.ok(estimateAll(legacyEstimateMessageTokens, back) > 0);
  ok("round trip: the system prompt text survives both directions and both estimate cleanly");
}

// --- 5. tool declarations survive BOTH directions ---
{
  const tools = [{ name: "read" }, { name: "write" }];
  const raw = { systemPrompt: "p", tools, messages: [{ role: "user", content: "hi", timestamp: 1 }] };
  const folded = foldModernContext(raw);
  assert.deepEqual(folded.messages[0].toolsAdded, tools);
  const back = adaptLegacyContext(folded);
  assert.deepEqual(back.tools, tools);
  ok("tools: declarations survive fold and expand (a dropped tool array breaks every call)");
}

// --- 6. every generation the peer range admits is covered ----------------
{
  const cases = [
    ["0.82.1", "legacy"],
    ["0.85.1", "legacy"],
    ["0.86.0", "legacy"],
    ["0.87.0", "modern"],
    ["0.87.1", "modern"],
    ["1.0.2", "modern"],
    ["1.1.0", "modern"]
  ];
  for (const [version, expected] of cases) {
    assert.equal(generationOf(version), expected, `generation of ${version}`);
  }
  ok("generations: every version in the declared peer range maps to a branch that can consume it");
}

// --- 7. an empty prompt still estimates (no NaN, no throw) ---------------
{
  const raw = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
  assert.equal(estimateAll(modernEstimateMessageTokens, foldModernContext(raw)) > 0, true);
  assert.equal(estimateAll(legacyEstimateMessageTokens, adaptLegacyContext(raw)) > 0, true);
  ok("edge: a context with no system prompt estimates on both generations");
}

// --- 8. a system-only context (compaction summary) is safe on both --------
// The legacy side estimates 0 here because its estimator only walks `messages`
// and the whole context is the prompt; what matters is that it does not throw.
{
  const raw = { systemPrompt: "summary", messages: [] };
  const folded = foldModernContext(raw);
  assert.ok(estimateAll(modernEstimateMessageTokens, folded) > 0);
  const back = adaptLegacyContext(folded);
  assert.equal(back.systemPrompt, "summary");
  assert.doesNotThrow(() => estimateAll(legacyEstimateMessageTokens, back));
  ok("edge: a system-only transcript (compaction) is safe on both generations");
}

console.log(`\n${passed} checks passed`);
