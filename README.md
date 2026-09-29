# Browser Agent Bridge

一个面向开发者模式的浏览器控制桥：浏览器扩展连接用户当前浏览器，Node WebSocket bridge 向任意 Agent 暴露稳定的 JSON 请求/响应协议。能力通过 `bridge.listTools` 动态发现，后续可增加 CDP、网络拦截、Cookie、下载、扩展调试和自定义命令，而不改变 Agent 接口。

## 当前纵向切片

- 扩展连接本地 `ws://127.0.0.1:8765`，自动重连。
- Agent 可调用 `bridge.ping`、`bridge.listTools`、`browser.inspect`、`browser.observe`、`browser.execute`。
- 页面读取：`observe`（紧凑语义树和稳定 `ref`）、`getText`、`getHtml`、受控 `evaluate`。
- 页面控制：优先使用 `ref`，也支持 CSS selector 和坐标：`click`、`type`、`key`、`scroll`、`wait`、`navigate`、截图。
- 操作采用 AutoGLM 风格的“观察→动作→再次观察”闭环：Agent 先获取页面状态和元素矩形，再发送动作，随后根据结果决定下一步，而不是依赖脆弱的固定脚本。
- 可选 Chrome debugger attach/detach 入口，为 CDP 深度调试保留扩展点。
- 所有请求带 `id`、超时和结构化错误；可通过 `BRIDGE_TOKEN` 启用本地桥鉴权。
- 支持多个 Agent 同时连接：同一 `tabId` 的写操作按队列顺序执行，不同标签页并行；Agent 断线、超时都会释放自己的任务，不会留下进程锁。
- 扩展连接使用 `?role=extension`，Agent 连接不需要特殊参数；只有扩展连接可以提交浏览器执行结果，避免 Agent 互相串响应。
- `bridge.queueStatus` 可查看每个标签页的活动任务、排队任务、预计成本、等待时间、动态得分和公平性状态；`bridge.cancel` 可取消当前 Agent 自己的排队任务。
- `bridge.agentStatus` 可查看当前活跃 Agent 操作和最近 50 条协作事件；所有 Agent 会收到 `agent.activity` 事件广播。
- 可选 Chrome 本地模型调度顾问：当单页队列拥堵时，通过扩展 service worker 的 `LanguageModel` Prompt API 做异步排序建议；`bridge.aiStatus` 可检查 Chrome 是否暴露已可用模型。
- 取消正在执行的任务时只会立即结束 Agent 等待，不会提前释放标签页队列；Bridge 会等待扩展真正返回后才调度下一步，防止“取消”制造隐性并发。

## 启动

```powershell
npm install
$env:BRIDGE_TOKEN = "change-me"
npm run dev
```

在 Chrome 的 `chrome://extensions` 开启“开发者模式”，选择“加载已解压的扩展程序”，加载 `extension` 目录。启用 token 时，将扩展中的 `BRIDGE_URL` 改为 `ws://127.0.0.1:8765/?role=extension&token=change-me`，并让 Agent 使用 `Authorization: Bearer change-me`。生产环境应将 token 通过受控配置注入，并将扩展、桥和 Agent 放在同一可信边界内。

### 复用已安装的 Browser MCP 扩展

如果使用已安装的 **Browser MCP** 扩展（它连接 `ws://localhost:9009`），可启用兼容适配器，不需要加载本项目原型扩展：

```powershell
$env:BRIDGE_EXTENSION_PROTOCOL = "browsermcp"
$env:BRIDGE_PORT = "8765"
$env:BRIDGE_BROWSERMCP_PORT = "9009"
npm run dev
```

在 Browser MCP 扩展弹窗中连接目标标签页。Bridge 作为本地兼容 WebSocket 服务接收扩展连接，并保留自己的 Agent 多连接入口（8765）和队列调度。该适配器依照 Browser MCP 扩展现有的 `{ id, type, payload }` 请求、`messageResponse` 回包格式，不会改写或安装扩展。

兼容动作包括 Browser MCP 扩展实际支持的 `browser_snapshot`、`browser_navigate`、`browser_click`、`browser_type`、`browser_press_key`、`browser_wait`、`browser_screenshot`、`browser_hover`、`browser_drag`、`browser_select_option`、Console logs 和前进/后退。`click`/`type` 的 `args.element` 必须使用 Browser MCP 的可访问性元素描述；本项目原型扩展产生的 `ref` 和 CSS selector 不能直接当作该扩展的 locator。

