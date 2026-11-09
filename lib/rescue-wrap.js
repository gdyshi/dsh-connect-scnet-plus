/**
 * Peer-free stream wrapper for context-overflow rescue.
 *
 * Why this lives outside adapter.js: adapter.js imports host packages
 * (`@earendil-works/pi-ai`, `@deepseek-ai/dsh-llm*`) that are deliberately not
 * vendored here, so anything defined in it cannot be unit-tested on a bare
 * checkout. The wrapper only needs two pi-ai primitives, so they are injected
 * by adapter.js and the wrapper stays importable by tests with fakes. Same
 * code path at runtime, no DSH packages needed to prove it.
 *
 * Semantics: pi-ai reports provider failures as `error` events, not throws.
 * The rescue therefore runs before the error event is pushed, so the host's
 * retry rebuilds its request against the already-folded history. The error is
 * forwarded unchanged: whether to retry is the host's policy, not ours.
 */

/**
 * @param {{
 *   createEventStream: () => {push: (event: object) => void, end: (message?: unknown) => void},
 *   isOverflow: (error: unknown) => boolean
 * }} primitives
 * @returns {(api: object, resolve?: () => {rescue: (sessionId: string, window: number) => Promise<boolean>} | undefined) => object}
 */
export function createRescueWrapper({ createEventStream, isOverflow }) {
  /**
   * Layer the rescue onto a provider's streams, covering both `stream()` and
   * `streamSimple()` because the wrapped api object is handed to createProvider.
   *
   * @param {object} api - the pi-ai api implementation.
   * @param {(() => {rescue: (sessionId: string, window: number) => Promise<boolean>} | undefined) | undefined} resolve
   */
  return function withContextRescue(api, resolve) {
    if (resolve === undefined) return api;
    const wrap = (inner) => (model, context, options) => {
      const source = inner(model, context, options);
      const rescue = resolve();
      const sessionId = options?.sessionId;
      const window = model.contextWindow;
      if (rescue === undefined || sessionId === undefined || window === undefined) return source;
      const out = createEventStream();
      let final;
      (async () => {
        try {
          for await (const event of source) {
            if (event.type === "done") final = event.message;
            if (event.type === "error") final = event.error;
            if (event.type === "error" && isOverflow(event.error)) await rescue.rescue(sessionId, window);
            out.push(event);
          }
          out.end(final);
        } catch {
          out.end(final);
        }
      })();
      return out;
    };
    return {
      ...api,
      stream: wrap(api.stream),
      streamSimple: wrap(api.streamSimple)
    };
  };
}
