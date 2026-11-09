#!/usr/bin/env node
/**
 * Hermetic tests for context-overflow rescue and its stream wrapper.
 *
 * Both units are peer-free by design (lib/context-rescue.js, lib/rescue-wrap.js)
 * so this test runs on a bare checkout: no DSH host packages, no network, no
 * ~/.sclaw credentials, no sleep-based races. That is deliberate — the previous
 * version of this test read the developer's real scnet credentials and imported
 * lib files through a symlink that only existed on one machine, which is
 * exactly the kind of gate that cannot run in CI.
 *
 * Covered:
 *  1. fold loop: under target, over target, non-decreasing measurement;
 *  2. tail shrinking when the host refuses a range (e.g. splits a tool call);
 *  3. inflight de-duplication per session;
 *  4. wrapper: identity when unresolvable, bypass without sessionId/window,
 *     rescue-before-error ordering, error forwarded unchanged, streamSimple.
 *
 * Usage: node scripts/context-rescue.test.mjs
 */

import assert from "node:assert/strict";

import { createContextRescue } from "../lib/context-rescue.js";
import { createRescueWrapper } from "../lib/rescue-wrap.js";

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log("PASS", label);
};

/** A minimal async event stream with the push/end contract the wrapper needs. */
function fakeEventStream(log) {
  const buffered = [];
  let ended = false;
  return {
    push(event) {
      log?.push(`emit:${event.type}`);
      buffered.push(event);
    },
    end() {
      ended = true;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      while (buffered.length === 0 && !ended) await new Promise((resolve) => setImmediate(resolve));
      if (buffered.length > 0) return { value: buffered.shift(), done: false };
      return { value: undefined, done: true };
    }
  };
}

/** Host services double: `meter.measure(agent.session)` returns the scripted measurement. */
function hostDouble({ nodes, totalTokens }) {
  const agents = new Map([["sess-1", { session: { id: "sess-1" } }]]);
  const state = { totalTokens, folds: 0, ranges: [], log: [] };
  const meter = { measure: () => ({ totalTokens: state.totalTokens, nodes }) };
  const compaction = {
    compactRegion: async (head, tail) => {
      state.folds += 1;
      state.ranges.push([head, tail]);
      state.totalTokens = state.totalTokens - 400;
    }
  };
  return { state, deps: () => ({ meter, compaction, agents, log: (message) => state.log.push(message) }) };
}

const NODES = [
  { seq: 1, tokens: 400 },
  { seq: 2, tokens: 300 },
  { seq: 3, tokens: 200 }
];

// --- fold loop --------------------------------------------------------------
{
  // 900 tokens over a 1000 window: one fold (target 600) lands at 500.
  const host = hostDouble({ nodes: NODES, totalTokens: 900 });
  const rescue = createContextRescue(host.deps);
  const folded = await rescue.rescue("sess-1", 1000);
  assert.equal(folded, true);
  assert.equal(host.state.folds, 1, "one fold is enough to get under the 60% target");
  ok("rescue: overflow folds the oldest chunk once");
}

{
  const host = hostDouble({ nodes: NODES, totalTokens: 300 });
  const rescue = createContextRescue(host.deps);
  assert.equal(await rescue.rescue("sess-1", 1000), false);
  assert.equal(host.state.folds, 0, "already under target must not fold");
  ok("rescue: under target is a no-op");
}

{
  const host = hostDouble({ nodes: NODES, totalTokens: 5000 });
  const rescue = createContextRescue(host.deps);
  // Measurement never drops: the loop must stop instead of spinning.
  host.state.folds = 0;
  const rescueWithStuckMeter = createContextRescue(() => {
    const deps = host.deps();
    return {
      ...deps,
      meter: { measure: () => ({ totalTokens: 5000, nodes: NODES }) },
      compaction: {
        compactRegion: async () => {
          host.state.folds += 1;
        }
      }
    };
  });
  assert.equal(await rescueWithStuckMeter.rescue("sess-1", 1000), true);
  assert.equal(host.state.folds, 1, "stops after the first fold when the meter does not improve");
  assert.equal(await rescue.rescue("sess-1", 1000), true);
  ok("rescue: non-decreasing measurement stops the loop");
}

// --- tail shrinking ---------------------------------------------------------
{
  const longNodes = Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, tokens: 100 }));
  const host = hostDouble({ nodes: longNodes, totalTokens: 1000 });
  const attempts = [];
  const rescue = createContextRescue(() => ({
    meter: { measure: () => ({ totalTokens: host.state.totalTokens, nodes: longNodes }) },
    compaction: {
      compactRegion: async (head, tail) => {
        attempts.push([head, tail]);
        if (attempts.length === 1) throw new Error("range splits a tool call");
        host.state.totalTokens = 600;
      }
    },
    agents: new Map([["sess-1", { session: { id: "sess-1" } }]]),
    log: () => {}
  }));
  assert.equal(await rescue.rescue("sess-1", 1000), true);
  assert.deepEqual(attempts[0], [1, 4], "first attempt folds the whole admissible chunk");
  assert.deepEqual(attempts[1], [1, 3], "a refused range shrinks its tail edge by one node");
  ok("rescue: refused range shrinks the tail edge and retries");
}

