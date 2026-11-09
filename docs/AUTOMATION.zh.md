# 自动化与质量门禁

本仓库的自动化体系借鉴自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的工程实践
（`scripts/run-gates.ts` 的单一门禁入口、`scripts/ci-workflow.spec.ts` 的「workflow 也被测试」、
`verify-md-links` / `verify-doc-budgets` 的文档即代码、发布与 CI 的权限/并发分离），
并按单包、纯 ESM、无构建步骤的规模做了裁剪。

核心只有一句话：**本地和 CI 跑的是同一个入口、同一份门禁注册表。**

## 一条命令

```sh
npm run gate                        # 全量门禁（CI 也跑这个）
npm run gate -- --lane fast         # 提交前快速档：不含 pack / automation
npm run gate -- --list              # 列出门禁注册表
npm run gate -- --only docs,manifest # 只跑指定门禁（调试用）
npm run gate -- --report gate-report.json  # 额外写机器可读报告（CI 工件）
npm run gate -- --bail              # 首个失败即停（CI 省时间；本地默认全量报告）
```

退出码：`0` 全绿，`1` 有失败或超时，`2` 用法错误。

## 门禁注册表

| 门禁 | 脚本 | 检查什么 | 车道 |
|---|---|---|---|
| syntax | `scripts/check-syntax.mjs` | `lib/*.js`、`scripts/*.mjs` 逐个 `node --check`（只解析、不执行），并静态校验相对 import 指向真实文件 | fast |
| unit | `scripts/selftest.mjs` | 凭据发现、模型目录与选择语义、loopback shim 的 26 项行为断言 | fast |
| replay | `scripts/replay-semantics.test.mjs` | 跨 provider 历史重放：自身 `dsh-foreign` 身份修复、外来 thinking 丢弃、同路由保留、畸形结构加固 | fast |
| rescue | `scripts/context-rescue.test.mjs` | 上下文溢出救援：折叠预算、尾部收缩、单 session 去重、旁路条件、错误事件原样转发 | fast |
| docs | `scripts/verify-docs.mjs` | Markdown 相对链接与 `#锚点`、代码围栏闭合、中英配对标题数一致、README/详情页文档预算 | fast |
| manifest | `scripts/verify-manifest.mjs` | `package.json` / `cordis.patch.yml` / `locale/*.json` 三方一致（id、名字、meta.detail、双语键集合） | fast |
| pack | `scripts/verify-package.mjs` | `exports`/`files` 指向真实文件、依赖精确锁定、`npm pack` 实际文件清单与版本一致 | slow |
| automation | `scripts/verify-automation.mjs` | CI / 发布 / dependabot 的结构自测；文档门禁表与 `GATES` 注册表同步 | slow |

新增或改名门禁时，`docs/AUTOMATION.md` 与本文档必须同步，否则 `automation` 门禁失败。

设计约束（所有门禁共同遵守）：

- **零依赖**：只需要 Node 内置模块，裸 checkout 上直接可跑，不需要 `npm install`；
- **自足**：不联网、不读 `~/.sclaw`、不依赖本机路径；需要凭据/目录时用临时目录与构造数据；
- **可诊断**：各自打印 `PASS`/`FAIL` 行并以退出码表态，`gate.mjs` 汇总耗时与状态。

## 设计原则（来自 DSH）

