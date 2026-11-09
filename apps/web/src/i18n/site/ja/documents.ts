// Japanese messages of the MCP compatibility page and the chrome of the legal pages, keyed by
// their markers. The legal texts themselves stay in English.
import type { PageMessages } from "../../markers.ts";

export const documents: PageMessages = {
  // Chrome of the legal pages (terms, privacy, acceptable-use), shared across the three.
  "legal.skip": "コンテンツへスキップ",
  "legal.home": "Portifactホーム",
  "legal.footer.license": "PortifactはGNU AGPL v3.0のもとで公開されているオープンソースです。",
  "legal.footer.nav": "法的情報",
  "legal.footer.terms": "利用規約",
  "legal.footer.privacy": "プライバシー",
  "legal.footer.acceptableUse": "利用ポリシー",
  "legal.terms.title": "利用規約：Portifact",
  "legal.terms.description":
    "アクセス制御とレビュー機能を備えた静的artifactの公開サービス、Portifactの利用規約です。",
  "legal.privacy.title": "プライバシーポリシー：Portifact",
  "legal.privacy.description":
    "Portifactが保存するデータ、その理由と保存期間、処理者、権利の行使方法について説明します。",
  "legal.acceptableUse.title": "利用ポリシー：Portifact",
  "legal.acceptableUse.description":
    "Portifactで公開や実行が禁止されていること、不正利用の報告方法、ルール違反があった場合の対応について説明します。",

  // MCP compatibility page.
  "mcp.meta.title": "MCPの互換性：Portifact",
  "mcp.meta.description":
    "PortifactのリモートMCPサーバーで動作するMCPクライアント、各クライアントのサインイン方法と動作について説明します。",
  "mcp.chrome.skip": "コンテンツへスキップ",
  "mcp.chrome.home": "Portifactホーム",
  "mcp.intro.title": "MCPの互換性",
  "mcp.intro.tested":
    '最終テスト：<time datetime="2026-11-08">2026年11月8日</time>、Portifact 0.11.0で実施。Codex CLIのトークン更新とコメントツールは、同日にPortifact 0.13.0で再確認しました。',
  "mcp.intro.server":
    "Portifactは<code>https://app.portifact.com/mcp</code>でリモートMCPサーバー（Streamable HTTP）を提供しています。クライアントに追加し、ブラウザでPortifactアカウントにサインインしてください。最初のサインインで求められるのはartifactの閲覧権限だけです。公開や削除など、ツールにそれ以上の権限が必要になると、クライアントが改めて確認します。",
  "mcp.toc.title": "このページの内容",
  "mcp.matrix.title": "テスト済みのクライアント",
  "mcp.matrix.intro":
    "各クライアントで、ドキュメントの一覧表示、公開、読み戻し、削除を行いました。3つとも、OAuthとPKCEでサインインし、公開されたクライアントメタデータドキュメントで自身を識別します。",
  "mcp.matrix.caption": "Portifactでテスト済みのMCPクライアント",
  "mcp.matrix.client": "クライアント",
  "mcp.matrix.version": "バージョン",
  "mcp.matrix.protocol": "プロトコル",
  "mcp.matrix.moreAccess": "ツールに追加の権限が必要な場合",
  "mcp.matrix.status": "状態",
  "mcp.matrix.claudeAiVersion": "Web、2026年11月",
  "mcp.matrix.notRecorded": "記録なし",
  "mcp.matrix.claudeAiMoreAccess": "ブラウザで許可を求める",
  "mcp.matrix.claudeCodeMoreAccess": "<code>/mcp</code>を実行して再度サインインするよう案内する",
  "mcp.matrix.codexMoreAccess": "呼び出しが失敗する。必要なスコープで再度サインインする",
  "mcp.matrix.works": "動作",
  "mcp.claudeAi.body":
    "サーバーのアドレスでカスタムコネクタを追加し、サインインしてください。Claudeが初めて公開するときに、公開の許可も求められます。コネクタには24個のツールが表示されます。9個は読み取りのみ、15個は書き込みまたは削除を行います。",
  "mcp.claudeCode.body":
    "<code>claude mcp add --transport http portifact https://app.portifact.com/mcp</code>でサーバーを追加し、<code>/mcp</code>で選択してサインインしてください。まだ許可していない権限がツールに必要な場合、呼び出しは不足している権限を示すメッセージとともに失敗します。<code>/mcp</code>を実行し、Re-authenticateを選んで許可してください。Claude Codeは以前に許可した内容を保持します。非対話型の実行（<code>claude -p</code>）ではサインインできないため、先に対話型セッションでサインインしてください。",
  "mcp.codex.body":
    "<code>codex mcp add portifact --url https://app.portifact.com/mcp</code>でサーバーを追加すると、Codexはすぐにサインインを開始します。Codexは自分から追加の権限を求めないため、エージェントに必要なすべての権限でサインインしてください。例：",
  "mcp.codex.comments":
    "コメントツールを使うには、<code>annotations:read</code>、<code>annotations:write</code>、または<code>annotations:moderate</code>を追加してください。3つすべてを付与した状態で、Codexはドキュメントのコメントをオンにし、コメント、返信、解決、エクスポートを行いました。Codexは削除を行うツールを実行する前に承認を求めます。有効期間1時間のトークンが期限切れになると、自動でアクセスを更新します。",
  "mcp.other.title": "その他のクライアント",
  "mcp.other.body":
    'OAuthに対応したリモートMCPサーバーをサポートするクライアントであれば動作するはずです。Portifactは2026-07-28版のMCP認可仕様に準拠しており、動的クライアント登録と2025年のプロトコル改訂版にも対応しています。お使いのクライアントで動作しない場合でも、<code>portifact</code> CLIとエージェントスキルはシェルを使えるすべてのエージェントで動作します。<a href="https://github.com/leynier/portifact/issues">GitHub</a>でお知らせください。',
  "mcp.footer.license": "PortifactはGNU AGPL v3.0のもとで公開されているオープンソースです。",
  "mcp.footer.nav": "法的情報",
  "mcp.footer.terms": "利用規約",
  "mcp.footer.privacy": "プライバシー",
  "mcp.footer.acceptableUse": "利用ポリシー",
};