Browser MCP 当前只连接扩展中选定的一个标签页，所以兼容模式将所有页面操作收敛到 `browsermcp:selected-tab` 单队列串行执行。它不会假装拥有本扩展未暴露的多标签控制、完整 DOM/HTML读取或 Chrome 本地 `LanguageModel` 能力。`browser.inspect` 会返回当前适配器能力和限制；`bridge.aiStatus` 会如实说明该适配器不提供模型调用。

## 多 Agent 顺序与并发

每个 Agent 为请求提供唯一 `id`、明确的 `tabId` 和可选的 `agentId`。`browser.execute` 等会改变页面的命令按 `tab:<tabId>` 排队；同一标签页永不并发执行，避免输入、导航和点击相互覆盖。没有 `tabId` 时会进入共享 `tab:active` 队列，因此生产 Agent 应先调用 `browser.inspect`/`browser.observe` 获得目标标签页并始终带上 `tabId`。`browser.observe` 和 `browser.inspect` 是只读请求，可跨标签页并行。

所有 Agent 都会收到协作事件：

```json
{
  "type": "event",
  "event": "agent.activity",
  "payload": {
    "agentId": "agent-a",
    "requestId": "agent-a-step-001",
    "method": "browser.execute",
    "tabId": 123,
    "state": "running",
    "summary": "click",
    "updatedAt": 1780000000000
  }
}
```

Agent 应在收到其他 Agent 对同一 `tabId` 的 `queued`/`running` 通报时避免基于旧观察结果继续写入；先重新 `browser.observe`，必要时等待队列空闲。这样“谁在操作哪个页面、做什么、是否完成”对所有 Agent 可见，不会因为互相不知道而重复翻动页面或产生质疑。

队列不会占用 Node 进程锁：等待任务只是内存队列，单任务最多等待 5 分钟；扩展无响应会返回 `timeout` 并自动继续队列，Agent 断开会移除排队任务并释放活动任务。

## 大量 Agent 的公平调度

每个写请求可以声明：

```json
{
  "priority": 10,
  "estimatedSteps": 1,
  "estimatedCostMs": 800,
  "preemptible": true,
  "deadlineAt": 1780000005000
}
```

Bridge 使用以下综合调度分数，而不是单看优先级：

- 显式 `priority`：表达业务紧急程度；
- 等待时间老化：等待越久分数越高，避免低优先级任务饥饿；
- 短任务奖励：少步骤、低成本的任务更快完成，提升整体吞吐；
- 截止时间提升：接近截止时间的任务自动获得额外权重；
- Agent 公平性：同一个 Agent 连续占用同一页面达到阈值后会让其他 Agent 获得机会。

当前命令仍然是**不可抢占的单步执行**：Bridge 不会在浏览器点击或输入过程中强行打断。长流程应由 Agent 拆成多个短请求，每一步完成后重新观察；这样其他 Agent 可以在步骤边界获得调度机会。`preemptible` 用于向调度器声明任务可拆分意愿，不会伪造浏览器层面的中途抢占。

队列事件会携带排序后的 `effectiveScore`、`waitMs`、`estimatedSteps` 和 `estimatedCostMs`，Agent 可以据此调整后续任务，而不是盲目重复提交：

```json
{
  "event": "queue.changed",
  "payload": {
    "key": "tab:123",
    "scheduling": {
      "policy": "priority+aging+short-job+deadline+agent-fairness",
      "consecutiveJobs": 2
    },
    "queued": [
      {
        "id": "agent-b-short",
        "effectiveScore": 31.2,
        "waitMs": 4200,
        "estimatedSteps": 1,
        "estimatedCostMs": 500
      }
    ]
  }
}
```

建议长流程采用“单步提交 → 等待完成 → 重新 observe → 提交下一步”，不要一次提交几十个不可见的操作。这样既保持页面顺序，也能让简单任务快速穿插完成。

## 高并发兜底与过载响应

调度器不依赖本地模型，也不会让队列无界增长。默认硬限制如下，可用环境变量调整：

| 环境变量 | 默认值 | 用途 |
|---|---:|---|
| `BRIDGE_MAX_AGENTS` | 64 | 同时连接的 Agent 数上限 |
| `BRIDGE_MAX_ACTIVE_REQUESTS` | 256 | 同时在浏览器执行/等待响应的请求上限 |
| `BRIDGE_MAX_QUEUED` | 2000 | 所有页面的排队任务总上限 |
| `BRIDGE_MAX_QUEUED_PER_TAB` | 250 | 单个标签页的排队上限 |
| `BRIDGE_MAX_QUEUED_PER_AGENT_PER_TAB` | 25 | 单个 Agent 连接在同一标签页的排队配额 |
| `BRIDGE_MAX_QUEUE_WAIT_MS` | 300000 | 排队等待最长时间，超时自动移除 |
| `BRIDGE_MAX_AGENT_BUFFERED_BYTES` | 1048576 | Agent/扩展事件缓冲水位 |