1. **单一入口**：对外门禁入口只有 `gate` 这个名字（`gate:fast` / `gate:list` 只是薄别名）；CI 调用的就是它，没有第二套命令，本地绿可以预测 CI 绿。
2. **快慢分层**：`--lane fast` 是提交前的秒级检查；`pack` / `automation` 这类慢检查留在全量与 CI。hook 只做能秒级失败的事，慢检查会被绕过。
3. **门禁自测**：workflow 是唯一「改错了没人编译」的代码，所以 `verify-automation` 用断言检查 CI 的触发、矩阵、权限、并发、超时，以及文档与注册表是否同步。
4. **失败要完整报告**：默认跑完全部门禁再汇总；被杀或超时记失败，绝不记通过（DSH 在 Windows 上专门处理「被 kill 与失败不可区分」）。
5. **确定性**：提交 `package-lock.json`，CI 用 `npm ci --ignore-scripts` 安装；测试不读真实凭据、不联网。
6. **最小权限**：CI 顶层 `permissions: contents: read`；只有发布 workflow 需要 `contents: write`。
7. **稳定 required check**：分支保护只认 `all checks passed` 这个 job，而不是会随矩阵变化的矩阵腿名。
8. **超时与并发**：每个 job 有 `timeout-minutes`；校验类 `cancel-in-progress: true`，发布类 `cancel-in-progress: false`。
9. **文档即代码**：链接、锚点、配对、预算全部机检——文档腐化是渐进的，只有机械检查能持续。
10. **发布独立 lane**：`v*` tag 触发 `release.yml`，重新跑一遍门禁、打 tarball、创建 GitHub Release。

## CI 与发布

`.github/workflows/ci.yml`（唯一校验 workflow）：

- 触发：`push` 到 `main`、`pull_request`、`workflow_dispatch`；
- 矩阵：Node `22.19.0`（engines 下限）与 `24.x` × Ubuntu 与 Windows，`fail-fast: false`；
- 步骤：`actions/checkout@v4`（`persist-credentials: false`）→ `actions/setup-node@v4`（npm 缓存）→ `npm ci` → `npm run gate -- --report gate-report.json` → 上传报告工件（`if: always()`）；
- 汇聚 job `all checks passed`：任何矩阵腿失败/取消/跳过都会让它失败，供分支保护引用。

`.github/workflows/release.yml`：`v*` tag 触发，权限 `contents: write`、并发不取消，重跑门禁、校验 tag 与 `package.json` 版本一致后 `npm pack` 并 `gh release create` 上传 tarball。

`.github/dependabot.yml`：npm 与 GitHub Actions 每周更新，走同一套 PR 门禁。

## 新增一条门禁

1. 写一个零依赖脚本（`scripts/verify-*.mjs` 或 `*.test.mjs`）：打印 `PASS`/`FAIL`，失败 `process.exit(1)`，超时可控。
2. 注册到 `scripts/gate.mjs` 的 `GATES`：`name`、`lane`、`script`、`timeoutMs`、`about`。
3. 在 `docs/AUTOMATION.zh.md`、`docs/AUTOMATION.md` 的门禁表里加一行。
4. 本地验证：`npm run gate -- --only <name>` 与 `npm run gate`。
5. 提交后看 CI 的 `all checks passed` 是否绿；需要时把新工件加入 `ci.yml`。

若门禁依赖外部工具或网络，默认不要放进 `fast` 车道，也不要放进 CI——先让它在裸 checkout 上可复现。

## 排障

- **某个 gate 失败**：`npm run gate -- --only <name>` 单独复现；需要完整上下文用 `--report gate-report.json` 看 `gates[].status` 与耗时。
- **`npm run gate` 通过、CI 失败**：先看是否平台相关（路径分隔符、`USERPROFILE`）；CI 与本地命令完全相同，差异通常来自 Node 版本或操作系统。
- **文档门禁报 `missing anchor`**：锚点由标题 slug 生成，改标题后要同步更新指向它的链接。
- **pack 门禁报文件缺失**：`npm pack` 的文件集合由 `files` 白名单决定，新增运行时文件必须同时改白名单与 `required` 列表。
- **发布 workflow 未运行**：它只在推送 `v*` tag 时触发；普通 push 只跑 CI。

## 刻意不做的事

以下 DSH 机制针对 pnpm monorepo / TypeScript / 多平台付费 runner，本仓库不引入：pnpm workspace 与 `workspace:*`、`tsc -b` 工程引用、按文件 100% 覆盖率、覆盖率分片与时长历史缓存、i18n sidecar（`.i18n.yaml`）、自托管 runner failover 与 Wine 打包、`pull_request_target` 触发器。
