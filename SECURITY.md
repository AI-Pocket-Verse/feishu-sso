# Security Policy

English | [简体中文](#安全策略)

## Reporting a vulnerability

Please do not disclose security issues in public issues, discussions or pull requests.

Submit a private report under **Security → Report a vulnerability** in this repository (GitHub private vulnerability reporting). Only the maintainers can see it. Please include, where possible:

- The affected version or commit
- How it is deployed (source + nginx, or Docker; Feishu or Lark; whether the bot is enabled)
- Steps to reproduce and the impact

We will acknowledge the report as soon as possible and will not disclose details before a fix is released.

## Supported versions

Only the latest version on the `main` branch is maintained.

## Before deploying

- Generate fresh strong random values for `AUTH_DATA_KEY` and `INTERNAL_API_TOKEN`; never reuse the examples or the development placeholder.
- Do not commit real configuration such as `api/.env.dev` or `api/.env.prod`.
- Keep the internal APIs (`notify` / `reply` / `reaction` / `upload-image`) off the public internet: use the provided nginx snippet or single-port mode, and have business services call `127.0.0.1` directly.
- If the bot is enabled, configure the Encrypt Key or Verification Token for events in production.

---

# 安全策略

## 报告漏洞

请不要在公开 issue、讨论区或 PR 里披露安全问题。

在本仓库的 **Security → Report a vulnerability** 提交私密报告（GitHub Private vulnerability reporting），只有维护者能看到。报告里请尽量包含：

- 受影响的版本或提交
- 部署方式（源码 + nginx / Docker、飞书 / Lark、是否启用机器人）
- 复现步骤和影响

收到后会尽快确认，修复发布前不会公开细节。

## 支持范围

只维护 `main` 分支的最新版本。

## 部署前请注意

- `AUTH_DATA_KEY` 和 `INTERNAL_API_TOKEN` 都要重新生成强随机值，不要沿用示例或开发占位值。
- 不要提交 `api/.env.dev`、`api/.env.prod` 等真实配置。
- 内部接口（`notify` / `reply` / `reaction` / `upload-image`）不要暴露到公网：使用仓库提供的 nginx 片段或单端口模式，业务服务直连 `127.0.0.1`。
- 启用机器人时，生产环境务必配置事件的 Encrypt Key 或 Verification Token。
