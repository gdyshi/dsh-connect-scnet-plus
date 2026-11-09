// Live check: shim → real gateway, one tiny completion on the free model.
import { discoverCredentials, primaryKey } from "../lib/credentials.js";
import { getCatalog } from "../lib/catalog.js";
import { createScnetShim } from "../lib/shim.js";

const credentials = await discoverCredentials();
const apiKey = primaryKey(credentials);
const { catalog } = await getCatalog({ apiKey, force: true });
const free = catalog.find((m) => m.name.includes("免费")) ?? catalog[0];
console.log("using model:", free.id);

const shim = createScnetShim({ resolveApiKey: async () => apiKey, getModels: () => catalog });
await shim.ready;
const base = shim.baseUrl();

const res = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
  body: JSON.stringify({
    model: free.id,
    messages: [{ role: "user", content: "只回复两个字：你好" }],
    max_tokens: 32,
    stream: false
  })
});
console.log("status:", res.status);
const body = await res.text();
console.log(body.slice(0, 500));

// SSE stream smoke test
const res2 = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
  body: JSON.stringify({ model: free.id, messages: [{ role: "user", content: "数到3" }], max_tokens: 32, stream: true })
});
console.log("stream status:", res2.status);
const text = await res2.text();
console.log("sse chunks:", text.split("\n\n").filter(Boolean).length, "| first:", text.split("\n").find((l) => l.startsWith("data:"))?.slice(0, 120));
shim.close();
