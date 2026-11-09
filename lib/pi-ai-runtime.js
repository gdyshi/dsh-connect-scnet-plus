/**
 * Which `@earendil-works/pi-ai` copy THIS plugin actually resolves at runtime.
 *
 * WHY THIS EXISTS (dsh-connect-workbuddy issues #24/#25/#26; this plugin hit
 * the same failure as `PI_AI_ERROR: Cannot read properties of undefined
 * (reading 'length')`). pi-ai is declared as an OPTIONAL peer, so the module
 * this plugin imports is whatever the environment provides — and the two
 * generations consume DIFFERENT context shapes:
 *
 * - 0.87+ / 1.x ("modern") hand providers a NORMALIZED transcript:
 *   `{ messages: [ {role:'system', content, toolsAdded}, … ] }`. The system
 *   prompt and tool declarations live ONLY on that leading system message.
 * - 0.85/0.82 ("legacy") expect `{ systemPrompt, tools, messages }` and have
 *   no branch for a `system` message inside `messages`: their token estimator
 *   crashes on one (`reading 'length'`) and their wire converter silently
 *   drops it.
 *
 * Which copy resolves is NOT predictable from the host version alone: a nested
 * old copy in the profile shadows the host's modern one, while a clean install
 * may resolve the host's. So the adapter gates on what THIS plugin resolves.
 *
 * HOW it is detected — deliberately WITHOUT importing pi-ai:
 * `import.meta.resolve` locates the entry file (executing nothing), the
 * manifest beside it names the version, and the generation follows from that
 * version. A static import would also drag pi-ai into the standalone `doctor`
 * CLI, which must run on machines where no local copy exists.
 *
 * When resolution FAILS (the normal state outside the host), there is no local
 * copy and the host supplies the module; every host that normalizes contexts
 * (DSH 0.2.0+, pi-ai 0.87.1+) ships the modern generation, so that is the
 * default. Older hosts never normalize, and their native legacy context is an
 * identity under either gate branch, so the default cannot hurt them.
 *
 * @module dsh-connect-scnet-plus/pi-ai-runtime
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached;

/** Resolve (once) which pi-ai copy this plugin runs against. */
export function piAiRuntimeInfo() {
  cached ??= piAiRuntimeFor(resolveModuleFile());
  return cached;
}

/** Test hook: forget the cached resolution. */
export function resetPiAiRuntime() {
  cached = undefined;
}

/**
 * The decision table for one resolution result. Exported so the branch that
 * only runs on other machines is pinned by tests rather than by a comment.
 *
 * @param {string | undefined} resolvedFrom - the resolved entry file, if any.
 * @returns {{generation: "modern"|"legacy", resolvedFrom?: string, version?: string, resolvedLocally: boolean}}
 */
export function piAiRuntimeFor(resolvedFrom) {
  if (resolvedFrom === undefined) {
    return { generation: "modern", resolvedFrom: undefined, version: undefined, resolvedLocally: false };
  }
  const version = readVersion(resolvedFrom);
  return { generation: generationOf(version), resolvedFrom, version, resolvedLocally: true };
}

/**
 * The file the main entry resolved to; undefined when resolution fails.
 *
 * `import.meta.resolve` (not `require.resolve`): pi-ai's exports map exposes
 * "." under the `import` condition only, so the CJS resolver refuses the bare
 * specifier outright — the ESM resolver is the one this plugin imports with.
 */
function resolveModuleFile() {
  try {
    return fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
  } catch {
    return undefined;
  }
}

/**
 * The version of the package owning `moduleFile`. pi-ai's exports map does not
 * expose `./package.json`, so the manifest is found by walking up from the
 * resolved entry and claiming it only when its `name` matches, so a same-named
 * ancestor (a pnpm virtual-store parent) cannot be misread.
 */
