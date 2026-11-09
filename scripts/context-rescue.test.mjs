import fs from 'node:fs';
const cred = JSON.parse(fs.readFileSync(process.env.USERPROFILE + '\\.sclaw\\agent\\scnet-credentials\\1cc3ae63a2ed6beab56a1cbd.json','utf8'));
const key = cred.scnet.key;
const { createContextRescue } = await import('./plugin-lib/context-rescue.js');
const { withContextRescue } = await import('./plugin-lib/adapter.js');

let foldCalls = 0;
const agents = new Map([['sess-1', { session: { id: 'sess-1' } }]]);
let totalTokens = 999999;
const meter = { measure: () => ({ totalTokens, nodes: [{seq:1,tokens:400},{seq:2,tokens:300},{seq:3,tokens:200}] }) };
const compaction = { compactRegion: async () => { foldCalls++; totalTokens = 100; return true; } };
const contextRescue = createContextRescue(() => ({ meter, compaction, agents, log: () => {} }));

const model = { id: 'SCNet-Max', provider: 'scnet', contextWindow: 1000 };
const fakeApi = {
  stream: (m, ctx, opts) => (async function* () {
    yield { type: 'start' };
    yield { type: 'error', error: { stopReason: 'error', errorMessage: 'prompt is too long: 1200 tokens > 1000 maximum' } };
  })(),
  streamSimple: (m, ctx, opts) => (async function* () { yield { type: 'error', error: { message: 'no rescue for streamSimple path', code: 'PI_AI_ERROR' } }; })()
};
const wrapped = withContextRescue(fakeApi, () => contextRescue);
const events = [];
for await (const ev of wrapped.stream(model, {}, { sessionId: 'sess-1' })) events.push(ev);
const assert = (c, msg) => { if (!c) { console.error('FAIL:', msg); process.exit(1); } console.log('PASS:', msg); };
assert(events.some(e => e.type === 'start'), 'start forwarded unchanged');
assert(events.some(e => e.type === 'error' && /prompt is too long/.test(e.error.errorMessage)), 'error forwarded unchanged (host policy decides retry)');
assert(foldCalls >= 1, `rescue triggered and folded (folds: ${foldCalls})`);

// 无 sessionId → 完全旁路
foldCalls = 0;
const events2 = [];
for await (const ev of wrapped.stream(model, {}, {})) events2.push(ev);
assert(foldCalls === 0, 'no sessionId → rescue bypassed');
console.log('ALL RESCUE TESTS PASS');


