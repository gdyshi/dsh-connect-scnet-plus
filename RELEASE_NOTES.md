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

## GitHub 仓库建议结构

```
README.md                      本仓库首页（即插件根 README，保持精简）
LICENSE                        MIT
package.json                    name: dsh-connect-scnet-plus, version 0.1.0
cordis.patch.yml                - insert: id/name = dsh-connect-scnet-plus
lib/                            宿主半侧 + 浏览器半侧
  index.js  adapter.js  catalog.js  credentials.js
  shim.js  context-rescue.js  doctor.js  bin.js
  provider-constants.js  client.js
locale/en.json, zh.json        title / description / meta.detail
docs/detail.md, detail.zh.md   插件详情页「详细文档」（极简，避免被宿主全文渲染）
docs/TECHNICAL.md              实现细节（不进详情页面）
scripts/                       selftest / check-syntax / live-check（发布包不含）
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

- 26 项单测通过、check-syntax 0
- 客户端 smoke：inject `["slots","locale"]`、零参 inject face、
  `plugins.bundle.config` 双 key 注册、tab 结构、模型勾选读写路径
- doctor 六项全绿
- tarball 解包后 JSON/JS 全部可解析
