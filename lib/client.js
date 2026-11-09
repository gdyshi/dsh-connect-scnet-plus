/**
 * Browser companion: the SCNet model switches card.
 *
 * MODELLED ON dsh-connect-workbuddy's card, which is the proven third-party
 * implementation on this host:
 *
 *   1. `inject` declares ONLY ["slots", "locale"] — both are plain client
 *      services. Everything else is soft-got through `ctx.get()`, because a
 *      third-party browser half that DECLARES a host BFF service
 *      (configForms/remote) never activates and its card silently disappears.
 *   2. The card registers into `plugins.bundle.config` (the Plugins page's own
 *      bundle-config seat) under BOTH spellings of the package name, because
 *      the page looks the registration up by exact key equality.
 *   3. The inject face is a ZERO-ARGUMENT function returning { t, scope } — it
 *      is NOT a props receiver. `ctx.slots.register({...inject}, Card)` caches
 *      the inject result by object identity, so the scope must be bound before
 *      registration and every rebind must dispose + re-register.
 *   4. `settingsScope` comes from `configForms.whileServed(...)` → `forms.get(ns)`.
 *      whileServed runs on the unserved→served edge and hands us the set of
 *      namespaces the Host actually serves; we never guess a namespace name.
 *   5. The card reads its data from that scope's snapshot: `.value` for the
 *      current switch state and the namespace schema for model names. It
 *      writes through `.mutate([{op:'set',path:[...],value}])`.
 */
