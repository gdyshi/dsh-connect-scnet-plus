# dsh-connect-scnet-plus 技术说明

本文件保存实现细节与设计说明。插件页显示的是根目录 README.md 的精简版。

## 工作原理

scnet 客户端把 OpenAI 兼容的 LLM 网关留在本机工具链里:

- 网关:`https://api.scnet.cn/api/llm/v1`(`/chat/completions`、`/models`,支持 SSE、tool calls、`reasoning_content`)
- 鉴权:`Authorization: Bearer sk-…`,key 缓存在 `~/.sclaw/agent/scnet-credentials/<hash>.json`
- 模型目录(含 contextWindow / maxTokens / 输入模态 / 价格标签)缓存在 `~/.sclaw/agent/models.json` 的 `providers.scnet.models` + `visibleModelIds`

插件做四件事:

1. **凭据发现(只读)**:优先级为 插件设置里的 `apiKey` → 环境变量 `SCNET_API_KEY` → 扫描 `~/.sclaw/agent/scnet-credentials/*.json` 中所有 `type: "api_key"` 的 key。结果按 5 分钟 TTL 重扫。
2. **模型目录**:优先读本机 `models.json`(按 `visibleModelIds` 过滤),失败则请求网关 `GET /models`;内存缓存 10 分钟。免费模型在显示名上标注「· 免费」。
3. **安全 loopback shim**:provider 所有模型的 `baseUrl` 指向本机 `127.0.0.1:<随机端口>`,由每次进程启动时随机生成的 secret 保护(Host/Origin 回环校验 + 常数时间 Bearer 比对)。shim 收到请求后把 `Authorization` 替换为真实 sk-key 转发到网关,上游响应(含 SSE)原样透传。
4. **provider 注册**:通过宿主 `llm` 服务 `registerAdapter` / `registerConfigurableProviders` 注册名为 `scnet` 的 provider。

## 模型开关

设置字段 `modelSwitches`:一个模型一个布尔值。默认全部不勾选 = 不做限制(所有模型可用);勾选任意模型后,只有勾选的出现在模型选择器里。清空配置不会让模型页空白。

浏览器端卡片照 `dsh-connect-workbuddy` 的结构实现:`inject: ["slots","locale"]`,软获取 `configForms`,`whileServed` 绑定命名空间,注册进 `plugins.bundle.config` 槽位,消费宿主传入的表单快照。

## 凭据只读声明

本插件 **只读** 以下文件,**绝不写入** 任何客户端文件、sclaw 目录或宿主配置:

- `~/.sclaw/agent/scnet-credentials/*.json`(读 sk-key)
- `~/.sclaw/agent/models.json`(读模型目录)

诊断输出与日志中的 key 一律脱敏(前 6 后 4)。

## 风险提示 / 免责声明

- 本插件依赖 scnet 客户端 **非官方开放接口**(客户端内部缓存与网关),上游随时可能调整,调整后插件可能失效。
- 通过个人 API Key 调用网关受服务条款约束,**请自行评估账号风险**(限流、封禁等)。本项目与超算互联网官方无关。
- 免费与计费模型的具体价格以官方为准;本插件标注「免费」仅依据客户端缓存的 `priceLabel` 字段。
- 使用本项目产生的任何后果由使用者自行承担,作者不承担责任。

## 跨 provider 历史重放与上下文溢出救援

适配层按 `dsh-connect-workbuddy` 验证过的语义处理两件事(独立实现):

1. **重放准备**(lib/adapter.js 的 sanitizeOptions):先对齐自己路由名下被宿主降级成 `api:'dsh-foreign'` 的历史 assistant 消息,再对真外来的消息无条件删除其 thinking 块(redacted 除外),同路由换模型的消息不动;另做结构加固,防止宿主 dsh-llm-pi-ai 层在畸形形状上崩溃。
2. **上下文溢出救援**(lib/context-rescue.js):上游确认溢出时,在错误事件继续传递**之前**折叠最旧的历史(tokenMeter 测量 → compaction.compactRegion,目标 60% 窗口、单块 35% 预算、最多 8 轮、tail 边最多收缩 24 次、单次折叠 180s 超时),避免宿主压缩请求自己超限的死锁。错误事件原样转发,是否重试由宿主决定。

## License

MIT
