# dsh-connect-scnet-plus

[![CI](https://github.com/gdyshi/dsh-connect-scnet-plus/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gdyshi/dsh-connect-scnet-plus/actions/workflows/ci.yml)

把本机「超算互联网 / SCNet（计算服务）」客户端已登录的模型接入 DeepSeek Harness。

**这是增强版**：在插件详情页提供「模型 / 说明」tab 卡片，可逐模型勾选启用；支持带图历史；内置诊断。

## 与基础版的区别

| | 基础版 | plus |
|---|---|---|
| 插件详情页设置卡片 | 无 | 「模型 / 说明」两个 tab |
| 逐模型启用 / 停用 | 无 | 勾选框，默认全不勾 = 全部可用 |
| 图片历史回放 | 不支持 | 支持（接入宿主 attachments 服务） |
| 凭据 TTL 重扫 | 无 | 5 分钟自动重扫，重新登录无需重启 |
| doctor 诊断 | 无 | `node lib/bin.js` |
| 凭据只读 | 是 | 是 |

## 安装要求

- DSH 0.2.x（`@deepseek-ai/dsh-llm` / `dsh-llm-pi-ai` peer 范围内）
- 本机已安装并登录过 scnet 客户端（凭据在 `~/.sclaw/agent/scnet-credentials/`）
- **重要**：本机 profile 解析到的 `@earendil-works/pi-ai` 必须与宿内置版本同代（≥0.87，推荐 1.x）。版本错配会导致每个请求在本地崩溃（见 [故障排查](#故障排查)）。

```sh
dsh plugin --profile desktop add github:<你的用户名>/dsh-connect-scnet-plus
# 或者装 tarball
dsh plugin --profile desktop add file:/绝对路径/dsh-connect-scnet-plus-0.1.0.tgz
```

安装后**重启一次 DSH**。

## 使用

- 设置 → 已安装插件 → `dsh-connect-scnet-plus` → 详情页的「模型」tab
- 默认全部不勾选 = 不做限制（所有模型可用）；勾选部分模型后，只有勾选的出现在模型选择器里
- 改动即时写进插件设置，宿主约 10 秒重建模型表，不用重启

## 自动化与质量门禁

一条命令跑完本地全部门禁，与 CI 完全同源：

```sh
npm run gate                  # 全量 8 项：syntax / unit / replay / rescue / docs / manifest / pack / automation
npm run gate -- --lane fast   # 提交前快速档
npm run gate -- --list        # 查看门禁注册表
```

CI 在 Node 22.19 / 24 × Ubuntu / Windows 上运行，任何矩阵腿失败都会让 `all checks passed` 变红；推 `v*` tag 会自动重跑门禁、打包 tarball 并创建 Release。设计原则、门禁明细与排障见 [docs/AUTOMATION.zh.md](docs/AUTOMATION.zh.md)。

## 凭据只读声明

只读扫描以下文件，**绝不写入**任何客户端文件、sclaw 目录或宿主配置：

- `~/.sclaw/agent/scnet-credentials/*.json`（读 `type: "api_key"` 的 key）
- `~/.sclaw/agent/models.json`（读模型目录）

日志与诊断输出中的 key 一律脱敏（前 6 后 4）。sk-key 只在本机 loopback shim 内注入，不进入 DSH 设置文件。

## 诊断

```sh
node lib/bin.js        # 凭据 / 目录 / 网关连通性 / 模型启用状态 / pi-ai 版本
```


## pi-ai 版本：自动适配，不需要手动对齐

`@earendil-works/pi-ai` 是**可选 peer**：装插件时 pnpm 可能给 profile 装一份旧版
（例如 0.82.1），而宿主自己内置的是 1.x。两代 pi-ai 消费的 **context 形状不同**：

- 0.87+ / 1.x：归一化 transcript，system prompt 与 tools 挂在首条 system 消息上
- 0.82 / 0.85：扁平 `{systemPrompt, tools, messages}`，且没有 system 分支

版本错配的典型症状是每个请求在本地 32ms 内崩掉、上游零流量：

```
PI_AI_ERROR: Cannot read properties of undefined (reading 'length')
```

**本插件会自己处理这件事**（做法与 dsh-connect-workbuddy 的 issues #24/#25/#26 一致）：

- 启动时用 `import.meta.resolve` + 读 manifest 判断插件**实际解析到**哪一代
  （不 import，避免加载期崩溃）
- 适配器按世代自动折叠 / 展开 transcript，两代都能正常收发，**不需要你改版本**
- 想知道当前判定结果，跑诊断：

```sh
node lib/bin.js
```

输出里 `piAi.generation` 是 `modern` 或 `legacy`，`piAi.resolvedLocally`
说明是否解析到本地副本。

## 故障排查

**`PI_AI_ERROR: Cannot read properties of undefined (reading 'length')`**：宿主内置
pi-ai 会把 system prompt 折成 system 消息，而插件解析到的旧版 pi-ai(<0.87)
无法处理。把 profile 的 `@earendil-works/pi-ai` 对齐到宿主内置版本即可。

**`pi-ai image input requires the durable attachment service`**：本版已接入
`ctx.get("attachments")`,若仍出现说明宿主未提供该服务。

**模型选择器里一个 scnet 模型都没有**：检查 `cordis.patch.yml` 是否残留
`modelSwitches` 段；清空即可恢复全部模型。

## 风险提示 / 免责声明

- 依赖 scnet 客户端**非官方开放接口**（客户端内部缓存与网关），上游调整后插件可能失效。
- 通过个人 API Key 调用网关受服务条款约束，请自行评估账号风险（限流、封禁等）。本项目与超算互联网官方无关。
- 免费与计费模型的具体价格以官方为准；「免费」标注仅依据客户端缓存的 `priceLabel`。
- 使用本项目产生的任何后果由使用者自行承担。

## License

MIT

实现细节见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。
