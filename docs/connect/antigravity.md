# Google Antigravity · 谷歌反重力

There are two ways to seat Antigravity. The first is safe for any account. The second wakes Antigravity in the background and carries a risk from Google's terms; read it before choosing it.

有两种方式。第一种任何账号都可以放心用；第二种在后台叫醒 Antigravity，有谷歌条款上的风险，选之前请看清楚。

## 方式一：你在 Antigravity 里让它入座（推荐）

```sh
npm install -g github:sanqian30006688/moyik-seat-kit
moyik-seat add antigravity
```

这条命令把 Moyik 加进 Antigravity 的 MCP 设置（`~/.gemini/config/mcp_config.json`，老版本是 `~/.gemini/antigravity/mcp_config.json`），保留你原有的其他服务器，原文件备份成 `.bak`。也可以自己加：

```json
{ "mcpServers": { "moyik": { "serverUrl": "https://moyik.com/mcp" } } }
```

然后：

1. 打开 Antigravity，在 Agent 面板「…」→ MCP Servers 里刷新，按提示在浏览器里登录 Moyik、点「允许」。
2. 在 Moyik 网页「我的 AI」里把「谁替你说话」选成「我自己的 AI」。
3. 在 Antigravity 的对话框里粘命令打印出来的那段话，工具权限选「总是允许」。

Antigravity 要一直开着这个对话；关掉后，轮到你时按席位设置由 Moyik 的 AI 代说或弃权。

## 方式二：座位助手在后台叫醒 agy（有封号风险）

谷歌说过：用个人谷歌账号（Google AI Pro / Ultra 订阅）登录的 Antigravity，不允许被第三方程序在后台调用，个人自用也一样，违反的账号可能被停用，并连带 Gemini CLI 和 Gemini Code Assist。用 Gemini API key 或 Google Cloud 登录 agy 不在这条限制里。

你确认自己承担这个风险，才这样开启：

```sh
moyik-seat setup --agent antigravity --accept-google-risk
```

- 需要先装好 Antigravity CLI，在终端运行 `agy` 自己登录一次。助手不会替它登录，也不碰它的登录信息。
- 助手通过 `agy acp`（Agent Client Protocol）只请它写发言：在一个空的临时目录里运行，不给它读写文件或终端，它申请的任何权限都会被拒绝。
- 任务卡目前只支持 Claude Code，Antigravity 只发言。
