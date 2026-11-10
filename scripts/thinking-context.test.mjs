#!/usr/bin/env node
/**
 * Thinking tiers, context budgets, and replay switches — the three capabilities
 * this plugin was missing next to dsh-connect-workbuddy.
 *
 * WHY EACH ASSERTION EXISTS.
 *
 * 1. THINKING. The previous descriptor published `reasoning: false` and the
 *    adapter pinned every request to `off`. pi-ai translates `off` into
 *    *omitting* the reasoning option, so every tier the picker offered sent the
 *    identical request — a control that cannot change anything. These tests pin
 *    the corrections: a declared vocabulary becomes a real `thinkingLevelMap`
 *    plus `thinkingFormat: "deepseek"` (the pair measured to reach SCNet), and
 *    a model with no vocabulary keeps the honest `off`-only shape.
 *
 * 2. BUDGETS. Every SCNet model ships a 1M window, so a session grows until it
 *    is slow, expensive, and one compaction from overflowing. A budget must
 *    only ever SHRINK (a stale setting must not claim more room than upstream
 *    really serves) and must leave the native window visible.
 *
 * 3. REPLAY. Dropping replayed thinking blocks is a repair, but which history
 *    deserves it is the session's business — so both extremes are reachable and
 *    the defaults reproduce the previous unconditional behaviour.
 *
 * Everything here is peer-free by construction: model-descriptor.js and
 * replay-semantics.js import no DSH host package, so this runs on a bare
 * checkout and in CI.
 */
import assert from "node:assert/strict";
import {
  OFF_EFFORT,
  OFF_ONLY_REASONING,
  SCNET_THINKING_LEVELS,
  budgetedWindow,
  effectiveEffort,
  thinkingLevelMapFor,
  toScnetModel
} from "../lib/model-descriptor.js";
import { applyContextBudgets, normalizeLocalModel } from "../lib/catalog.js";
import {
  dropAllThinkingBlocks,
  dropForeignThinkingBlocks,
  sanitizeOptions
} from "../lib/replay-semantics.js";

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`PASS ${name}`);
};

const model = (overrides = {}) => ({
  id: "SCNet-Max",
  name: "SCNet-Max",
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  image: true,
  thinking: "levels",
  ...overrides
});
const BASE = "http://127.0.0.1:1234/v1";

// ---------------------------------------------------------------------------
// 1a. The capability gate comes from `thinkingMode`, not from `reasoning`.
// ---------------------------------------------------------------------------
{
  // The shipped cache says `reasoning: false` even for models that always think,
  // so the tag/reasoning heuristic must never be the capability source.
  const levels = normalizeLocalModel({ id: "A", name: "A", thinkingMode: "levels", reasoning: false });
  assert.equal(levels.thinking, "levels");
  const none = normalizeLocalModel({ id: "B", name: "B", reasoning: true, tags: ["深度思考"] });
  assert.equal(none.thinking, undefined);
  ok("capability: thinkingMode decides the vocabulary; reasoning/tags never do");
}

// ---------------------------------------------------------------------------
// 1b. A declared vocabulary becomes a map pi-ai can act on.
// ---------------------------------------------------------------------------
{
  const map = thinkingLevelMapFor(model());
  assert.ok(map, "a declared vocabulary must produce a map");
  for (const level of SCNET_THINKING_LEVELS) assert.equal(map[level], level, `${level} maps to itself`);
  // `off` must be a STRING: pi-ai reads `off !== null` to decide whether it may
  // send a thinking-disabled request at all.
  assert.equal(map.off, "off");
  assert.notEqual(map.off, null);
  ok("map: every measured tier maps to itself and off is a string, never null");

  assert.equal(thinkingLevelMapFor(model({ thinking: undefined })), undefined);
  assert.equal(thinkingLevelMapFor({ id: "x" }), undefined);
  ok("map: a model with no vocabulary has no map");
}

