# AGENTS.md

本仓库给自动化 agent（以及人类贡献者）的常驻约定。只有一条核心规则：**改完东西，用同一条命令证明没破坏仓库。**

## 1. 完成 = 门禁全绿

改完任何文件后运行：

```sh
npm run gate                  # 全量：本地与 CI 是同一个入口
npm run gate -- --lane fast   # 提交前的快速档（syntax/unit/replay/rescue/docs/manifest）
```

失败先修代码或测试，不要把门禁改绿。确实要改门禁，在提交说明里写清原因。禁止在没运行门禁的情况下声称完成。

## 2. 门禁注册表是唯一事实来源

新增一条检查必须同时改三处：

1. `scripts/gate.mjs` 里的 `GATES`（name / lane / script / timeoutMs / about）；
2. `docs/AUTOMATION.zh.md` 与 `docs/AUTOMATION.md` 的门禁表；
3. 需要时 `.github/workflows/ci.yml` 的步骤。

`scripts/verify-automation.mjs` 会在文档与注册表漂移时失败——不要绕过它。

## 3. 测试必须自足（hermetic）

- 只用 Node 内置模块；不联网（测试自己起的 loopback mock 可以），不读 `~/.sclaw`、真实 scnet 凭据或本机绝对路径。
- 需要凭据/目录时用临时目录和构造数据，测试结束清理监听端口。
- 测试必须 `import` 仓库里的真实实现，不能把逻辑复制一份到测试文件里再断言（那会实现改了测试还绿）。
- 需要宿主 peer 的代码，把纯逻辑抽成无 peer 依赖的模块再测（见 `lib/replay-semantics.js`、`lib/rescue-wrap.js`）。

## 4. 文档即代码

- 相对链接和 `#锚点` 必须可解析；中英配对文档的标题数量必须一致（`docs/detail.md` ↔ `docs/detail.zh.md`，`docs/AUTOMATION.md` ↔ `docs/AUTOMATION.zh.md`）。
- README 保持精简：宿主详情页直接渲染 README，长文放 `docs/`。
- 每个事实只有一个家：门禁清单归 `GATES` 与 AUTOMATION 文档，别在第三处复制。

## 5. 不要制造假绿

- 被超时杀掉的 gate 记失败，不记通过；不要用 `|| true` 吞退出码。
- 不提交 `node_modules/`、`*.tgz`、`gate-report.json`、日志或本机路径。
- 不写 `~/.sclaw`、宿主配置或 scnet 客户端文件；运行时插件自身也只读。
