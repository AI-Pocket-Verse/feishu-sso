# Bot chat backend protocol

English | [简体中文](bot-backend-CN.md)

feishu-sso holds the Feishu app credentials and sends and receives Feishu messages; "how to answer" is left to a separate chat backend that you provide. The two only talk over the internal HTTP endpoints below.

- Backend URL: feishu-sso's `BOT_BACKEND_URL`, e.g. `http://127.0.0.1:4030`. When it is not set, the bot answers every question with "not connected to a chat backend yet" and none of the forwarding below happens.
- Authentication: every request carries the header `x-internal-token` with the `INTERNAL_API_TOKEN` both sides share. The backend should reject requests with a wrong token (401).
- Identity: bot events and login use the same Feishu app, so a message sender's `open_id` equals the `user.open_id` returned by `/api/whoami`, and the backend can map it to its own account.

## feishu-sso calls the backend

### Chat: `POST /api/internal/feishu/chat`

Called when someone messages the bot directly or @-mentions it in a group.

Request body (JSON):

| Field | Type | Description |
| --- | --- | --- |
| `openId` | string | The asker's open_id |
| `text` | string | Question text with the @ placeholder removed; empty string for image-only questions |
| `scope` | `"p2p"` \| `"group"` | Direct message or group. Group answers are visible to the whole group, so the backend should only use public content |
| `images` | string[], optional | Image URLs from the image endpoint below, at most 3 |

On success, respond with `text/event-stream`. Each frame is `event: <name>` plus one `data: <JSON>` line, ending with a blank line:

| Event | data | What feishu-sso does |
| --- | --- | --- |
| `token` | `{"text": "..."}` | Appends to the answer and updates the card (throttled) for a typewriter effect |
| `queued` | `{"message": "..."}` | The previous turn of the same conversation is still running; replaces the card with this queue notice |
| `need_login` | `{"message": "..."}` | The asker can't use the bot yet (e.g. not enabled); the card ends with this text |
| `error` | `{"message": "..."}` | Appends this error description to the card |
| `done` | any | End |

For non-200 responses, return JSON (not SSE): 503 means maintenance and the card shows "under maintenance, please try again later"; other statuses show "could not connect". The language of these fixed card texts follows feishu-sso's `BOT_LANG`; the `message` of `queued`, `need_login` and `error` comes from the backend and is shown as is.

### Storing images: `POST /api/internal/feishu/image`

When a user sends the bot an image, feishu-sso downloads it from Feishu and hands it to the backend, getting back a URL that can go into `images`.

- Request: `Content-Type: application/octet-stream`, body is the image bytes; header `x-open-id` is the uploader's open_id.
- Response: `{"url": "/uploads/xxx.png"}`.

### Listening to groups: `POST /api/internal/feishu/group-observe`

Text messages in the bot's groups that do not @-mention the bot are forwarded here, and the backend decides whether to answer proactively. Requires the Feishu scope `im:message.group_msg`.

- Request body: `{"chatId", "messageId", "openId", "senderName", "text"}`.
- The backend should return 200 immediately and decide / reply asynchronously; to reply, call feishu-sso's `POST /api/feishu/reply`.

### Card button callbacks

In cards sent by the backend, the button's `value` decides where a click is forwarded. feishu-sso first shows the clicker a toast within 3 seconds, then forwards asynchronously:

| Button `value` | Forwarded to | Request body |
| --- | --- | --- |
| `{"k": "doc_audit_ack", "h": "<hash>"}` (checker) | `/api/internal/doc-audit/acknowledge` | `{"hash", "operatorOpenId", "checked"}` |
| `{"k": "group_qa_up" \| "group_qa_down", "h": "<hash>"}` | `/api/internal/group-qa/feedback` | `{"hash", "helpful"}` |
| `{"kind": "expert_escalation", "escalationId", "option"}` | `/api/internal/expert-escalation/resolve` | `{"escalationId", "resolution", "operatorOpenId"}` |

The response of `doc-audit/acknowledge` may include `{"card": {...}}`; feishu-sso uses it to update the clicked card in place.

## The backend calls feishu-sso

These endpoints also authenticate with `x-internal-token`, and messages are sent as the bot. Cards may use schema 1.0 (`elements`) or 2.0 (`schema: "2.0"` + `body.elements`), at most 20000 characters when serialized.

| Endpoint | Request body | Description |
| --- | --- | --- |
| `POST /api/feishu/notify` | `{"openId": "ou_…", "card"}` or `{"chatId": "oc_…", "card"}` | Send a card to a person or a group; returns `{"messageId"}` |
| `POST /api/feishu/reply` | `{"messageId": "om_…", "card"}` | Reply to a received message, quoting it |
| `POST /api/feishu/reaction` | `{"messageId": "om_…", "emojiType": "THUMBSUP"}` | Add an emoji reaction; requires the scope `im:message.reactions:write_only` |
| `POST /api/feishu/upload-image` | Image bytes (octet-stream, ≤ 5 MB) | Upload to Feishu and return `{"imageKey"}`, usable in a card's `img` element |