function readVersion(moduleFile) {
  if (moduleFile === undefined) return undefined;
  let directory = dirname(moduleFile);
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (parsed?.name === "@earendil-works/pi-ai" && typeof parsed.version === "string") return parsed.version;
    } catch {
      // keep walking up
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/**
 * The generation a manifest version belongs to.
 *
 * `0.87+` consumes normalized transcripts natively; earlier releases want the
 * legacy shape, so the split is exactly `0.87+` (including major 1) versus
 * earlier. An unreadable version conservatively reports `legacy` (and doctor
 * shows it as unreadable, so the guess is visible rather than silent).
 *
 * Major 1 must land on `modern`: DSH 0.2.1-alpha.2 ships pi-ai 1.0.2 and
 * 0.2.1-rc.1 ships 1.1.0, and both read tools from the leading system
 * message's `toolsAdded` exactly like 0.87.1. Matching only `0.<minor>.`
 * misclassified 1.x as legacy, which moved tool declarations to a top-level
 * field 1.x never reads — every request then went upstream with no tools.
 *
 * Deliberately match major 1 only: compatibility is established for the
 * observed 1.x line without assuming an uninspected future major keeps the
 * same transcript contract. The declared peer range remains the boundary.
 *
 * @param {string | undefined} version
 * @returns {"modern" | "legacy"}
 */
export function generationOf(version) {
  if (version === undefined) return "legacy";
  const major = /^(\d+)\./u.exec(version);
  if (major !== null && Number(major[1]) === 1) return "modern";
  const match = /^0\.(\d+)\./u.exec(version);
  if (match === null) return "legacy";
  return Number(match[1]) >= 87 ? "modern" : "legacy";
}

/**
 * Fold a raw seam envelope into the normalized transcript a modern api reads.
 *
 * `dsh-llm-pi-ai` hands the provider-facing context in whichever shape its own
 * generation produces; on a modern api a top-level `systemPrompt`/`tools` is
 * never read back, so it must be folded onto the leading system message.
 * Idempotent: a context that is already normalized passes through untouched.
 *
 * @param {object} context
 * @returns {object}
 */
export function foldModernContext(context) {
  const prompt = context?.systemPrompt;
  const tools = context?.tools;
  const hasPrompt = prompt !== undefined && prompt !== "";
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (!hasPrompt && !hasTools) return context;
  const system = {
    role: "system",
    content: prompt ?? "",
    ...(hasTools ? { toolsAdded: tools } : {}),
    timestamp: 0
  };
  const { systemPrompt: _prompt, tools: _tools, ...rest } = context;
  return { ...rest, messages: [system, ...(context.messages ?? [])] };
}

/**
 * Expand a normalized transcript back into the flat legacy shape.
 *
 * The inverse direction: a legacy (0.82/0.85) api reads `systemPrompt` and
 * `tools` off the envelope and has no branch for a leading `system` message —
 * its estimator crashes on one. Idempotent in the same way.
 *
 * @param {object} context
 * @returns {object}
 */
export function adaptLegacyContext(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const first = messages[0];
  if (first === undefined || first.role !== "system") return context;
  const { toolsAdded, ...system } = first;
  const rest = messages.slice(1);
  return {
    ...context,
    ...(typeof system.content === "string" && system.content !== "" ? { systemPrompt: system.content } : {}),
    ...(Array.isArray(toolsAdded) && toolsAdded.length > 0 ? { tools: toolsAdded } : {}),
    messages: rest
  };
}

/**
 * Wrap one pi-ai api module so both stream entry points receive a context the
 * resolved generation can actually consume.
 *
 * - `modern`: fold a raw envelope (`foldModernContext`) so the prompt and tool
 *   declarations reach the leading system message.
 * - `legacy`: expand a normalized transcript (`adaptLegacyContext`) so an old
 *   estimator never sees a `system` entry inside `messages`.
 *
 * Both branches are idempotent, so a seam that already normalized changes
 * nothing. The deferred-fetch entry points take no context and pass through.
 *
 * @param {object} api - the pi-ai api implementation.
 * @param {"modern"|"legacy"} generation - from {@link piAiRuntimeInfo}.
 * @returns {object} the wrapped api.
 */
export function withTranscriptShape(api, generation) {
  const prepare = (context) => {
    if (context === null || typeof context !== "object") return context;
    return generation === "modern" ? foldModernContext(context) : adaptLegacyContext(context);
  };
  const wrap = (inner) => (model, context, options) => inner(model, prepare(context), options);
  return {
    ...api,
    stream: wrap(api.stream),
    streamSimple: wrap(api.streamSimple)
  };
}
