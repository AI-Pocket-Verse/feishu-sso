# 机器人对话后端协议

feishu-sso 持有飞书应用凭证，负责收发飞书消息；「怎么回答」交给一个独立的对话后端（例如同系列的 team-knowledge）。两者之间只走下面这几个内网 HTTP 接口。

- 后端地址：feishu-sso 的 `BOT_BACKEND_URL`，例如 `http://127.0.0.1:4030`。不设置时机器人对所有提问只回复「还没有接入对话后端」，下文所有转发都不会发生。
- 鉴权：每个请求都带请求头 `x-internal-token`，值是双方共同配置的 `INTERNAL_API_TOKEN`。后端应拒绝口令不符的请求（返回 401）。
- 身份：机器人事件与登录挂在同一个飞书应用上，所以消息发送者的 `open_id` 与 `/api/whoami` 返回的 `user.open_id` 一致，后端可以据此对应到自己的账号。

## feishu-sso 调用后端

### 对话：`POST /api/internal/feishu/chat`

私聊机器人，或在群里 @ 机器人时调用。

请求体（JSON）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `openId` | string | 提问人的 open_id |
| `text` | string | 提问文字，已去掉 @ 占位符；纯图片提问时为空字符串 |
| `scope` | `"p2p"` \| `"group"` | 私聊或群聊。群聊的回答全群可见，后端应只使用公开内容 |
| `images` | string[]，可选 | 图片地址，来自下面的图片接口，最多 3 张 |

成功时返回 `text/event-stream`，每帧为 `event: <名称>` 加一行 `data: <JSON>`，以空行结束：

| 事件 | data | feishu-sso 的处理 |
| --- | --- | --- |
| `token` | `{"text": "..."}` | 追加到回答，节流后更新卡片，形成打字机效果 |
| `queued` | `{"message": "..."}` | 同一会话上一轮还没答完，把卡片换成这段排队提示 |
| `need_login` | `{"message": "..."}` | 提问人还不能使用（如未开通），卡片最终显示这段话 |
| `error` | `{"message": "..."}` | 卡片末尾附上这段错误说明 |
| `done` | 任意 | 结束 |

非 200 时请返回 JSON（不要返回 SSE）：503 表示维护中，卡片显示「维护中，请稍后再试」；其他状态显示「连接失败」。

### 图片落盘：`POST /api/internal/feishu/image`

用户给机器人发图片时，feishu-sso 先从飞书下载，再交给后端保存，换回可以放进 `images` 的地址。

- 请求：`Content-Type: application/octet-stream`，请求体为图片字节；请求头 `x-open-id` 为上传人 open_id。
- 响应：`{"url": "/uploads/xxx.png"}`。

### 群聊旁听：`POST /api/internal/feishu/group-observe`

机器人所在群里没有 @ 机器人的文字消息会转发过来，由后端决定要不要主动回答。需要飞书权限 `im:message.group_msg`。

- 请求体：`{"chatId", "messageId", "openId", "senderName", "text"}`。
- 后端应立即返回 200，判断与回复异步进行；要回复时调用 feishu-sso 的 `POST /api/feishu/reply`。

### 卡片按钮回调

后端发出的卡片里，按钮的 `value` 决定点击后转发到哪里。feishu-sso 先在 3 秒内给点击人回一个提示（toast），再异步转发：

| 按钮 `value` | 转发到 | 请求体 |
| --- | --- | --- |
| `{"k": "doc_audit_ack", "h": "<hash>"}`（勾选器） | `/api/internal/doc-audit/acknowledge` | `{"hash", "operatorOpenId", "checked"}` |
| `{"k": "group_qa_up" \| "group_qa_down", "h": "<hash>"}` | `/api/internal/group-qa/feedback` | `{"hash", "helpful"}` |
| `{"kind": "expert_escalation", "escalationId", "option"}` | `/api/internal/expert-escalation/resolve` | `{"escalationId", "resolution", "operatorOpenId"}` |

`doc-audit/acknowledge` 的响应可以带 `{"card": {...}}`，feishu-sso 会用它原地更新被点击的那张卡片。

## 后端调用 feishu-sso

以下接口同样用 `x-internal-token` 鉴权，消息都以机器人身份发出。卡片支持 1.0（`elements`）和 2.0（`schema: "2.0"` + `body.elements`）两种结构，序列化后不超过 20000 字符。

| 接口 | 请求体 | 说明 |
| --- | --- | --- |
| `POST /api/feishu/notify` | `{"openId": "ou_…", "card"}` 或 `{"chatId": "oc_…", "card"}` | 给某人或某个群发卡片，返回 `{"messageId"}` |
| `POST /api/feishu/reply` | `{"messageId": "om_…", "card"}` | 引用回复一条收到的消息 |
| `POST /api/feishu/reaction` | `{"messageId": "om_…", "emojiType": "THUMBSUP"}` | 给消息加表情回复，需要权限 `im:message.reactions:write_only` |
| `POST /api/feishu/upload-image` | 图片字节（octet-stream，≤ 5 MB） | 上传到飞书素材库，返回 `{"imageKey"}`，可用于卡片的 `img` 元素 |