window.__ModuleLoader__.load({
  id: "dsh-connect-scnet-plus",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    /** The page looks a card up by exact key equality against the bundle name. */
    const BUNDLE_KEYS = ["dsh-connect-scnet-plus", "include:dsh-connect-scnet-plus"];
    /** Namespace candidates, in the order the Host may spell them. */
    const NS_CANDIDATES = ["include:dsh-connect-scnet-plus", "dsh-connect-scnet-plus"];
    const LOCALE_NS = "dsh-connect-scnet-plus";
    const SWITCH_FIELD = "modelSwitches";

    const css = [
      ".scnet-card{display:flex;flex-direction:column;color:var(--dsw-alias-label-primary)}",
      ".scnet-panels{display:flex;align-items:stretch;gap:2px;margin:0 0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}",
      ".scnet-panel-tab{appearance:none;font:inherit;cursor:pointer;border:0;background:transparent;padding:7px 11px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px}",
      ".scnet-panel-tab:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}",
      ".scnet-panel-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}",
      ".scnet-panel-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);border-bottom-color:var(--dsw-alias-brand-primary,#5686fe)}",
      ".scnet-panel{display:flex;flex-direction:column;gap:10px}",
      /* WorkBuddy's own warning: display:flex on a class overrides [hidden].
         Keep inactive tab panels out of view and out of the a11y tree. */
      ".scnet-panel[hidden]{display:none}",
      ".scnet-title{margin:0;font-size:15px;font-weight:600;line-height:22px}",
      ".scnet-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
      ".scnet-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}",
      ".scnet-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      ".scnet-row:last-child{border-bottom:0}",
      ".scnet-row-off .scnet-name,.scnet-row-off .scnet-id{color:var(--dsw-alias-label-tertiary,#999)}",
      ".scnet-name{font-size:13px;line-height:20px}",
      ".scnet-id{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".scnet-about-item{font-size:13px;line-height:20px;padding:4px 0;color:var(--dsw-alias-label-secondary)}",
      ".scnet-empty{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}"
    ].join("");
    const tagId = "dsh-connect-scnet-plus/plugin-card.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-connect-scnet-plus";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const zh = {
      tabModels: "模型",
      tabAbout: "说明",
      title: "模型开关",
      intro: "默认全部不勾选 = 不做限制（所有模型可用）。勾选部分模型后，只有勾选的会出现在模型选择器里。",
      aboutTitle: "关于",
      aboutIntro: "把本机 scnet 客户端的模型网关接入 DSH。以下内容来自插件自身，不依赖宿主文档。",
      aboutBullet1: "凭据：只读扫描 ~/.sclaw/agent/scnet-credentials 下的 API Key，绝不写入 DSH 设置。",
      aboutBullet2: "模型目录：优先读本机 models.json 缓存，失败时回落到网关 /models。",
      aboutBullet3: "请求路径：宿主 → 本机 loopback shim → api.scnet.cn，sk-key 只在 shim 内注入。",
      aboutBullet4: "诊断：在插件目录运行 node lib/bin.js，或查看 shim 的 GET /status。",
      loading: "正在读取设置…",
      empty: "还没有读到模型目录。请确认插件已启动、且本机 scnet 客户端已登录。",
      unavailable: "设置暂不可用（宿主未提供该插件的设置命名空间）。",
      failed: "读取失败"
    };
    const en = {
      tabModels: "Models",
      tabAbout: "About",
      title: "Model switches",
      intro: "Nothing checked means no filter (every model available). Check some models to narrow the picker to just those.",
      aboutTitle: "About",
      aboutIntro: "Connects the local SCNet client's model gateway to DSH. Everything below comes from this plugin, not from host docs.",
      aboutBullet1: "Credentials: read-only scan of ~/.sclaw/agent/scnet-credentials; never written into DSH settings.",
      aboutBullet2: "Catalog: the local models.json cache first, then the gateway's /models endpoint.",
      aboutBullet3: "Request path: host → local loopback shim → api.scnet.cn; the sk-key is injected only inside the shim.",
      aboutBullet4: "Diagnostics: run node lib/bin.js in the plugin directory, or read the shim's GET /status.",
      loading: "Loading settings…",
      empty: "No model catalog yet. Make sure the plugin is running and the local scnet client is signed in.",
      unavailable: "Settings are not available (the Host serves no settings namespace for this plugin).",
      failed: "Failed"
    };

    /** One card row: display name, id, checkbox. */
    function ModelRow({ id, name, checked, disabled, onChange }) {
      return jsxs("li", {
        className: `scnet-row${checked ? "" : " scnet-row-off"}`,
        children: [
          jsxs("div", {
            children: [
              jsx("div", { className: "scnet-name", children: name }),
              id === name ? null : jsx("div", { className: "scnet-id", children: id })
            ]
          }),
          jsx(primitives.Checkbox, { checked, label: name, disabled, onChange })
        ]
      });
    }

    /** Rehydrate a schemastery refs envelope into a plain node tree. */
    const resolveRef = (refs, node) => {
      if (typeof node === "number") return resolveRef(refs, refs[String(node)]);
      if (node === null || typeof node !== "object") return node;
      const out = { ...node };
      if (node.dict) {
        const dict = {};
        for (const [key, child] of Object.entries(node.dict)) dict[key] = resolveRef(refs, child);
        out.dict = dict;
      }
      if (node.inner !== undefined) out.inner = resolveRef(refs, node.inner);
      return out;
    };

    /**
     * Read the card's data from a bound settings scope.
     * @param scope - ConfigFormController for this plugin's namespace.
     * @param view - the describe view, for the schema (model display names).
     * @returns {status, models} for rendering.
     */
    const readCard = (scope, view) => {
      if (scope === undefined) return { status: "unavailable", models: [] };
      const snapshot = scope.getSnapshot();
      if (snapshot === undefined || snapshot.status !== "ready") return { status: "loading", models: [] };
      const ns = view.find((row) => row.value !== undefined && row.value[SWITCH_FIELD] !== undefined);
      let schema = ns?.schema;
      if (schema?.refs) schema = resolveRef(schema.refs, schema.refs[String(schema.uid)]);
      const dict = schema?.dict?.[SWITCH_FIELD]?.dict ?? {};
      const values = snapshot.value?.[SWITCH_FIELD] ?? {};
      const models = Object.entries(dict).map(([id, field]) => ({
        id,
        name: typeof field?.meta?.description === "string" && field.meta.description !== "" ? field.meta.description : id,
        // Empty by default: a checked box opts the model into an allowlist.
        enabled: values[id] === true
      }));
      if (models.length === 0) {
        // No schema (older build): fall back to the value's own keys.
        for (const id of Object.keys(values)) models.push({ id, name: id, enabled: values[id] === true });
      }
      return { status: models.length === 0 ? "empty" : "ready", models };
    };

    /** Write one model's switch through the bound scope. */
    const writeSwitch = (scope, id, next) => {
      if (scope === undefined) return Promise.resolve(false);
      return scope.mutate([{ op: "set", path: [SWITCH_FIELD, id], value: next !== false }]);
    };

    /**
     * The card. `t` and `read`/`write` come from the registration's zero-argument
     * inject face, exactly like WorkBuddy's card.
     */
    function ScnetCard({ t, read, write }) {
      const [panel, setPanel] = react.useState("models");
      const [state, setState] = react.useState({ status: "loading", models: [] });
      const refresh = () => {
        try {
          setState(read());
        } catch (error) {
          setState({ status: "error", models: [], error: String(error?.message ?? error) });
        }
      };
      react.useEffect(() => {
        refresh();
      }, []);
      const toggle = (id, next) => {
        setState((previous) => ({
          ...previous,
          models: previous.models.map((model) => model.id === id ? { ...model, enabled: next } : model)
        }));
        Promise.resolve(write(id, next)).catch(() => {
          setState((previous) => ({
            ...previous,
            models: previous.models.map((model) => model.id === id ? { ...model, enabled: !next } : model)
          }));
        });
      };
      let body;
      if (state.status === "loading") body = jsx("p", { className: "scnet-empty", children: t("loading") });
      else if (state.status === "unavailable") body = jsx("p", { className: "scnet-empty", children: t("unavailable") });
      else if (state.status === "error") body = jsx("p", { className: "scnet-empty", children: `${t("failed")}: ${state.error ?? ""}` });
      else if (state.status === "empty") body = jsx("p", { className: "scnet-empty", children: t("empty") });
      else {
        body = jsx("ul", {
          className: "scnet-list",
          children: state.models.map((model) => jsx(ModelRow, {
            id: model.id,
            name: model.name,
            checked: model.enabled,
            disabled: false,
            onChange: (next) => toggle(model.id, next)
          }, model.id))
        });
      }
      return jsxs("div", {
        className: "scnet-card",
        children: [
          jsxs("div", {
            className: "scnet-panels",
            role: "tablist",
            "aria-label": t("title"),
            children: [
              jsx("button", {
                type: "button", role: "tab", id: "scnet-tab-models",
                "aria-controls": "scnet-panel-models", "aria-selected": panel === "models",
                className: `scnet-panel-tab${panel === "models" ? " scnet-panel-tab-active" : ""}`,
                onClick: () => setPanel("models"),
                children: t("tabModels")
              }),
              jsx("button", {
                type: "button", role: "tab", id: "scnet-tab-about",
                "aria-controls": "scnet-panel-about", "aria-selected": panel === "about",
                className: `scnet-panel-tab${panel === "about" ? " scnet-panel-tab-active" : ""}`,
                onClick: () => setPanel("about"),
                children: t("tabAbout")
              })
            ]
          }),
          jsxs("div", {
            className: "scnet-panel", role: "tabpanel", id: "scnet-panel-models",
            "aria-labelledby": "scnet-tab-models", hidden: panel !== "models",
            children: [
              jsx("h3", { className: "scnet-title", children: t("title") }),
              jsx("p", { className: "scnet-intro", children: t("intro") }),
              body
            ]
          }),
          jsxs("div", {
            className: "scnet-panel", role: "tabpanel", id: "scnet-panel-about",
            "aria-labelledby": "scnet-tab-about", hidden: panel !== "about",
            children: [
              jsx("h3", { className: "scnet-title", children: t("aboutTitle") }),
              jsx("p", { className: "scnet-intro", children: t("aboutIntro") }),
              jsx("ul", {
                className: "scnet-list",
                children: ["aboutBullet1", "aboutBullet2", "aboutBullet3", "aboutBullet4"].map((key) => jsx("li", {
                  className: "scnet-about-item",
                  children: t(key)
                }, key))
              })
            ]
          })
        ]
      });
    }

    /** Required services: the two plain client services WorkBuddy declares. */
    const inject = ["slots", "locale"];

    /**
     * Mount the card while the Host serves this plugin's settings namespace,
     * mirroring dsh-connect-workbuddy's bindSettingsScope/rebindSlots.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-connect-scnet-plus: card dictionaries");
      const t = ctx.locale.bind(LOCALE_NS);
      /** Soft-get: an absent service must never block activation. */
      const softGet = (name) => ctx.get(name);
      const forms = softGet("configForms");
      if (forms === undefined) return;

      /** Bound controller for the namespace the Host actually serves. */
      let scope;
      /** Describe rows (schema + values), kept so reads need no extra call. */
      let view = [];
      /** Disposers of the CURRENT registrations. */
      let live = [];

      const disposeLive = () => {
        for (const dispose of live) {
          try {
            dispose();
          } catch {
            // a slot already gone is not an error
          }
        }
        live = [];
      };

      const read = () => readCard(scope, view);
      const write = (id, next) => writeSwitch(scope, id, next);

      /** Register the card under both package-name spellings. */
      const registerAll = () => {
        view = forms.describe().getSnapshot().view?.namespaces ?? [];
        live = BUNDLE_KEYS.flatMap((key) => {
          try {
            const dispose = ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
              name: "plugins.bundle.config",
              key,
              priority: 30,
              locale: LOCALE_NS,
              // ZERO-ARGUMENT inject face: the renderer caches this by identity,
              // so `read`/`write` must close over the CURRENT `scope` variable.
              inject: () => ({ t, read, write })
            }, ScnetCard));
            return typeof dispose === "function" ? [dispose] : [];
          } catch (error) {
            console.error(`[dsh-connect-scnet-plus] card "${key}" registration failed:`, error);
            return [];
          }
        });
      };

      /** Rebind scope and re-register everything (the renderer caches inject). */
      const rebind = () => {
        disposeLive();
        registerAll();
      };

      if (typeof forms.whileServed !== "function") {
        scope = forms.get(NS_CANDIDATES[0]);
        registerAll();
        return;
      }
      ctx.effect(() => forms.whileServed(NS_CANDIDATES, (served) => {
        const ns = NS_CANDIDATES.find((candidate) => served.has(candidate));
        scope = ns === undefined ? undefined : forms.get(ns);
        view = forms.describe().getSnapshot().view?.namespaces ?? [];
        rebind();
        return () => {
          disposeLive();
        };
      }), "dsh-connect-scnet-plus: settings namespace binding");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
