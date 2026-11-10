// Japanese catalog of the auth and report pages: the scripts' messages and the pages' markers.
// Polite です・ます. The sign-in notices keep every condition of the English
// (docs/legal.md, "Acceptance at sign-in") and the same three links.
import type { AuthMessages } from "./en.ts";
import type { AuthCatalog } from "./types.ts";

const messages = {
  network: "Portifactに接続できませんでした。接続を確認して、もう一度お試しください。",
  unexpected: "問題が発生しました。もう一度お試しください。",
  rateLimited: "試行回数が多すぎます。1分待ってから、もう一度お試しください。",
  emailRequired: "メールアドレスを入力してください。",
  emailInvalid: "name@example.comのような有効なメールアドレスを入力してください。",
  codeRequired: "メールに記載された6桁のコードを入力してください。",
  codeInvalid:
    "このコードは無効か、有効期限が切れています。確認するか、新しいコードを送信してください。",
  codeSent: (email: string) => `${email}に6桁のコードを送信しました。`,
  codeSentStatus: "コードを送信しました。メールに記載された6桁のコードを入力してください。",
  codeResent: "新しいコードを送信しました。",
  resendCode: "新しいコードを送信",
  resendIn: (seconds: number) => `${seconds}秒後に新しいコードを送信できます`,
  humanCheckNeeded:
    "あと1ステップです。Cloudflareが、人間であることを簡単に確認する必要があります。続行するには、サインイン方法の下に表示される確認を完了してください。",
  emailSuppressed:
    "以前このアドレスに送信したメールが届かなかったか、スパムとして報告されたため、このアドレスにはメールを送信できません。GoogleまたはGitHubでサインインするか、確認を依頼する場合はprivacy@portifact.comまでご連絡ください。",
  emailCapacity:
    "Portifactが月間のメール送信上限に達したため、メールのコードは現在一時停止しています。GoogleまたはGitHubでサインインするか、しばらくしてからもう一度お試しください。",
  signedInAs: (email: string) => `${email}としてサインイン中`,
  signedOut: "サインアウトしました。",
  methodConnected: "連携済み",
  methodNotUsed: "未使用",
  redirecting: "サインインしています。",
  termsUpdateFor: (email: string) => `${email}としてサインイン中`,
  providerErrors: {
    human_verification_required:
      "新しいアカウントには人間であることの簡単な確認が必要ですが、完了しませんでした。もう一度お試しください。サインイン方法の下に確認が表示された場合は、それを完了してください。何も表示されない場合は、ページを再読み込みするか、challenges.cloudflare.comを許可してください。",
    terms_not_accepted:
      "規約への同意がPortifactに届かなかったか、30分が経過して期限切れになりました。続行するには、もう一度サインイン方法を選んでください。",
    account_not_linked:
      "プロバイダーがこのメールアドレスを確認していないため、このアドレスを使用しているPortifactアカウントを開けません。プロバイダー側で確認するか、メールのコードでサインインしてください。",
    email_not_verified:
      "プロバイダーがこのメールアドレスを確認していません。プロバイダー側で確認するか、メールのコードでサインインしてください。",
    email_not_found:
      "プロバイダーからメールアドレスが共有されませんでした。メールのコードでサインインしてください。",
    state_mismatch:
      "サインインに時間がかかりすぎたか、別のタブで開始されました。もう一度お試しください。",
    artifact_unavailable:
      "このartifactは存在しないか、利用できなくなったか、このアカウントでは開けません。別のアカウントを使用するには、サインアウトしてからリンクをもう一度開いてください。",
    read_rate_limited:
      "このアカウントは短時間に多くのartifactを開きすぎました。数分待ってから、リンクをもう一度開いてください。",
  },
  providerErrorFallback: "サインインが完了しませんでした。もう一度お試しください。",
  /** The read entry's confirmation before a code goes to an artifact's custom host. */
  readConfirm: {
    heading: "独自のアドレスで開く",
    body: (host: string) =>
      `このartifactは、所有者が管理するアドレス ${host} にあります。そこで開くつもりだった場合にのみ続行してください。`,
    continue: "続行",
    missing: "リンクが不完全でした。見つけた場所からもう一度開いてください。",
  },
  deviceCodeRequired: "ターミナルに表示されたコードを入力してください。",
  deviceCodeInvalid:
    "このコードは無効か、有効期限が切れています。loginコマンドをもう一度実行してください。",
  deviceCodeTaken: "別のアカウントがすでにこのコードを確認しています。",
  deviceProcessed: "このコードはすでに使用されています。loginコマンドをもう一度実行してください。",
  deviceApproved: "デバイスを接続しました。ターミナルに戻ってください。",
  deviceDenied: "リクエストを拒否しました。デバイスにアクセスは許可されていません。",
  consentMissing:
    "このページには認可リクエストが必要です。このページに移動したアプリから、もう一度やり直してください。",
  consentClientUnknown: "このページに移動したアプリは、登録されていないか無効になっています。",
  redirectHost: (host: string) => `決定後、${host}に戻ります。`,
  scopes: {
    "artifacts:read": "artifact、その設定とバージョンの閲覧",
    "artifacts:write": "artifactの公開と更新",
    "artifacts:share": "artifactを開けるユーザーの変更",
    "artifacts:delete": "artifactのアーカイブと削除",
    "annotations:read": "artifactへのコメントの閲覧",
    "annotations:write": "あなたとしてのコメントの作成と返信",
    "annotations:moderate": "artifactへのコメントの解決、非表示、削除",
    "credentials:manage": "アカウントに連携しているアプリの閲覧と連携解除",
    offline_access: "アクセスを取り消すまで接続を維持",
  },
  unknownScope: (name: string) => `権限「${name}」の使用`,
  languageLabel: "言語",
  report: {
    artifactRequired: "artifactのアドレスまたはIDを入力してください。",
    artifactInvalid:
      "https://abcdefghij.portifact.dev/のようなアドレス、または10文字のIDを入力してください。",
    reasonRequired: "artifactの問題点を選んでください。",
    detailsInvalid: "制御文字を削除するか、詳細を短くしてください。",
    emailInvalid: "有効なメールアドレスを入力するか、空欄のままにしてください。",
    rateLimited:
      "ここからの報告が多すぎます。しばらくしてからもう一度お試しいただくか、abuse@portifact.comまでご連絡ください。",
    network: "Portifactに接続できませんでした。接続を確認して、もう一度お試しください。",
    failed:
      "報告を送信できませんでした。もう一度お試しいただくか、abuse@portifact.comまでご連絡ください。",
    sent: "報告を送信しました。",
  },
  /** The share link entry page (src/share/share.ts). */
  share: {
    checking: "リンクを確認しています。",
    opening: "artifact を開いています。",
    passwordRequired: "パスワードを入力してください。",
    refused: "パスワードが違うか、リンクの期限が切れたか取り消されています。",
    humanCheckShown:
      "下で人間であることを確認してください。完了するとパスワードをもう一度試します。",
    humanCheckUnavailable:
      "人間であることの確認を読み込めませんでした。challenges.cloudflare.com を許可するか、後でもう一度お試しください。",
    rateLimited: "試行回数が多すぎます。数分待ってからもう一度お試しください。",
    network: "Portifact に接続できませんでした。接続を確認して、もう一度お試しください。",
    failed: "リンクを開けませんでした。もう一度お試しください。",
  },
  /** The comment notice unsubscribe page (src/unsubscribe/unsubscribe.ts). */
  unsubscribe: {
    missing:
      "このリンクは不完全です。メールのリンクを開き直すか、設定でコメント通知をオフにしてください。",
    invalid: "このリンクはもう使えません。設定でコメント通知をオフにしてください。",
    rateLimited: "ここからの試行が多すぎます。数分後にもう一度お試しください。",
    network: "Portifactに接続できませんでした。接続を確認して、もう一度お試しください。",
    failed: "コメント通知をオフにできませんでした。もう一度試すか、設定でオフにしてください。",
    done: "コメントとレビューの通知をオフにしました。",
  },
} satisfies AuthMessages;