// ---------------------------------------------------------------------------
// 1c. The descriptor publishes the map AND the wire format that honours it.
// ---------------------------------------------------------------------------
{
  const descriptor = toScnetModel(model(), BASE, "scnet");
  assert.equal(descriptor.reasoning, true);
  assert.deepEqual(descriptor.thinkingLevelMap, thinkingLevelMapFor(model()));
  assert.equal(descriptor.compat.supportsReasoningEffort, true);
  // Without "deepseek" the map is inert: the generic branch would send a bare
  // `reasoning_effort` and never a thinking-disabled instruction.
  assert.equal(descriptor.compat.thinkingFormat, "deepseek");
  ok("descriptor: capable models advertise reasoning + the deepseek wire format");

  const plain = toScnetModel(model({ thinking: undefined }), BASE, "scnet");
  assert.equal(plain.reasoning, false);
  assert.equal(plain.thinkingLevelMap, undefined);
  assert.equal(plain.compat.supportsReasoningEffort, false);
  assert.equal(plain.compat.thinkingFormat, undefined);
  ok("descriptor: a model with no vocabulary keeps the historical off-only shape");
}

// ---------------------------------------------------------------------------
// 1d. Pinning. The defect was pinning EVERY model to off.
// ---------------------------------------------------------------------------
{
  assert.equal(effectiveEffort("high", true), "high", "a capable model keeps the user's tier");
  assert.equal(effectiveEffort("off", true), "off");
  assert.equal(effectiveEffort(undefined, true), undefined, "no tier stays no tier when capable");
  ok("effort: a capable model's chosen tier reaches pi-ai unchanged");

  assert.equal(effectiveEffort("high", false), OFF_EFFORT);
  assert.equal(effectiveEffort(undefined, false), OFF_EFFORT);
  ok("effort: a model with no vocabulary is still pinned to off");

  assert.deepEqual(OFF_ONLY_REASONING.efforts.map((e) => e.id), ["off"]);
  ok("effort: the off-only advertisement still exists for incapable models");
}

// ---------------------------------------------------------------------------
// 2a. Budgets only shrink, and never inflate.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(budgetedWindow(1_000_000, 200_000), { contextWindow: 200_000, nativeContextWindow: 1_000_000 });
  ok("budget: a smaller cap narrows the window and records the native one");

  // A cap above the native window must be ignored: a stale setting cannot claim
  // more room than the upstream model really serves.
  assert.deepEqual(budgetedWindow(1_000_000, 4_000_000), { contextWindow: 1_000_000 });
  assert.deepEqual(budgetedWindow(1_000_000, 1_000_000), { contextWindow: 1_000_000 });
  ok("budget: a cap at or above native is ignored (shrink only)");

  for (const junk of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "65536"]) {
    assert.deepEqual(budgetedWindow(1_000_000, junk), { contextWindow: 1_000_000 }, `junk budget ${String(junk)}`);
  }
  ok("budget: absent/null/0/negative/NaN/Infinity/string budgets are all ignored");

  assert.equal(budgetedWindow(1_000_000.7, undefined).contextWindow, 1_000_000.7);
  assert.equal(budgetedWindow(1_000_000, 65_536.9).contextWindow, 65_536);
  ok("budget: a usable cap is floored to a whole token count");
}

// ---------------------------------------------------------------------------
// 2b. The catalog pass and the descriptor agree.
// ---------------------------------------------------------------------------
{
  const catalog = [model({ id: "A", contextWindow: 1_048_576 }), model({ id: "B", contextWindow: 262_144 })];
  const budgeted = applyContextBudgets(catalog, { A: 300_000, B: 999_999, C: 1000 });
  assert.equal(budgeted[0].contextWindow, 300_000);
  assert.equal(budgeted[0].nativeContextWindow, 1_048_576);
  assert.equal(budgeted[1].contextWindow, 262_144, "an over-large cap leaves B alone");
  assert.equal(budgeted[1].nativeContextWindow, undefined);
  ok("catalog: applyContextBudgets narrows only what the budget really shrinks");

  assert.equal(applyContextBudgets(catalog, {}), catalog);
  assert.equal(applyContextBudgets(catalog, null), catalog);
  ok("catalog: no budgets returns the same array");

  const descriptor = toScnetModel(catalog[0], BASE, "scnet", 300_000);
  assert.equal(descriptor.contextWindow, 300_000);
  assert.equal(descriptor.nativeContextWindow, 1_048_576);
  assert.equal(descriptor.maxTokens, 131_072, "maxTokens is untouched by a window cap");
  ok("descriptor: the same cap produces the same window on the wire descriptor");
}