// --- inflight de-duplication ------------------------------------------------
{
  const host = hostDouble({ nodes: NODES, totalTokens: 900 });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const rescue = createContextRescue(() => ({
    meter: { measure: () => ({ totalTokens: host.state.totalTokens, nodes: NODES }) },
    compaction: {
      compactRegion: async () => {
        await gate;
        host.state.folds += 1;
        host.state.totalTokens -= 400;
      }
    },
    agents: new Map([["sess-1", { session: { id: "sess-1" } }]]),
    log: () => {}
  }));
  const first = rescue.rescue("sess-1", 1000);
  const second = rescue.rescue("sess-1", 1000);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, true);
  assert.equal(secondResult, false, "the concurrent rescue for the same session is skipped");
  assert.equal(host.state.folds, 1, "only one fold ran");
  ok("rescue: concurrent calls for one session are de-duplicated");
}

// --- wrapper ----------------------------------------------------------------
const isOverflow = (error) => /too long/.test(error?.errorMessage ?? error?.message ?? "");

function wrappedApi(events, options = {}) {
  const order = [];
  const rescueCalls = [];
  const rescue = {
    rescue: async (sessionId, window) => {
      order.push("rescue");
      rescueCalls.push([sessionId, window]);
      if (options.rescueThrows === true) throw new Error("compaction unavailable");
      return true;
    }
  };
  const generator = () => (async function* () {
    for (const event of events) {
      order.push(`source:${event.type}`);
      yield event;
    }
  })();
  const api = { marker: "api", stream: generator, streamSimple: generator };
  const wrapper = createRescueWrapper({ createEventStream: () => fakeEventStream(order), isOverflow });
  return { order, rescueCalls, rescue, wrapper, api };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

{
  const { wrapper, api } = wrappedApi([]);
  assert.equal(wrapper(api, undefined), api);
  ok("wrapper: no resolver → the original api object is returned");
}

{
  const { order, rescueCalls, rescue, wrapper, api } = wrappedApi([
    { type: "start" },
    { type: "error", error: { errorMessage: "prompt is too long: 1200 > 1000" } }
  ]);
  const wrapped = wrapper(api, () => rescue);
  const events = await collect(wrapped.stream({ contextWindow: 1000 }, {}, { sessionId: "sess-1" }));
  assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
  assert.deepEqual(rescueCalls, [["sess-1", 1000]]);
  assert.deepEqual(order, ["source:start", "emit:start", "source:error", "rescue", "emit:error"]);
  assert.ok(order.indexOf("rescue") < order.indexOf("emit:error"), "rescue completes before the error event is forwarded");
  ok("wrapper: rescue runs before the error event is forwarded, events are unchanged");

  {
    const events = await collect(wrapper(api, () => rescue).stream({ contextWindow: 1000 }, {}, { sessionId: "sess-1" }));
    assert.equal(events.length, 2);
  }
  ok("wrapper: a second stream through the same wrapper still works");
}

{
  const { order, rescueCalls, rescue, wrapper, api } = wrappedApi([
    { type: "error", error: { errorMessage: "prompt is too long" } }
  ]);
  const wrapped = wrapper(api, () => rescue);
  const events = await collect(wrapped.streamSimple({ contextWindow: 1000 }, {}, { sessionId: "sess-1" }));
  assert.equal(events.length, 1);
  assert.deepEqual(rescueCalls, [["sess-1", 1000]], "streamSimple is wrapped too");
  assert.deepEqual(order, ["source:error", "rescue", "emit:error"]);
  ok("wrapper: streamSimple is covered");
}

{
  const { rescueCalls, rescue, wrapper, api } = wrappedApi([{ type: "error", error: { errorMessage: "prompt is too long" } }]);
  const wrapped = wrapper(api, () => rescue);
  await collect(wrapped.stream({ contextWindow: 1000 }, {}, {}));
  assert.equal(rescueCalls.length, 0, "no sessionId → bypass");
  ok("wrapper: missing sessionId bypasses rescue");
}

{
  const { rescueCalls, rescue, wrapper, api } = wrappedApi([{ type: "error", error: { errorMessage: "prompt is too long" } }]);
  const wrapped = wrapper(api, () => rescue);
  await collect(wrapped.stream({}, {}, { sessionId: "sess-1" }));
  assert.equal(rescueCalls.length, 0, "no contextWindow → bypass");
  ok("wrapper: missing contextWindow bypasses rescue");
}

{
  const { rescueCalls, rescue, wrapper, api } = wrappedApi([{ type: "error", error: { message: "rate limited" } }]);
  const wrapped = wrapper(api, () => rescue);
  await collect(wrapped.stream({ contextWindow: 1000 }, {}, { sessionId: "sess-1" }));
  assert.equal(rescueCalls.length, 0, "non-overflow errors must not fold");
  ok("wrapper: non-overflow error is not rescued");
}

console.log(`\n${passed} checks passed`);