const TERMS_LINKS = {
  terms: '<a href="https://portifact.com/terms" target="_blank" rel="noopener">利用規約</a>',
  acceptableUse:
    '<a href="https://portifact.com/acceptable-use" target="_blank" rel="noopener">利用ポリシー</a>',
  privacy:
    '<a href="https://portifact.com/privacy" target="_blank" rel="noopener">プライバシーポリシー</a>',
};

/** The conditions of the sign-in notices after the action that accepts them. */
const termsConditions = `あなたは18歳以上であることを確認し、${TERMS_LINKS.terms}と${TERMS_LINKS.acceptableUse}に同意し、${TERMS_LINKS.privacy}を読んだことを認めます。リンクは新しいタブで開きます。`;

export const ja: AuthCatalog = {
  messages,
  page: {
    // Shared by the four pages.
    "auth.skip": "コンテンツへスキップ",
    "auth.home": "Portifactホーム",
    "auth.legal": "法的情報",
    "auth.terms": "利用規約",
    "auth.privacy": "プライバシー",
    "auth.acceptableUse": "利用ポリシー",
    "auth.accessTo": "アクセス先",
    "auth.ableTo": "許可される操作",
    "auth.deny": "拒否",

    // login.html
    "login.title": "Portifactにサインイン",
    "login.intro": "はじめての方は、最初のサインインでアカウントが作成されます。",
    "login.signedInHint":
      "ダッシュボードを開くか、このページを閉じるか、このブラウザでサインアウトできます。",
    "login.openDashboard": "ダッシュボードを開く",
    "login.methodsHeading": "サインイン方法",
    "login.methodsHint":
      "このメールアドレスが確認済みのGoogleまたはGitHubのアカウントは、初めて使用したときにこのアカウントに統合されます。",
    "login.methodNotUsed": "未使用",
    "login.signOut": "サインアウト",
    "login.termsUpdateHeading": "続行するには規約を確認してください",
    "login.termsUpdateBody": "あなたのアカウントは、現在のバージョンの規約にまだ同意していません。",
    "login.termsUpdateNotice": `「同意して続行」を選択することで、${termsConditions}`,
    "login.agreeAndContinue": "同意して続行",
    "login.termsNotice": `Google、GitHub、またはメールのコードで続行することで、${termsConditions}`,
    "login.google": "Googleで続行",
    "login.github": "GitHubで続行",
    "login.orEmail": "またはメールアドレスを使用",
    "login.emailLabel": "メールアドレス",
    "login.sendCode": "コードをメールで受け取る",
    "login.codeHeading": "メールを確認してください",
    "login.codeLabel": "6桁のコード",
    "login.codeHint":
      "コードの有効期限は5分間で、1回だけ使用できます。届かない場合は、迷惑メールフォルダーを確認してください。",
    "login.verify": "サインイン",
    "login.resend": "新しいコードを送信",
    "login.changeEmail": "別のメールアドレスを使用",
    "login.humanHeading": "あと1ステップ：人間であることを確認してください",
    "login.humanBody":
      "Portifactが続行する前に、Cloudflareによる簡単な確認が必要です。下で確認を完了すると、サインインが自動的に続行されます。",

    // device.html
    "device.title": "Portifactにデバイスを接続",
    "device.eyebrow": "PortifactのCLIとアプリ",
    "device.heading": "デバイスを接続",
    "device.intro": "Portifact CLI、またはコードを表示したほかのアプリを承認します。",
    "device.codeLabel": "ターミナルに表示されたコード",
    "device.continue": "続行",
    "device.reviewHeading": "このサインインを承認しますか？",
    "device.app": "アプリ",
    "device.code": "コード",
    "device.warning": "自分のターミナルから開始し、コードが一致する場合にのみ承認してください。",
    "device.approve": "承認",

    // consent.html
    "consent.title": "Portifactへのアクセスを許可",
    "consent.eyebrow": "連携済みのアプリ",
    "consent.heading": "アクセスを許可",
    "consent.requestHeading":
      '<span id="client-name" class="font-semibold break-words"></span>があなたのPortifactアカウントの使用を求めています',
    "consent.publishedBy": "アプリの詳細の公開元",
    "consent.loopback":
      "このデバイス上のアプリに戻ります。信頼できるアプリから開始した場合にのみ許可してください。",
    "consent.allow": "許可",
    "consent.disconnect":
      "アプリの連携は、ダッシュボードのアカウントページからいつでも解除できます。",

    // report.html
    "report.title": "Portifactにartifactを報告",
    "report.heading": "artifactを報告",
    "report.intro":
      '<a href="https://portifact.com/acceptable-use">利用ポリシー</a>に違反するコンテンツをお知らせください。アカウントは不要です。48時間以内の対応を目指しています。',
    "report.artifactLabel": "artifactのアドレスまたはID",
    "report.reasonLabel": "問題点",
    "report.reason.none": "理由を選択",
    "report.reason.phishing": "フィッシングまたは偽のサインインページ",
    "report.reason.malware": "マルウェア、エクスプロイト、暗号資産のマイニング",
    "report.reason.child_safety": "未成年者を性的に扱っている",
    "report.reason.sexual_content": "露骨な性的コンテンツ",
    "report.reason.copyright": "著作権または商標の侵害、海賊版ファイル",
    "report.reason.impersonation": "なりすまし",
    "report.reason.harassment": "脅迫、嫌がらせ、暴力的過激主義",
    "report.reason.private_information": "他人の個人情報",
    "report.reason.spam": "スパム",
    "report.reason.other": "その他のルール違反",
    "report.detailsLabel": '詳細<span class="font-normal text-text-muted">（任意）</span>',
    "report.detailsHint":
      "何をどこで見たか。違法な素材は貼り付けないでください。アドレスだけで十分です。2,000文字まで。",
    "report.emailLabel":
      'あなたのメールアドレス<span class="font-normal text-text-muted">（任意）</span>',
    "report.emailHint":
      '返信を希望する場合のみ入力してください。<a href="https://portifact.com/privacy">プライバシーポリシー</a>をご確認ください。',
    "report.send": "報告を送信",
    "report.doneHeading": "ご報告ありがとうございます。受け付けました",
    "report.doneBody":
      'すべての報告を確認しています。<a href="mailto:abuse@portifact.com">abuse@portifact.com</a>までご連絡いただくこともできます。',
    // share.html
    "share.title": "共有された artifact を開く",
    "share.heading": "共有された artifact を開く",
    "share.passwordIntro": "この artifact を共有した人がパスワードで保護しています。",
    "share.passwordLabel": "パスワード",
    "share.humanCheckHint":
      "パスワードを何度か間違えた後は、人間であることを確認してからもう一度お試しください。",
    "share.open": "開く",
    "share.unavailableHeading": "このリンクは使えません",
    "share.unavailableBody":
      "期限が切れたか取り消された可能性があります。または共有リンクではありません。共有した人に新しいリンクを依頼してください。",
    "share.incompleteHeading": "リンクをもう一度開いてください",
    "share.incompleteBody":
      "このページには、# の後ろの部分を含む共有リンク全体が必要です。安全のため、この部分はアドレスバーから削除されます。再読み込みした後は、受け取った場所からもう一度リンクを開いてください。",
    "share.privacy":
      "アカウントなしで artifact を閲覧しています。Portifact はあなたが誰かを記録しません。所有者にはリンクが使われたことだけが分かります。artifact は Portifact ではなく作成者が書いたものです。パスワードや個人情報を入力しないでください。",
    "share.report": "不正利用を報告",

    // unsubscribe.html
    "unsubscribe.title": "Portifactのコメント通知をオフにする",
    "unsubscribe.heading": "コメント通知をオフにする",
    "unsubscribe.intro":
      "Portifactのartifactへの新しいコメントとレビューについてのメールが届かなくなります。有効期限の通知とログイン用のメールは変わりません。",
    "unsubscribe.confirm": "コメント通知をオフにする",
    "unsubscribe.doneHeading": "コメント通知はオフです",
    "unsubscribe.doneBody": '<a href="/settings">設定</a>でいつでもオンに戻せます。',
  },
};
