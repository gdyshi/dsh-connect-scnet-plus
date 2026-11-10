// pi-ai generation detection + transcript folding.
//
// WHY: pi-ai is an OPTIONAL peer, so the copy this plugin resolves is not
// predictable from the host version. The two generations consume DIFFERENT
// context shapes, and the wrong branch silently drops the prompt and the tool
// declarations (or crashes the old estimator with `reading 'length'`).
// WorkBuddy pins the same decision table by tests (issues #24/#25/#26); this
// file does the same for scnet-plus.
import assert from "node:assert/strict";
import { generationOf, piAiRuntimeFor, foldModernContext, adaptLegacyContext, withTranscriptShape } from "../lib/pi-ai-runtime.js";

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`PASS ${name}`);
};

// --- generation split ------------------------------------------------------
assert.equal(generationOf(undefined), "legacy");
ok("generation: unreadable version conservatively reports legacy");

assert.equal(generationOf("0.82.1"), "legacy");
assert.equal(generationOf("0.85.1"), "legacy");
assert.equal(generationOf("0.86.9"), "legacy");
ok("generation: 0.x below 0.87 is legacy (the crashing estimator)");

assert.equal(generationOf("0.87.0"), "modern");
assert.equal(generationOf("0.87.1"), "modern");
assert.equal(generationOf("0.90.0"), "modern");
ok("generation: 0.87+ consumes normalized transcripts");

assert.equal(generationOf("1.0.2"), "modern");
assert.equal(generationOf("1.1.0"), "modern");
ok("generation: major 1 is modern (DSH 0.2.1 ships 1.0.2 / 1.1.0)");

assert.equal(generationOf("2.0.0"), "legacy");
ok("generation: an uninspected future major is not assumed compatible");

// --- resolution table ------------------------------------------------------
assert.deepEqual(piAiRuntimeFor(undefined), {
  generation: "modern",
  resolvedFrom: undefined,
  version: undefined,
  resolvedLocally: false
});
ok("resolution: no local copy defaults to modern (host supplies it)");

// --- modern folding --------------------------------------------------------
const raw = {
  systemPrompt: "you are scnet",
  tools: [{ name: "read" }],
  messages: [{ role: "user", content: "hi" }]
};
const folded = foldModernContext(raw);
assert.equal(folded.systemPrompt, undefined);
assert.equal(folded.tools, undefined);
assert.deepEqual(folded.messages[0], { role: "system", content: "you are scnet", toolsAdded: [{ name: "read" }], timestamp: 0 });
assert.deepEqual(folded.messages[1], { role: "user", content: "hi" });
ok("fold: prompt and tools move onto the leading system message");

assert.equal(foldModernContext(folded), folded);
ok("fold: idempotent (an already-normalized transcript passes through)");

const promptOnly = foldModernContext({ systemPrompt: "p", messages: [] });
assert.deepEqual(promptOnly.messages[0], { role: "system", content: "p", timestamp: 0 });
ok("fold: a prompt with no tools omits toolsAdded");

const toolsOnly = foldModernContext({ tools: [{ name: "t" }], messages: [] });
assert.deepEqual(toolsOnly.messages[0].toolsAdded, [{ name: "t" }]);
assert.equal(toolsOnly.messages[0].content, "");
ok("fold: tools with no prompt still fold onto a system message");

const empty = { messages: [{ role: "user", content: "x" }] };
assert.equal(foldModernContext(empty), empty);
ok("fold: nothing to fold is a no-op");

// --- legacy expansion ------------------------------------------------------
const normalized = {
  messages: [
    { role: "system", content: "you are scnet", toolsAdded: [{ name: "read" }], timestamp: 0 },
    { role: "user", content: "hi" }
  ]
};
const flat = adaptLegacyContext(normalized);
assert.equal(flat.systemPrompt, "you are scnet");
assert.deepEqual(flat.tools, [{ name: "read" }]);
assert.deepEqual(flat.messages, [{ role: "user", content: "hi" }]);
ok("expand: the leading system message returns to top-level fields");

assert.equal(adaptLegacyContext(flat), flat);
ok("expand: idempotent (a flat legacy context passes through)");

const noSystem = { messages: [{ role: "user", content: "hi" }] };
assert.equal(adaptLegacyContext(noSystem), noSystem);
ok("expand: a transcript with no leading system message is a no-op");

// --- round trip ------------------------------------------------------------
assert.deepEqual(foldModernContext(adaptLegacyContext(folded)), folded);
ok("round trip: expand then fold restores the normalized transcript");

// --- api wrapper -----------------------------------------------------------
const seen = [];
const api = {
  stream: (model, context, options) => {
    seen.push({ entry: "stream", context, options });
    return "stream-result";
  },
  streamSimple: (model, context, options) => {
    seen.push({ entry: "streamSimple", context, options });
    return "simple-result";
  },
  deferred: () => "untouched"
};
const modernApi = withTranscriptShape(api, "modern");
assert.equal(modernApi.deferred(), "untouched");
assert.equal(modernApi.stream({ id: "m" }, raw, { sessionId: "s" }), "stream-result");
assert.equal(modernApi.streamSimple({ id: "m" }, raw, { sessionId: "s" }), "simple-result");
assert.equal(seen[0].context.messages[0].role, "system");
assert.equal(seen[0].context.systemPrompt, undefined);
assert.deepEqual(seen[0].options, { sessionId: "s" });
ok("wrapper: modern folds both stream entry points and preserves options");

seen.length = 0;
const legacyApi = withTranscriptShape(api, "legacy");
legacyApi.stream({ id: "m" }, normalized, {});
legacyApi.streamSimple({ id: "m" }, normalized, {});
assert.equal(seen[0].context.systemPrompt, "you are scnet");
assert.deepEqual(seen[0].context.messages, [{ role: "user", content: "hi" }]);
assert.equal(seen[1].context.systemPrompt, "you are scnet");
ok("wrapper: legacy expands both stream entry points");

seen.length = 0;
withTranscriptShape(api, "modern").stream({ id: "m" }, null, {});
assert.equal(seen[0].context, null);
ok("wrapper: a null context is passed through untouched");

console.log(`\n${passed} checks passed`);