触及任何限制时，Bridge 会快速返回 `bridge_overloaded`、`tab_queue_full`、`agent_queue_quota`、`active_request_limit` 或 `queue_wait_timeout`，错误带 `retryAfterMs` 与限制信息；不会接受后无限等待。Agent 应退避重试（建议指数退避并加随机抖动），并先查询 `bridge.queueStatus` / `bridge.agentStatus`，避免重试风暴。

事件消费者如果网络慢、接收缓冲超过水位，Bridge 会暂时跳过广播并在恢复后发送 `bridge.eventsMissed`，要求 Agent 重新查询状态快照。这样慢 Agent 不会拖慢浏览器控制循环，且可以通过状态接口恢复，不会将实时事件当作唯一事实来源。

Agent 连接达到上限时，新连接会收到 `agent_connection_limit` 并以 1013 关闭；可提高限制，但需同步评估 CPU、内存、WebSocket 缓冲和浏览器操作能力。`bridge.ping` 会回报当前在线 Agent、活动/排队数量与生效限制，可用于外部弹性扩缩容或告警。

## 可选 Chrome 本地模型调度顾问

项目不复制或捆绑模型。扩展直接采用 Chrome Prompt API（`LanguageModel.availability()` / `LanguageModel.create()`）调用浏览器已有的 on-device 模型，模式参考 [Chrome Extensions Prompt API 指南](https://developer.chrome.com/docs/ai/prompt-api) 和 [GoogleChromeLabs Web AI demos](https://github.com/GoogleChromeLabs/web-ai-demos)。扩展不请求额外 AI 权限，Bridge 只发送任务元数据（任务 ID、Agent ID、动作名、估算步骤/成本、等待时间、截止时间），不会发送网页正文、DOM、Cookie 或用户输入。

拥堵到 `BRIDGE_AI_SCHEDULER_MIN_QUEUE`（默认 4 个等待任务）时，Bridge 异步向扩展询问排序建议。模型调用最多等待 800ms，最多同时进行一个建议；调度执行不会等待模型。模型只能对已有 request ID 排序，Bridge 丢弃未知 ID，并将建议限制为最多 8 分的平分加权，不得越过优先级/老化/公平性规则。Chrome API 未暴露、模型未就绪、推理超时/错误或输出无效时，广播 `scheduler.advisor` fallback 事件并继续确定性调度。

为避免后台静默下载或等待用户激活，扩展只在 `LanguageModel.availability()` 返回 `available`（兼容旧版 `readily`）时调用模型；`downloadable` / `downloading` 状态不会由任务队列自动触发下载，直接走规则调度。通过 `BRIDGE_AI_SCHEDULER=0` 可关闭顾问。使用 `bridge.aiStatus` 可以检查本机当前状态；本地模型是否存在取决于 Chrome 版本、设备、策略和用户 profile，因此不能仅凭“Chrome 曾经下载过模型”推断扩展一定可用。要实际启用，请在 Chrome 开发者模式加载本项目 `extension` 目录并保持 Bridge 连接，再让 Agent 调用 `bridge.aiStatus`；模型不可用仍会正常走确定性调度。

建议 Agent 在每次写操作前保存一次观察结果，并在请求中携带明确 `tabId`、`agentId` 和唯一 `id`。如果需要放弃工作，调用：

```json
{
  "id": "cancel-1",
  "type": "request",
  "method": "bridge.cancel",
  "params": { "requestId": "agent-a-step-001" }
}
```

## 协议示例

```json
{
  "id": "req-1",
  "type": "request",
  "method": "browser.execute",
  "tabId": 123,
  "params": {
    "command": "click",
    "args": { "ref": "e3" }
  }
}
```

“全量能力”不能安全地由单一脚本承诺：浏览器权限、跨域策略、用户手势、站点 CSP 和 Chrome 的受限页面都会形成边界。该项目把能力发现、权限、调试和扩展点显式化，后续可以逐项增加权限并保留审计，而不是用静默绕过方式制造不可控的安全死角。