// ---------------------------------------------------------------------------
// 3a. Replay switches: the defaults reproduce the previous behaviour.
// ---------------------------------------------------------------------------
const foreignTurn = {
  role: "assistant",
  provider: "workbuddy",
  api: "openai-completions",
  content: [
    { type: "thinking", thinking: "foreign reasoning" },
    { type: "text", text: "answer" }
  ],
  source: {}
};
const ownTurn = {
  role: "assistant",
  provider: "scnet",
  api: "openai-completions",
  content: [
    { type: "thinking", thinking: "own reasoning" },
    { type: "text", text: "answer" }
  ],
  source: {}
};
const userTurn = { role: "user", content: "hi" };

{
  const options = { messages: [userTurn, foreignTurn, ownTurn] };
  const out = sanitizeOptions(options);
  assert.equal(out.messages[1].content.length, 1, "foreign thinking dropped by default");
  assert.equal(out.messages[2].content.length, 2, "own thinking kept by default");
  ok("replay: default drops foreign thinking only (unchanged behaviour)");

  const explicit = sanitizeOptions(options, { dropForeignThinking: true });
  assert.deepEqual(explicit, out);
  ok("replay: an explicit true is the same as the default");
}

// ---------------------------------------------------------------------------
// 3b. Both extremes are reachable.
// ---------------------------------------------------------------------------
{
  const options = { messages: [userTurn, foreignTurn, ownTurn] };

  const kept = sanitizeOptions(options, { dropForeignThinking: false });
  assert.equal(kept.messages[1].content.length, 2, "foreign thinking survives when the leg is off");
  assert.equal(kept.messages[2].content.length, 2);
  ok("replay: turning the foreign leg off keeps foreign thinking");

  const droppedAll = sanitizeOptions(options, { dropAllThinking: true });
  assert.equal(droppedAll.messages[1].content.length, 1);
  assert.equal(droppedAll.messages[2].content.length, 1, "dropAllThinking also covers this route's own turns");
  ok("replay: dropAllThinking covers own turns too (the reasoning-collapse repair)");

  // Both off means "touch nothing" — not even the hardening pass, because a
  // caller who disabled every repair asked for the transcript as it stands.
  const untouched = sanitizeOptions(options, { dropForeignThinking: false, dropAllThinking: false });
  assert.equal(untouched, options);
  ok("replay: both switches off returns the same object untouched");
}

// ---------------------------------------------------------------------------
// 3c. Redacted thinking is never dropped, and hardening still runs.
// ---------------------------------------------------------------------------
{
  const redacted = {
    role: "assistant",
    provider: "workbuddy",
    api: "openai-completions",
    content: [{ type: "thinking", thinking: "x", redacted: true }, { type: "text", text: "answer" }],
    source: {}
  };
  assert.equal(dropForeignThinkingBlocks(redacted).content.length, 2);
  assert.equal(dropAllThinkingBlocks(redacted).content.length, 2);
  ok("replay: redacted thinking blocks survive both switches");

  // Ownership alignment/hardening must still happen under dropAllThinking: the
  // host's own scan reads `content` and `source` unconditionally.
  const deformed = { role: "assistant", provider: "scnet", api: "dsh-foreign", content: "text" };
  const out = sanitizeOptions({ messages: [deformed] }, { dropAllThinking: true });
  assert.equal(out.messages[0].api, "openai-completions", "own identity repaired");
  assert.ok(Array.isArray(out.messages[0].content), "string content hardened to blocks");
  assert.ok(out.messages[0].source !== undefined, "assistant source hardened");
  ok("replay: alignment and hardening run regardless of the drop switches");
}

console.log(`\n${passed} checks passed`);
