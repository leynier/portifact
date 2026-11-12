// Simplified Chinese messages of the MCP compatibility page and the chrome of the legal pages,
// keyed by their markers. The legal texts themselves stay in English.
import type { PageMessages } from "../../markers.ts";

export const documents: PageMessages = {
  // Chrome of the legal pages (terms, privacy, acceptable-use), shared across the three.
  "legal.skip": "跳到内容",
  "legal.home": "Portifact 首页",
  "legal.footer.license": "Portifact 基于 GNU AGPL v3.0 开源。",
  "legal.footer.nav": "法律信息",
  "legal.footer.terms": "条款",
  "legal.footer.privacy": "隐私",
  "legal.footer.acceptableUse": "可接受使用",
  "legal.footer.dpa": "数据处理",
  "legal.terms.title": "服务条款：Portifact",
  "legal.terms.description":
    "使用 Portifact 的条款。Portifact 是一项发布静态 artifact 并提供访问控制和审阅功能的服务。",
  "legal.privacy.title": "隐私政策：Portifact",
  "legal.privacy.description":
    "Portifact 保存哪些数据、为什么保存、保存多久、由谁处理，以及如何行使你的权利。",
  "legal.acceptableUse.title": "可接受使用政策：Portifact",
  "legal.acceptableUse.description":
    "哪些内容不能在 Portifact 上发布、哪些行为不被允许、如何举报滥用，以及违反规则会有什么后果。",
  "legal.dpa.title": "数据处理附录：Portifact",
  "legal.dpa.description":
    "Portifact 代表客户处理个人数据的条件，包括标准合同条款和次级处理者名单。",

  // MCP compatibility page.
  "mcp.meta.title": "MCP 兼容性：Portifact",
  "mcp.meta.description":
    "哪些 MCP 客户端可以使用 Portifact 远程 MCP 服务器、它们如何登录，以及每个客户端的预期表现。",
  "mcp.chrome.skip": "跳到内容",
  "mcp.chrome.home": "Portifact 首页",
  "mcp.intro.title": "MCP 兼容性",
  "mcp.intro.tested":
    '最近测试于 <time datetime="2026-11-08">2026 年 11 月 8 日</time>，测试版本为 Portifact 0.11.0。同日又针对 Portifact 0.13.0 重新检查了 Codex CLI 的令牌刷新和评论工具。',
  "mcp.intro.server":
    "Portifact 在 <code>https://app.portifact.com/mcp</code> 提供远程 MCP 服务器（Streamable HTTP）。将它添加到你的客户端，然后在浏览器中使用你的 Portifact 账号登录。首次登录只请求查看你的 artifact；当某个工具需要更多权限（例如发布或删除）时，客户端会再次请求。",
  "mcp.toc.title": "本页内容",
  "mcp.matrix.title": "已测试的客户端",
  "mcp.matrix.intro":
    "每个客户端都完成了列出、发布、读回和删除文档的操作。这三个客户端都通过 OAuth 和 PKCE 登录，并使用已发布的客户端元数据文档标识自己。",
  "mcp.matrix.caption": "已与 Portifact 一起测试的 MCP 客户端",
  "mcp.matrix.client": "客户端",
  "mcp.matrix.version": "版本",
  "mcp.matrix.protocol": "协议",
  "mcp.matrix.moreAccess": "当工具需要更多权限时",
  "mcp.matrix.status": "状态",
  "mcp.matrix.claudeAiVersion": "网页版，2026 年 11 月",
  "mcp.matrix.notRecorded": "未记录",
  "mcp.matrix.claudeAiMoreAccess": "在浏览器中请你允许",
  "mcp.matrix.claudeCodeMoreAccess": "提示你运行 <code>/mcp</code> 并重新登录",
  "mcp.matrix.codexMoreAccess": "调用失败；请使用所需的权限范围重新登录",
  "mcp.matrix.works": "可用",
  "mcp.claudeAi.body":
    "使用服务器地址添加自定义连接器并登录。Claude 第一次发布时，会请你同时允许发布权限。该连接器显示 24 个工具：9 个只读，15 个可写入或删除。",
  "mcp.claudeCode.body":
    "使用 <code>claude mcp add --transport http portifact https://app.portifact.com/mcp</code> 添加服务器，然后在 <code>/mcp</code> 中选择它并登录。当某个工具需要你尚未授予的权限时，调用会失败，并显示缺少的权限名称。运行 <code>/mcp</code>，选择 Re-authenticate 并允许；Claude Code 会保留你之前允许的权限。非交互式运行（<code>claude -p</code>）无法登录，因此请先在交互式会话中登录。",
  "mcp.codex.body":
    "使用 <code>codex mcp add portifact --url https://app.portifact.com/mcp</code> 添加服务器；Codex 会立即开始登录。Codex 不会自行请求更多权限，因此请在登录时包含你的智能体所需的全部权限，例如：",
  "mcp.codex.comments":
    "评论工具需要添加 <code>annotations:read</code>、<code>annotations:write</code> 或 <code>annotations:moderate</code>；三者都添加后，Codex 成功开启了评论，并对一个文档完成了评论、回复、解决和导出评论。Codex 在运行删除类工具前会请你批准。一小时有效的令牌过期时，它会自行续期访问权限。",
  "mcp.other.title": "其他客户端",
  "mcp.other.body":
    '任何支持带 OAuth 的远程 MCP 服务器的客户端都应该可以使用：Portifact 遵循 2026-07-28 版 MCP 授权规范，同时也接受动态客户端注册和 2025 年的协议修订版。如果你的客户端无法使用，<code>portifact</code> CLI 和智能体 skill 可以在任何带 shell 的智能体中使用。欢迎在 <a href="https://github.com/leynier/portifact/issues">GitHub</a> 上告诉我们。',
  "mcp.footer.license": "Portifact 基于 GNU AGPL v3.0 开源。",
  "mcp.footer.nav": "法律信息",
  "mcp.footer.terms": "条款",
  "mcp.footer.privacy": "隐私",
  "mcp.footer.acceptableUse": "可接受使用",
  "mcp.footer.dpa": "数据处理",
};
