# dsh-connect-scnet-plus 0.1.1 

pi-ai 版本自适应版：装完不再需要手动对齐 `@earendil-works/pi-ai`。

## 本版重点

`@earendil-works/pi-ai` 是**可选 peer**，安装时 pnpm 可能给 profile 装旧版
（0.82/0.85），而宿主内置 1.x。两代消费的 context 形状不同，错配的症状是每个
请求在本地 32ms 崩掉、上游零流量：

```
PI_AI_ERROR: Cannot read properties of undefined (reading 'length')
```

本版照 dsh-connect-workbuddy 的 issues #24/#25/#26 实现了完整自适应：

- **`lib/pi-ai-runtime.js`**：用 `import.meta.resolve` + 读 manifest 判断插件实际
  解析到哪一代，**不 import pi-ai**（避免加载期崩溃，doctor 也能独立运行）。
  `0.87+`/`1.x` → `modern`；`<0.87` → `legacy`；解析不到 → 默认 `modern`。
- **适配器按世代自动折叠/展开**：`withTranscriptShape(api, generation)` 包住
  `stream`/`streamSimple`，两代都能正确收发；两条分支都幂等、可往返。
- **doctor 报告世代**：输出 `piAi.generation` / `resolvedLocally` / `resolvedFrom`，
  混代问题一眼可见。
- 新增 gate `pi-ai`（18 项），并修正原 `context-rescue.test.mjs` 引用不存在
  路径、从未真正执行的问题。

结论：**装完不需要手动对齐 pi-ai 版本**，插件自己适配。

## 升级

```sh
dsh plugin --profile desktop remove dsh-connect-scnet-plus
dsh plugin --profile desktop add github:gdyshi/dsh-connect-scnet-plus
```

或在插件管理页点更新，装完重启一次 DSH。

## 这是什么

把本机「超算互联网 / SCNet（计算服务）」客户端已登录的模型接入 DeepSeek Harness
的**增强版插件**。

与 host-only 基础版相比：

- 插件详情页自带「模型 / 说明」tab 卡片
- 逐模型勾选启用（默认全不勾 = 全部可用；勾选后只显示勾选的）
- 支持带图历史回放（接入宿主 attachments 服务）
- 凭据 5 分钟 TTL 重扫，重新登录无需重启
- `node lib/bin.js` 诊断（凭据 / 目录 / 网关 / pi-ai 世代 / 模型启用状态）

## 安装要求

- DSH 0.2.x（`@deepseek-ai/dsh-llm` / `dsh-llm-pi-ai` peer 范围内）
- 本机已安装并登录过 scnet 客户端（凭据在 `~/.sclaw/agent/scnet-credentials/`）
- pi-ai 版本无需手动对齐（见上）

```sh
dsh plugin --profile desktop add github:gdyshi/dsh-connect-scnet-plus
```

## 凭据只读声明

只读扫描以下文件，**绝不写入**任何客户端文件、sclaw 目录或宿主配置：

- `~/.sclaw/agent/scnet-credentials/*.json`（读 `type: "api_key"` 的 key）
- `~/.sclaw/agent/models.json`（读模型目录）

日志与诊断输出中的 key 一律脱敏（前 6 后 4）。sk-key 只在本机 loopback shim 内
注入，不进入 DSH 设置文件。

## 诊断

```sh
node lib/bin.js        # 凭据 / 目录 / 网关连通性 / 模型启用状态 / pi-ai 世代
```

## 自动化与质量门禁

仓库自带 `scripts/gate.mjs` 单一门禁入口：

```sh
node scripts/gate.mjs            # 全部
node scripts/gate.mjs --lane fast # 本地快车道
node scripts/gate.mjs --list      # 查看注册表
```

CI（`.github/workflows/ci.yml`）在 Windows 上跑同一套门禁；`v*` tag 触发
`release.yml`：门禁 → 打包 → 上传 Release。

## GitHub 仓库结构

```
README.md                      仓库首页（即插件根 README，保持精简）
LICENSE                        MIT
package.json                   name: dsh-connect-scnet-plus
cordis.patch.yml               - insert: id/name = dsh-connect-scnet-plus
lib/                           宿主半侧 + 浏览器半侧
  index.js  adapter.js  catalog.js  credentials.js  shim.js
  context-rescue.js  context-rescue-stream.js  pi-ai-runtime.js
  replay-semantics.js  rescue-wrap.js  doctor.js  bin.js  client.js
locale/en.json, zh.json        title / description / meta.detail
docs/detail.md, detail.zh.md   插件详情页「详细文档」（极简）
docs/TECHNICAL.md              实现细节
docs/AUTOMATION.md             自动化与门禁说明
scripts/                       gate + 各门禁脚本（发布包不含）
.github/workflows/             CI 与发布
```

## 已知注意事项

1. **详情页文档**：宿主按 `locale/<lang>.json 的 meta.detail → README.md` 渲染
   详情文档，`README.md` 必须保持精简，长文放 `docs/`。
2. **配置残留**：`cordis.patch.yml` 里的 `modelSwitches` 段会持久化；清空该段
   可恢复全部模型。
3. **图片输入**：已接入 `ctx.get("attachments")`；宿主未提供该服务时仍会报
   `pi-ai image input requires the durable attachment service`。

## 风险提示 / 免责声明

- 依赖 scnet 客户端**非官方开放接口**（客户端内部缓存与网关），上游调整后插件
  可能失效。
- 通过个人 API Key 调用网关受服务条款约束，请自行评估账号风险（限流、封禁等）。
  本项目与超算互联网官方无关。
- 免费与计费模型的具体价格以官方为准；「免费」标注仅依据客户端缓存的
  `priceLabel`。
- 使用本项目产生的任何后果由使用者自行承担。

## 验证记录（发布前）

- `node scripts/gate.mjs`:syntax / unit(26) / replay / rescue / pi-ai(18) /
  docs / manifest 全绿
- 客户端 smoke：inject `["slots","locale"]`、零参 inject face、
  `plugins.bundle.config` 双 key 注册、tab 结构、模型勾选读写路径
- doctor 六项全绿，`enabled=32/32`，`piAi=1.1.0/modern`

## License

MIT

---

# dsh-connect-scnet-plus 0.1.0

首个公开版本：增强版 SCNet provider，含插件详情页「模型 / 说明」tab 卡片、
逐模型勾选启用、带图历史回放、凭据 TTL 重扫与 doctor 诊断。

实现细节见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。
