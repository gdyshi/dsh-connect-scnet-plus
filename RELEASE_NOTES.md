# dsh-connect-scnet-plus 0.1.0 发布说明

## 这是什么

把本机「超算互联网 / SCNet（计算服务）」客户端已登录的模型接入 DeepSeek Harness 的**增强版插件**。

与 host-only 基础版相比：

- 插件详情页自带「模型 / 说明」tab 卡片
- 逐模型勾选启用（默认全不勾 = 全部可用；勾选后只显示勾选的）
- 支持带图历史回放（接入宿主 attachments 服务）
- 凭据 5 分钟 TTL 重扫，重新登录无需重启
- `node lib/bin.js` 诊断（凭据 / 目录 / 网关 / pi-ai 版本 / 模型启用状态）
- sk-key 只在本机 loopback shim 内注入，绝不写入 DSH 设置文件

## 安装

```sh
# 从 GitHub
dsh plugin --profile desktop add github:<OWNER>/dsh-connect-scnet-plus

# 或从 Release 的 tarball
dsh plugin --profile desktop add file:/绝对路径/dsh-connect-scnet-plus-0.1.0.tgz
```

装完**重启一次 DSH**。

前提：
- DSH 0.2.x
- 本机已登录 scnet 客户端（凭据在 `~/.sclaw/agent/scnet-credentials/`）
- profile 解析到的 `@earendil-works/pi-ai` ≥ 0.87（推荐 1.x，与宿主内置同代）

## 自动化与质量门禁（仓库侧更新，非插件运行时变更）

- 新增单一门禁入口 `scripts/gate.mjs`（8 条门禁、fast/slow 车道、`--list/--only/--lane/--report/--bail`、超时与汇总报告），`npm run check` 变成它的别名。
- 新增 4 条自动化校验：`verify-docs`（链接/锚点/双语配对/文档预算）、`verify-manifest`（package / cordis.patch.yml / locale 三方一致）、`verify-package`（真实 `npm pack` 文件清单）、`verify-automation`（CI/发布/dependabot 结构自测 + 文档与注册表同步）。
- 新增 `.github/workflows/ci.yml`（Node 22.19/24 × Ubuntu/Windows 矩阵、`npm ci`、并发取消、最小权限、gate 报告工件、稳定 required check `all checks passed`）、`.github/workflows/release.yml`（`v*` tag 打包 + GitHub Release）、`.github/dependabot.yml`。
- 新增 `AGENTS.md` 与 `docs/AUTOMATION.md` + `docs/AUTOMATION.zh.md`，说明门禁契约与 DSH 经验来源。
- 修复两个「沉默的坏测试」：`context-rescue.test.mjs` 不再读本机 `~/.sclaw` 凭据、不再 import 不存在的 `./plugin-lib/`；`replay-semantics.test.mjs` 改为断言真实实现。
- 为可测性把纯逻辑抽成零依赖模块：`lib/replay-semantics.js`、`lib/rescue-wrap.js`（adapter 只做组合，运行路径不变）；`check-syntax.mjs` 改为 `node --check` 只解析、不执行模块。
- 提交 `package-lock.json`，CI 用 `npm ci --ignore-scripts` 安装。

## GitHub 仓库建议结构

```
README.md                      本仓库首页（即插件根 README，保持精简）
LICENSE                        MIT
AGENTS.md                      agent / 贡献者的门禁约定（不进 npm 包）
package.json                   name: dsh-connect-scnet-plus, version 0.1.0
package-lock.json              npm ci 复现安装
cordis.patch.yml               - insert: id/name = dsh-connect-scnet-plus
lib/                           宿主半侧 + 浏览器半侧（12 个模块）
  index.js  adapter.js  catalog.js  credentials.js
  shim.js  context-rescue.js  doctor.js  bin.js
  provider-constants.js  client.js
  replay-semantics.js  rescue-wrap.js   （零依赖纯逻辑，便于裸 checkout 测试）
locale/en.json, zh.json        title / description / meta.detail
docs/detail.md, detail.zh.md   插件详情页「详细文档」（极简，避免被宿主全文渲染）
docs/TECHNICAL.md              实现细节（不进详情页面）
docs/AUTOMATION.md, AUTOMATION.zh.md   门禁与自动化说明（DSH 经验来源）
scripts/gate.mjs               门禁入口（发布包不含）
scripts/verify-*.mjs           门禁脚本（发布包不含）
scripts/*.test.mjs             replay / rescue 测试（发布包不含）
.github/workflows/ci.yml       CI 矩阵与稳定 required check
.github/workflows/release.yml  v* tag → 门禁 → tarball → Release
.github/dependabot.yml         npm / actions 周更
```

把本目录所有文件推到仓库根，再打一个 `v0.1.0` tag 并上传
`dsh-connect-scnet-plus-0.1.0.tgz` 到 Release 即可。

## 已知注意事项

1. **pi-ai 版本错配**：宿主内置 pi-ai 会把 system prompt 折成 system 消息；
   若 profile 解析到 <0.87 的版本，会以 `PI_AI_ERROR: reading 'length'`
   本地崩溃。对齐版本即可。
2. **详情页文档**：宿主按 `locale/<lang>.json 的 meta.detail → README.md`
   渲染详情文档，`README.md` 必须保持精简，长文放 `docs/`。
3. **配置残留**：`cordis.patch.yml` 里的 `modelSwitches` 段会持久化；
   清空该段可恢复全部模型。

## 验证记录（发布前）

- `npm run gate` 8/8 通过：syntax（22 个文件 `node --check` + 25 条相对 import 解析）、unit（26 项）、replay（7 项，断言真实实现）、rescue（12 项，纯内存）、docs（8 个 Markdown、双语配对）、manifest、pack（`npm pack` 23 个文件）、automation
- 客户端 smoke：inject `["slots","locale"]`、零参 inject face、
  `plugins.bundle.config` 双 key 注册、tab 结构、模型勾选读写路径
- doctor 六项全绿
- tarball 解包后 JSON/JS 全部可解析
- CI：`.github/workflows/ci.yml` 在 Node 22.19/24 × Ubuntu/Windows 上跑同一入口；`all checks passed` 是稳定 required check
