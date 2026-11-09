// Japanese messages of the landing page (index.html), keyed by its markers in page order.
import type { PageMessages } from "../../markers.ts";

export const landing: PageMessages = {
  "landing.meta.title": "Portifact：エージェントが作ったものを共有",
  "landing.meta.description":
    "HTML、Markdown、テキストを非公開リンクで公開し、開ける人を決めて、コーディングエージェントがそのまま対応できるフィードバックを集めましょう。オープンソースです。",
  "landing.meta.ogDescription":
    "HTML、Markdown、テキストを非公開リンクで公開し、開ける人を決めて、コーディングエージェントがそのまま対応できるフィードバックを集めましょう。",
  "landing.skipLink": "コンテンツへスキップ",
  "landing.header.homeLabel": "Portifactホーム",
  "landing.header.navLabel": "メイン",
  "landing.nav.product": "製品",
  "landing.nav.review": "レビュー",
  "landing.nav.access": "アクセス",
  "landing.nav.security": "セキュリティ",
  "landing.nav.faq": "FAQ",
  "landing.header.star": "GitHubでスター",
  "landing.header.signIn": "サインイン",
  "landing.header.install": "インストール",
  "landing.hero.badge": "早期リリース",
  "landing.hero.statusShort": "現在できること",
  "landing.hero.statusLong": "公開、共有、レビューが利用可能",
  "landing.hero.spoken": "エージェントが作ったものを共有。エージェントが対応できるフィードバックを",
  "landing.hero.titleLead": "エージェントが作ったものを共有",
  "landing.hero.phrase1":
    'エージェントが対応できるフィードバックを<span class="typing-caret"></span>',
  "landing.hero.phrase2": 'デフォルトで非公開に<span class="typing-caret"></span>',
  "landing.hero.phrase3": '1行ずつレビュー<span class="typing-caret"></span>',
  "landing.hero.phrase4": 'いつでも復元<span class="typing-caret"></span>',
  "landing.hero.typed": "エージェントが対応できるフィードバックを",
  "landing.hero.lead":
    "コーディングエージェントが作った計画、レポート、プロトタイプを非公開リンクで公開し、開ける人を正確に選び、特定の文や要素に紐づいたコメントを集めましょう。エージェントがスレッドを読んで修正します。",
  "landing.hero.signIn": "サインイン",
  "landing.hero.readCode": "GitHubでコードを読む",
  "landing.hero.terminalLabel":
    "ターミナルで、report.htmlに対してBilling migrationという名前でportifact publishを実行しています。CLIはファイルを一覧表示してアップロードし、新しいバージョンを現在のバージョンにして、portifact.dev上の非公開URLと有効期限を表示します。",
  "landing.hero.screenshotAlt":
    "Billing migrationレポートを表示しているPortifactのビューアー。上部のPortifactバーには、artifactの名前、バージョン1、スレッド1件のCommentsボタンがあります。レポートでは「Writes switch over only after seven days without errors」という文がハイライトされ、コメントのサイドバーには、その文についてのAna Lopezの質問とオーナーの返信が表示されています。",
  "landing.hero.caption":
    "ターミナルから公開し、ブラウザでレビュー。AGPL-3.0のオープンソースです。",
  "landing.agents.title": "いつものエージェントで使えます",
  "landing.agents.note":
    'CLIとエージェントスキルはすべてのエージェントで動作します。リモートMCPサーバーはOAuthサインインに対応したクライアントで動作し、Claude.ai、Claude Code、Codex CLIでテスト済みです。<a href="/mcp-compatibility" class="text-text hover:no-underline">MCPの互換性を見る</a>',
  "landing.interfaces.eyebrow": "3つの使い方",
  "landing.interfaces.title": "どこで作業しても同じルール",
  "landing.interfaces.lead":
    "CLI、リモートMCPサーバー、Webダッシュボードは同じドメイン層の上に成り立っています。どこから始めても、操作には同じ権限チェック、上限、状態、エラーが適用されるため、エージェントとチームには常に同じものが見えます。",
  "landing.interfaces.tabsLabel": "Portifactの使い方",
  "landing.interfaces.tabMcp": 'MCP<span class="hidden sm:inline">（エージェント向け）</span>',
  "landing.interfaces.tabDashboard": "ダッシュボード",
  "landing.common.available": "利用可能",
  "landing.interfaces.cli.title": "あなたとスクリプトのために",
  "landing.interfaces.cli.body":
    'macOS、Linux、Windows向けの単一の自己完結型バイナリです。ファイル、フォルダー、ZIPを公開して共有し、フィードバックを取り込めます。シェルからでも、ターミナルを使える任意のエージェントからでも使えます。サインインするには<code class="font-mono text-text">portifact login</code>を実行してください。',
  "landing.interfaces.cli.json":
    '安定した<code class="font-mono">--json</code>出力と非対話型のフラグ',
  "landing.interfaces.cli.preview":
    'アップロード前にファイル一覧を表示し、機密情報、<code class="font-mono">.git</code>、<code class="font-mono">node_modules</code>を除外',
  "landing.interfaces.cli.signIn":
    "デバイスコードでサインインし、認証情報はシステムのキーチェーンに保存",
  "landing.interfaces.cli.versions":
    "バージョン管理、ロールバック、あなただけが取り出せる非公開のソース",
  "landing.interfaces.cli.terminalLabel":
    "CLIの出力を表示したターミナルセッション。portifact publishがprototypeフォルダーの3つのファイルを一覧表示してアップロードし、非公開URLと有効期限を表示します。portifact access addで2つのメールアドレスと共有し、portifact annotations exportですべてのレビュースレッドをMarkdownとしてfeedback.mdに保存します。",
  "landing.interfaces.mcp.title": "エージェントから直接",
  "landing.interfaces.mcp.body":
    '<code class="font-mono text-text">https://app.portifact.com/mcp</code>で動作するリモートMCPサーバーです。クライアントに追加し、ブラウザでPortifactアカウントにサインインしてください。エージェントはツールとして、ドキュメントの公開、バージョンの管理、フィードバックの読み取りを行います。お使いのマシンに追加でインストールするものはありません。',
  "landing.interfaces.mcp.tested":
    'Claude.ai、Claude Code、Codex CLIでテスト済み。<a href="/mcp-compatibility" class="text-text hover:no-underline">MCPの互換性を見る</a>',
  "landing.interfaces.mcp.inline":
    "小さなドキュメントはインラインで送信。フォルダー、サイト、アクセスの変更はCLIまたはダッシュボードで",
  "landing.interfaces.mcp.noPrivilegedPath":
    "特権的な経路はなし。CLIと同じ権限チェックと上限を適用",
  "landing.interfaces.mcp.untrusted":
    "レビュアーのコメントは、指示ではなくデータとしてエージェントに届く",
  "landing.interfaces.mcp.sessionTitle": "エージェントセッション",
  "landing.interfaces.mcp.sessionLabel":
    "エージェントセッション。API設計計画の公開を頼まれたエージェントは、Portifactのpublish_documentツールを呼び出します。ツールはartifactのID、バージョン1、非公開URL、有効期限を返し、エージェントはリンクを返答します。フィードバックを読むよう頼まれると、list_annotationsを呼び出して未解決のスレッドを受け取り、2件のレビュアーのコメントを要約します。",
  "landing.interfaces.dashboard.title": "チームの全員のために",
  "landing.interfaces.dashboard.body":
    '<code class="font-mono text-text">app.portifact.com</code>のWebダッシュボードで、ターミナルなしで公開、共有、レビュー、復元ができます。<a href="https://app.portifact.com/" class="text-text hover:no-underline">ダッシュボードにサインイン</a>',
  "landing.interfaces.dashboard.publish":
    "ブラウザからファイル、フォルダー、ZIPを公開したり、Markdownやテキストをその場で編集したり",
  "landing.interfaces.dashboard.manage":
    "アクセスの変更、レビュービューアーでのコメント、バージョンのロールバック、アーカイブ済みartifactの復元",
  "landing.interfaces.dashboard.sessions":
    "ブラウザのセッションを確認し、CLIやMCPクライアントを含むアプリの連携を解除",
  "landing.interfaces.dashboard.screenshotAlt":
    "Portifactダッシュボードのartifact一覧。検索ボックスと、状態、種類、アクセス、コメントのフィルターがあります。4つのartifactが並んでいます。サインインしたユーザーに公開されたMarkdownのAPI design plan、共有した人だけに制限されたサイトのCheckout prototypeとBilling migration、一般公開されたテキストのRelease notesです。各行には、状態、有効期限、サイズ、未解決のコメントスレッドなどの最近のアクティビティが表示されています。",
  "landing.how.eyebrow": "しくみ",
  "landing.how.title": "エージェントの成果からフィードバックまで、ひとつのループで",
  "landing.how.lead":
    "ZIPファイルも、スクリーンショットも、貼り付けた長文もいりません。成果物は作られた場所にとどまり、コメントはそれを作ったエージェントに戻ります。",
  "landing.how.write.title": "エージェントが書く",
  "landing.how.write.body":
    "計画、進捗レポート、プロトタイプが、HTML、Markdown、テキストとしてディスクに保存されます。",
  "landing.how.publish.title": "公開する",
  "landing.how.publish.body":
    "コマンド1つ、またはツール呼び出し1回で、専用のオリジン上の非公開URLが返されます。",
  "landing.how.share.title": "共有する",
  "landing.how.share.body": "見るべき人にだけ公開し、それ以外の人には見せません。",
  "landing.how.collect.title": "コメントを集める",
  "landing.how.collect.body": "レビュアーは文や要素を選択して、そこにスレッドを始めます。",
  "landing.how.collect.label": "レビューモード",
  "landing.how.revise.title": "エージェントが修正する",
  "landing.how.revise.body": "スレッドをエクスポートし、変更を適用して、同じURLで再び公開します。",
  "landing.how.note":
    "各ステップはCLIのコマンドで示していますが、どれもダッシュボードでも行えます。MCPでは、エージェントがドキュメントを公開してスレッドを読みます。アクセスの変更はCLIとダッシュボードで行います。",
  "landing.access.eyebrow": "アクセス制御",
  "landing.access.title": "あなたが決めるまでは非公開",
  "landing.access.lead":
    "新しいartifactは、最初はあなただけに表示されます。公開範囲は1段階ずつ広げられ、いつでも狭めることができます。",
  "landing.access.private.name": "非公開",
  "landing.access.private.description": "あなただけ。新しいartifactの既定値です。",
  "landing.access.emailList.name": "メールリスト",
  "landing.access.emailList.description": "指定した人。各自がアドレスを確認した後に開けます。",
  "landing.access.signedIn.name": "サインイン済み",
  "landing.access.signedIn.description": "Portifactアカウントを持つすべての人。",
  "landing.access.public.name": "一般公開",
  "landing.access.public.description":
    "リンクを知っているすべての人。許可しない限り、検索エンジンには掲載されません。新しいアカウントは、登録から15分後に選択できます。",
  "landing.access.note":
    "新しいバージョンを公開しても、現在のアクセス設定は変わりません。更新によって公開範囲が広がることはありません。",
  "landing.access.diagramLabel":
    "入れ子になった4つのアクセスの円。いちばん内側は「非公開」で、あなただけです。その外側にメールリスト、次にサインインしたすべての人、いちばん外側が一般公開です。",
  "landing.access.public.hint": "リンクを知っている全員",
  "landing.access.signedIn.hint": "すべてのアカウント",
  "landing.access.emailList.hint": "指定した人",
  "landing.access.emailList.add": "+ 追加",
  "landing.access.private.hint": "既定 · あなただけ",
  "landing.review.eyebrow": "レビューと注釈",
  "landing.review.title": "フィードバックを対象そのものに固定",
  "landing.review.lead":
    "レビューモードをオンにすると、レビュアーはartifactに直接コメントできます。エージェントはすべてのスレッドをアンカーとともに受け取り、すぐに対応できます。",
  "landing.review.screenshotAlt":
    "Checkout prototypeを表示しているPortifactのビューアー。無料返品と配送日数に関する文に、2つのコメントのハイライトが重なっています。レビュアーが重なった部分をクリックしたため、コメントのサイドバーには両方のスレッドがまとめて表示されています。Marco Rossiは「3 to 5 business days」の代わりに到着日を表示するよう求めており、オーナーの返信が付いています。Ana Lopezは、その文をボタンの上に移動するよう求めています。",
  "landing.review.caption": "プロトタイプのサイト上で重なったコメント。",
  "landing.review.terminalLabel":
    "未解決スレッドに対するportifact annotations exportのMarkdown出力の冒頭。レビュアーのテキストは信頼できないデータであるという注記、artifact、スレッド数、そして引用した文とAna Lopezのコメントを含む最初のスレッドが表示されています。",
  "landing.review.sentence.title": "どの文にも",
  "landing.review.sentence.body":
    "HTML、Markdown、プレーンテキストのテキストを、マウスでもキーボードでも選択できます。",
  "landing.review.element.title": "どの要素にも",
  "landing.review.element.body":
    "サイトのボタン、グラフ、セクションを指し示して、コメントできます。",
  "landing.review.threads.title": "完全なスレッド",
  "landing.review.threads.body":
    "返信、未解決と解決済みのステータスが、書かれたバージョンに紐づいて残ります。",
  "landing.review.export.title": "エージェント向けエクスポート",
  "landing.review.export.body":
    "JSONまたはMarkdownで、従うべき指示ではなく、データとして読み込まれます。",
  "landing.lifecycle.eyebrow": "ライフサイクル",
  "landing.lifecycle.title": "必要な間はオンライン、その後も復元可能",
  "landing.lifecycle.lead":
    "エージェントはたくさんのものを作ります。Portifactは進行中の作業をオンラインに保ち、それ以外は失わずに片付けます。",
  "landing.lifecycle.timelineLabel":
    "タイムライン。artifactは30日間オンラインで、更新するたびにその30日間が再び始まります。その後6か月間アーカイブされ、その間は復元できます。それを過ぎると削除されます。",
  "landing.lifecycle.timeline.lastUpdate": "最終更新",
  "landing.lifecycle.timeline.restore": "アーカイブ中はいつでも復元可能",
  "landing.lifecycle.timeline.end": "7か月後",
  "landing.lifecycle.timeline.online": "オンライン",
  "landing.lifecycle.timeline.onlineDuration": "30日間",
  "landing.lifecycle.timeline.archived": "アーカイブ",
  "landing.lifecycle.timeline.archivedDuration": "· 6か月間",
  "landing.lifecycle.timeline.deleted": "削除",
  "landing.lifecycle.online.title": "30日間オンライン、更新で延長",
  "landing.lifecycle.online.body":
    "新しいバージョンを公開するたびに期間がリセットされるため、作業中のものがレビューの途中で消えることはありません。",
  "landing.lifecycle.archived.title": "6か月間アーカイブ",
  "landing.lifecycle.archived.body":
    "期限切れのartifactはオフラインになり、有効なartifactとして数えられなくなります。スレッドは保持されます。",
  "landing.lifecycle.restore.title": "ワンステップで復元",
  "landing.lifecycle.restore.body":
    "CLI、エージェント、ダッシュボードから、同じURLで元に戻せます。",
  "landing.security.eyebrow": "セキュリティ",
  "landing.security.title": "artifactごとに専用のサンドボックス",
  "landing.security.lead":
    "エージェントはJavaScriptを書きます。Portifactは公開されたどのページも悪意を持ちうると想定し、あなたのアカウントから遠ざけます。",
  "landing.security.origin.title": "artifactごとに別のオリジン",
  "landing.security.origin.body":
    'ユーザーのコンテンツは<code class="font-mono">portifact.dev</code>の専用のサブドメインに置かれます。あなたのセッション、トークン、APIは<code class="font-mono">portifact.com</code>にあります。',
  "landing.security.quiet.title": "デフォルトで目立たない",
  "landing.security.quiet.body":
    "許可しない限り、検索エンジンに掲載されず、ほかのサイトにも埋め込まれません。",
  "landing.security.installs.title": "検証済みのインストール、すでに利用可能",
  "landing.security.installs.body":
    'インストーラーはすべてのダウンロードをSHA-256チェックサムで検証します。リリースには署名付きのビルド来歴が付いており、<code class="font-mono whitespace-nowrap">gh attestation verify</code>で検証できます。',
  "landing.security.diagramLabel":
    "図。一方では、portifact.comがダッシュボード、API、MCPサーバー、セッション、トークンを保持しています。もう一方では、各artifactがportifact.devの専用のサブドメインで動作しています。両者の間の壁が、Cookie、認証情報、APIへのアクセスを遮断します。",
  "landing.security.diagram.trusted": "信頼済み",
  "landing.security.diagram.dashboard": "ダッシュボード",
  "landing.security.diagram.api": "APIとMCP",
  "landing.security.diagram.sessions": "セッションとトークン",
  "landing.security.diagram.viewer": "レビュービューアー",
  "landing.security.diagram.userContent": "ユーザーのコンテンツのみ",
  "landing.security.diagram.noCredentials": "認証情報なし",
  "landing.useCases.eyebrow": "ユースケース",
  "landing.useCases.title": "エージェントが作るもののために",
  "landing.useCases.plans.title": "実装計画",
  "landing.useCases.plans.body":
    "エージェントがコードを書く前に計画をレビューし、リスクのある手順を指摘できます。",
  "landing.useCases.reports.title": "進捗レポート",
  "landing.useCases.reports.body":
    "関係者にスクリーンショットではなくリンクを送り、実行のたびに最新の状態に保てます。",
  "landing.useCases.prototypes.title": "プロトタイプ",
  "landing.useCases.prototypes.body":
    "CSSとJavaScriptを含む動作するHTMLプロトタイプを公開し、実際にクリックして試してもらえます。",
  "landing.useCases.designs.title": "デザイン案",
  "landing.useCases.designs.body":
    "3つの案を並べてそれぞれの意見を集め、選ばれた案をエージェントに作らせましょう。",
  "landing.install.eyebrow": "インストール",
  "landing.install.title": "1分でセットアップ",
  "landing.install.lead":
    'CLIとエージェントスキルをインストールし、<code class="font-mono text-text">portifact login</code>でサインインしてください。MCPサーバーをエージェントに接続したり、ブラウザでダッシュボードを使ったりすることもできます。',
  "landing.install.agent.title": "エージェントにセットアップを任せる",
  "landing.install.agent.recommended": "おすすめ",
  "landing.install.agent.body":
    "これをClaude Code、Codex、Cursor、Gemini CLI、GitHub Copilot、またはターミナルを使える任意のコーディングエージェントに貼り付けてください。お使いのOS用のCLIをインストールし、エージェントにPortifactの使い方を教えます。",
  "landing.install.agent.promptTitle": "エージェント用のプロンプト",
  "landing.install.agent.copyPrompt": "プロンプトをコピー",
  "landing.install.agent.showPrompt": "貼り付ける前にプロンプトを読む",
  "landing.install.agent.hidePrompt": "プロンプトを隠す",
  "landing.install.agent.step1": "システムとアーキテクチャを検出",
  "landing.install.agent.step2": "CLIをインストールし、チェックサムを検証",
  "landing.install.agent.step3": '<code class="font-mono">portifact --version</code>で確認',
  "landing.install.agent.step4": "エージェントにPortifactスキルを追加",
  "landing.install.agent.note":
    "プロンプトは、チェックサムの検証に失敗した場合は中止し、管理者権限が必要な操作の前にはあなたに確認するよう、エージェントに指示しています。",
  "landing.install.manual.title": "または自分でインストール",
  "landing.install.manual.unix": "macOSとLinux",
  "landing.install.copy": "コピー",
  "landing.install.manual.skill": "エージェントに教える",
  "landing.install.manual.note":
    "Linux（glibcとAlpine）、macOS、Windows向けの、x64とarm64に対応した単一の実行ファイルです。Node、Bun、管理すべきランタイムは不要です。",
  "landing.install.mcp.title": "MCPサーバーを接続",
  "landing.install.mcp.body":
    "OAuthでリモートサーバーに対応した任意のMCPクライアントに、このサーバーアドレスを追加してください。クライアントがブラウザを開くので、Portifactアカウントでサインインし、許可する操作を選べます。",
  "landing.install.mcp.address": "サーバーアドレス",
  "landing.install.mcp.note":
    '最初のサインインでは、エージェントはartifactの閲覧しかできません。公開など、ツールにそれ以上の権限が必要になると、クライアントが改めて確認します。Claude.ai、Claude Code、Codex CLIのセットアップ手順は<a href="/mcp-compatibility" class="text-text hover:no-underline">MCPの互換性のページ</a>にあります。',
  "landing.install.dashboard.title": "またはダッシュボードを使う",
  "landing.install.dashboard.body":
    '<code class="font-mono text-text">app.portifact.com</code>に、Google、GitHub、またはメールで届くコードでサインインしてください。ターミナルなしで、公開、アクセスの変更、スレッドのレビュー、バージョンのロールバック、アーカイブ済みartifactの復元ができます。',
  "landing.common.signInToDashboard": "ダッシュボードにサインイン",
  "landing.status.title": "現在できること",
  "landing.status.installer": "macOS、Linux、Windows向けインストーラー",
  "landing.status.signedReleases": "チェックサム付きの署名済みリリース",
  "landing.status.skill": "エージェントスキル",
  "landing.status.publish": "HTMLサイト、Markdown、テキストの公開",
  "landing.status.versions": "バージョン管理、ロールバック、非公開のソース",
  "landing.status.access": "アクセス制御",
  "landing.status.archive": "アーカイブと復元",
  "landing.status.annotations": "注釈とレビュー",
  "landing.status.mcp":
    '<a href="/mcp-compatibility" class="text-text hover:no-underline">MCPサーバー</a>',
  "landing.status.dashboard": "Webダッシュボード",
  "landing.status.accessLogs": "artifactのアクセスログ",
  "landing.free.eyebrow": "無料プラン",
  "landing.free.title": "本格的な作業にも十分な余裕",
  "landing.free.lead":
    "現在すべてのアカウントに適用される上限です。Portifactの成長に合わせて調整される場合があります。",
  "landing.free.activeArtifacts": "有効なartifact",
  "landing.free.perArtifact": "artifactあたり",
  "landing.free.perAccount": "アカウントあたり",
  "landing.free.publishesPerDay": "1日あたりの公開数",
  "landing.openSource.eyebrow": "オープンソース",
  "landing.openSource.title": "オープンに開発",
  "landing.openSource.lead":
    "PortifactはGNU AGPL v3.0でライセンスされています。GitHubでコードを読み、進捗を追い、問題を報告してください。",
  "landing.openSource.provenance": "ビルド来歴とSHA-256チェックサム付きの署名済みリリース",
  "landing.openSource.tests": "すべての変更にカバレッジ基準付きのテスト",
  "landing.openSource.platform": "Cloudflare Workers、D1、R2で動作",
  "landing.openSource.viewOnGitHub": "GitHubで見る",
  "landing.openSource.releases": "リリース",
  "landing.openSource.securityPolicy": "セキュリティポリシー",
  "landing.faq.eyebrow": "FAQ",
  "landing.faq.title": "よくある質問",
  "landing.faq.missing":
    'ほかに知りたいことがありますか？<a href="https://github.com/leynier/portifact/issues" class="text-text">GitHubでissueを作成してください</a>。',
  "landing.faq.today.question": "Portifactは今すぐ使えますか？",
  "landing.faq.today.answer":
    'はい。公開、アクセス制御、バージョン、アーカイブと復元、レビュービューアーでの注釈、MCPサーバー、ダッシュボードは、すべて現在利用できます。<code class="font-mono">portifact login</code>でサインインするか、MCPサーバーを接続するか、<a href="https://app.portifact.com/" class="text-text">app.portifact.com</a>でサインインしてください。Portifactはまだ初期段階のため、粗削りな部分や変更される可能性のある上限があります。',
  "landing.faq.agents.question": "どのエージェントで使えますか？",
  "landing.faq.agents.answer":
    'ターミナルを使えるコーディングエージェントなら、どれでもCLIを実行できます。スキルはClaude Code、Codex、Cursor、Gemini CLI、GitHub Copilot、OpenCodeなどのエージェントにインストールできます。リモートMCPサーバーはOAuthサインインに対応したクライアントで動作し、Claude.ai、Claude Code、Codex CLIでテスト済みです。詳しくは<a href="/mcp-compatibility" class="text-text">MCPの互換性</a>をご覧ください。',
  "landing.faq.publish.question": "何を公開できますか？",
  "landing.faq.publish.answer":
    "静的なコンテンツです。CSSとJavaScriptを含むHTMLサイト、きれいにレンダリングされるMarkdown、書かれたとおりに表示されるプレーンテキストを公開できます。単一のファイル、フォルダー、ZIPに対応し、一緒に保管したい場合は、あなただけがダウンロードできる非公開のソースも追加できます。Portifactはビルドやサーバーを実行しません。",
  "landing.faq.audience.question": "公開したものは誰が見られますか？",
  "landing.faq.audience.answer":
    "変更するまでは、あなただけです。artifactは、メールアドレスのリスト、サインインしたすべての人、または一般に公開でき、いつでも範囲を狭められます。新しいバージョンを公開しても、公開範囲が広がることはありません。",
  "landing.faq.expiry.question": "30日後はどうなりますか？",
  "landing.faq.expiry.answer":
    "更新していない場合、artifactはアーカイブされます。オフラインになりますが6か月間保持され、必要なときにいつでも復元できます。アーカイブから6か月が経過すると削除されます。更新するたびに30日間が延長されます。",
  "landing.faq.comments.question": "エージェントはレビュアーのコメントに安全に対応できますか？",
  "landing.faq.comments.answer":
    "エージェントはすべてのスレッドを読み、JSONまたはMarkdownでエクスポートできます。Portifactスキルは、コメントを信頼できないデータとして扱うようエージェントに教えます。エージェントはコメントを要約してあなたに伝え、コメント内に書かれた指示には決して従いません。",
  "landing.faq.sharedWithMe.question": "共有されたartifactを開いても安全ですか？",
  "landing.faq.sharedWithMe.answer":
    "各artifactはportifact.devの専用のサブドメインで動作し、そこにはアカウントの認証情報が一切ありません。あなたのセッションとAPIはportifact.comにあるため、公開されたページがあなたのアカウントを操作することはできません。",
  "landing.cta.title": "エージェントの成果に居場所を",
  "landing.cta.lead":
    "CLIとスキルをインストールするか、MCPサーバーを接続するか、ダッシュボードにサインインしてください。",
  "landing.cta.install": "Portifactをインストール",
  "landing.footer.tagline": "エージェントが作ったものを共有。GNU AGPL v3.0のオープンソースです。",
  "landing.footer.theme": "テーマ",
  "landing.footer.theme.system": "システム",
  "landing.footer.theme.light": "ライト",
  "landing.footer.theme.dark": "ダーク",
  "landing.footer.product": "製品",
  "landing.footer.interfaces": "3つの使い方",
  "landing.footer.install": "インストール",
  "landing.footer.faq": "FAQ",
  "landing.footer.project": "プロジェクト",
  "landing.footer.releases": "リリース",
  "landing.footer.security": "セキュリティ",
  "landing.footer.license": "ライセンス",
  "landing.footer.notices": "サードパーティの通知",
  "landing.footer.legal": "法的情報",
  "landing.footer.terms": "利用規約",
  "landing.footer.privacy": "プライバシーポリシー",
  "landing.footer.acceptableUse": "利用ポリシー",
  "landing.footer.report": "artifactを報告",
};
