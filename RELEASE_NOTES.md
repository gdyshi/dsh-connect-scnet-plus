# dsh-connect-scnet-plus 1.0.0 

第一个稳定版本。0.1.x 期间的功能、配置项与故障模式都已定型，1.0.0 之后**不再有破坏性变更**；
配置字段只增不删，默认行为保持不变。

## 这个版本意味着什么

0.1.2 已把最后一处功能性缺陷（思考档位控件无效）修掉。1.0.0 不带新功能，它的意义是**承诺**：

- **配置稳定**：`apiKey` / `enabled` / `modelSwitches` / `enabledModelIds` / `contextBudgets` /
  `dropForeignThinking` / `dropAllThinking` 字段与语义冻结。新增能力只会加新字段。
- **行为稳定**：默认配置下的行为不再改变——未配置即全部模型可用、默认丢弃跨 provider 的
  thinking、默认不碰本路由自己的 thinking。
- **质量门槛**：12 个门禁、200+ 断言，CI 在 Windows/Linux × Node 22.19/24 四个组合上跑同一套。

## 从 0.1.x 升级

无迁移动作。配置字段、默认值、provider id（`scnet`）全部不变，装完重启一次 DSH 即可。

```sh
dsh plugin --profile desktop remove dsh-connect-scnet-plus
dsh plugin --profile desktop add github:gdyshi/dsh-connect-scnet-plus
```

## 0.1.x 累积的能力

- **零配置接入**：自动发现本机 scnet 客户端凭据并加载模型目录
- **逐模型开关**：插件页勾选；不勾 = 全部可用，勾了 = 只显示勾选的
- **逐模型上下文预算**：`min(原生窗口, 预算)`，只缩不放
- **思考档位真正生效**：六档可选，「关闭」会真的让模型停止思考
- **历史 thinking 开关**：跨 provider / 全局两个开关，默认行为不变
- **pi-ai 世代自适应**：0.82/0.85 与 0.87+/1.x 都可用，无需手动对齐版本
- **图片历史回放**：接入宿主 attachments 服务
- **一键诊断**：`node lib/bin.js`
- **重新登录不重启**：凭据每 5 分钟自动重扫

---

# dsh-connect-scnet-plus 0.1.2 

对照 `dsh-connect-workbuddy` 补齐三项核心能力，其中第一项是**功能性缺陷修复**。

## 0.1.2 的重点

### 1. 思考档位从「假控件」变成真的

之前每个请求都被钉在 `off`。pi-ai 把 `off` 翻译成**不发送 reasoning 字段**，而 SCNet
的模型默认就在思考——所以选择任何档位发出的请求完全相同，控件看着能动、实际无效。

实测确认网关接受两档指令：

| 发送的参数 | 效果 |
|---|---|
| `reasoning_effort: minimal/low/medium/high/xhigh` | 推理量随档位变化 |
| `thinking: {type: "disabled"}` | 完全不思考 |

本版把 `models.json` 的 `thinkingMode: "levels"` 翻译成 `thinkingLevelMap` 并声明
`thinkingFormat: "deepseek"`，pi-ai 据此打出正确参数。没有档位词汇的模型保持原来的
`off` 形态——对它们来说「不发字段」本来就是唯一诚实的请求。

新增两个门禁：`thinking`（22 项，映射/预算/开关）与 `thinking-wire`（7 项，用本地
捕获服务器 + 真实 pi-ai 读取请求体，断言 `high` → `thinking{enabled}` +
`reasoning_effort: high`、`off` → `thinking{disabled}`）。

### 2. 逐模型上下文预算

`contextBudgets`：模型 id → token 上限，生效值 `min(原生窗口, 预算)`，**只缩不放**。
给 1M 窗口的模型设较小预算可显著降成本、减慢上下文膨胀。

### 3. 历史 thinking 开关

`dropForeignThinking`（默认开）与 `dropAllThinking`（默认关），把原先无条件的丢弃
行为变成可配置，**默认行为不变**。`redacted` 块始终保留。

### 结构

描述符构造抽到 peer-free 的 `lib/model-descriptor.js`，与 `rescue-wrap.js` /
`pi-ai-runtime.js` 同一模式——这些规则现在能在裸 checkout 和 CI 上被断言。

## 升级

```sh
dsh plugin --profile desktop remove dsh-connect-scnet-plus
dsh plugin --profile desktop add github:gdyshi/dsh-connect-scnet-plus
```

或在插件管理页点更新，装完重启一次 DSH。

---

# dsh-connect-scnet-plus 0.1.1 

pi-ai 版本自适应版：装完不再需要手动对齐 `@earendil-works/pi-ai`。

## 0.1.1 的重点

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
