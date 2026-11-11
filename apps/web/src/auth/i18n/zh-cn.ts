// Simplified Chinese catalog of the auth and report pages: the scripts' messages and the pages'
// markers. Mainland Chinese with "你". The sign-in notices keep every condition of the English
// (docs/legal.md, "Acceptance at sign-in") and the same three links.
import type { AuthMessages } from "./en.ts";
import type { AuthCatalog } from "./types.ts";

const messages = {
  network: "无法连接到 Portifact。请检查网络连接后重试。",
  unexpected: "出了点问题。请重试。",
  rateLimited: "尝试次数过多。请等待一分钟后重试。",
  emailRequired: "请输入你的邮箱地址。",
  emailInvalid: "请输入有效的邮箱地址，例如 name@example.com。",
  codeRequired: "请输入邮件中的 6 位验证码。",
  codeInvalid: "该验证码无效或已过期。请检查验证码或重新发送。",
  codeSent: (email: string) => `我们已向 ${email} 发送了 6 位验证码。`,
  codeSentStatus: "验证码已发送。请输入邮件中的 6 位验证码。",
  codeResent: "新的验证码正在发送中。",
  resendCode: "重新发送验证码",
  resendIn: (seconds: number) => `${seconds} 秒后可重新发送验证码`,
  humanCheckNeeded: "还差一步：Cloudflare 需要快速验证你是真人。请在登录选项下方完成验证以继续。",
  emailSuppressed:
    "我们无法向此地址发送邮件，因为之前发送的邮件被退回或被举报为垃圾邮件。请使用 Google 或 GitHub 登录，或发送邮件至 privacy@portifact.com 申请审核。",
  emailCapacity:
    "由于 Portifact 已达到每月邮件上限，邮箱验证码暂停发送。请使用 Google 或 GitHub 登录，或稍后重试。",
  signedInAs: (email: string) => `已以 ${email} 的身份登录`,
  signedOut: "你已退出登录。",
  methodConnected: "已关联",
  methodNotUsed: "尚未使用",
  redirecting: "正在为你登录。",
  ssoFor: (email: string) => `${email} 通过你所在组织的身份提供方登录。`,
  ssoShown: "你所在的组织使用单点登录。继续使用它，或改为获取邮箱验证码。",
  termsUpdateFor: (email: string) => `已以 ${email} 的身份登录`,
  providerErrors: {
    human_verification_required:
      "新账号需要快速验证你是真人，但验证未完成。请重试；如果登录选项下方出现验证，请完成它。如果没有出现任何内容，请重新加载页面或允许 challenges.cloudflare.com。",
    terms_not_accepted:
      "你对条款的同意未送达 Portifact，或已在 30 分钟后失效。请重新选择一种登录方式以继续。",
    account_not_linked:
      "你的提供商尚未验证此邮箱地址，因此无法打开使用该地址的 Portifact 账号。请在提供商处完成验证，或使用邮箱验证码登录。",
    email_not_verified:
      "你的提供商尚未验证此邮箱地址。请在提供商处完成验证，或使用邮箱验证码登录。",
    email_not_found: "你的提供商没有提供邮箱地址。请使用邮箱验证码登录。",
    state_mismatch: "登录耗时过长，或是在另一个标签页中开始的。请重试。",
    artifact_unavailable:
      "此 artifact 不存在、已不可用，或无法用此账号打开。如需使用其他账号，请退出登录后重新打开链接。",
    sso_required:
      "此工作区要求通过你所在组织的单点登录进行登录。请在下方使用你的工作地址继续；你当前的登录保持不变，完成后会回到原来的位置。",
    session_age:
      "此工作区每隔一段时间要求重新登录，而你的登录已超过允许的时长。请重新登录以继续，之后会回到原来的位置。",
    network_refused:
      "此工作区只允许从其批准的网络访问，而你当前不在其中任何一个网络。请连接到批准的网络后重新打开链接，或联系工作区管理员。",
    read_rate_limited: "此账号在短时间内打开了过多 artifact。请等待几分钟后重新打开链接。",
    sso_unavailable: "此地址目前无法使用单点登录。请用其他方式登录，或联系你的工作区管理员。",
    sso_email_outside_domain:
      "你所在组织的身份提供方返回了不在其已验证域名内的地址，因此 Portifact 无法使用。请联系你的工作区管理员。",
    sso_failed: "单点登录未完成。请重试；如果仍然失败，请用邮箱验证码登录并告知你的工作区管理员。",
    sso_workspace_full:
      "你所在组织的工作区没有空余席位，因此你无法加入。请向管理员申请席位，然后重新登录。",
    sso_email_unverified:
      "你所在组织的身份提供方未验证此地址，因此 Portifact 无法使用。请联系你的工作区管理员。",
    sso_link_required:
      "此地址已有 Portifact 账户。请先用邮箱验证码或常用方式登录一次，然后在此页面选择“关联单点登录”。",
    sso_removed: "工作区管理员已将你移除，因此你无法通过单点登录重新加入。请让管理员再次邀请你。",
  },
  providerErrorFallback: "登录未完成。请重试。",
  /** The read entry's confirmation before a code goes to an artifact's custom host. */
  readConfirm: {
    heading: "在其自有地址打开",
    body: (host: string) =>
      `此 artifact 位于 ${host}，该地址由其所有者管理。仅当你确实想在那里打开它时才继续。`,
    continue: "继续",
    missing: "链接不完整。请从你找到它的地方重新打开。",
  },
  deviceCodeRequired: "请输入终端中显示的代码。",
  deviceCodeInvalid: "该代码无效或已过期。请重新运行登录命令。",
  deviceCodeTaken: "另一个账号正在审核此代码。",
  deviceProcessed: "此代码已被使用。请重新运行登录命令。",
  deviceApproved: "设备已关联。你可以返回终端了。",
  deviceDenied: "请求已拒绝。该设备未获得访问权限。",
  consentMissing: "此页面需要一个授权请求。请从将你引导到这里的应用重新开始。",
  consentClientUnknown: "将你引导到这里的应用未注册或已被停用。",
  redirectHost: (host: string) => `做出决定后，你将返回 ${host}。`,
  scopes: {
    "artifacts:read": "查看你的 artifact、其设置和版本",
    "artifacts:write": "发布和更新 artifact",
    "artifacts:share": "更改谁可以打开你的 artifact",
    "artifacts:delete": "归档和删除你的 artifact",
    "annotations:read": "阅读你的 artifact 上的评论",
    "annotations:write": "以你的身份撰写和回复评论",
    "annotations:moderate": "解决、隐藏和删除你的 artifact 上的评论",
    "credentials:manage": "查看关联到你账号的应用并断开它们",
    offline_access: "保持连接，直到你撤销访问权限",
  },
  unknownScope: (name: string) => `使用权限“${name}”`,
  languageLabel: "语言",
  report: {
    artifactRequired: "请输入 artifact 的地址或 ID。",
    artifactInvalid: "请输入类似 https://abcdefghij.portifact.dev/ 的地址或 10 个字符的 ID。",
    reasonRequired: "请选择此 artifact 存在的问题。",
    detailsInvalid: "请移除控制字符或缩短详情。",
    emailInvalid: "请输入有效的邮箱地址，或留空。",
    rateLimited: "从这里提交的举报过多。请稍后重试，或发送邮件至 abuse@portifact.com。",
    network: "无法连接到 Portifact。请检查网络连接后重试。",
    failed: "无法发送举报。请重试，或发送邮件至 abuse@portifact.com。",
    sent: "举报已发送。",
  },
  /** The share link entry page (src/share/share.ts). */
  share: {
    checking: "正在检查链接。",
    opening: "正在打开 artifact。",
    passwordRequired: "请输入密码。",
    refused: "密码错误，或者链接已过期或已被撤销。",
    humanCheckShown: "请在下方确认你是真人。完成后会再次尝试密码。",
    humanCheckUnavailable: "无法加载真人验证。请允许 challenges.cloudflare.com，或稍后再试。",
    rateLimited: "尝试次数过多。请等几分钟后再试。",
    network: "无法连接 Portifact。请检查网络连接后再试。",
    failed: "无法打开链接。请再试一次。",
  },
  /** The comment notice unsubscribe page (src/unsubscribe/unsubscribe.ts). */
  unsubscribe: {
    missing: "此链接不完整。请重新打开邮件中的链接，或在设置中关闭评论通知。",
    invalid: "此链接已失效。请在设置中关闭评论通知。",
    rateLimited: "此处尝试次数过多。请几分钟后再试。",
    network: "无法连接到 Portifact。请检查网络连接后重试。",
    failed: "无法关闭评论通知。请重试，或在设置中关闭。",
    done: "评论和审阅通知已关闭。",
  },
} satisfies AuthMessages;

const TERMS_LINKS = {
  terms: '<a href="https://portifact.com/terms" target="_blank" rel="noopener">服务条款</a>',
  acceptableUse:
    '<a href="https://portifact.com/acceptable-use" target="_blank" rel="noopener">可接受使用政策</a>',
  privacy: '<a href="https://portifact.com/privacy" target="_blank" rel="noopener">隐私政策</a>',
};

/** The conditions of the sign-in notices after the action that accepts them. */
const termsConditions = `即表示你确认你已年满 18 周岁，同意${TERMS_LINKS.terms}和${TERMS_LINKS.acceptableUse}，并已阅读${TERMS_LINKS.privacy}。这些链接会在新标签页中打开。`;

export const zhCN: AuthCatalog = {
  messages,
  page: {
    // Shared by the four pages.
    "auth.skip": "跳到内容",
    "auth.home": "Portifact 首页",
    "auth.legal": "法律信息",
    "auth.terms": "条款",
    "auth.privacy": "隐私",
    "auth.acceptableUse": "可接受使用",
    "auth.accessTo": "可访问",
    "auth.ableTo": "它将能够",
    "auth.deny": "拒绝",

    // login.html
    "login.title": "登录 Portifact",
    "login.intro": "第一次使用？首次登录会为你创建账号。",
    "login.signedInHint": "你可以打开控制台、关闭此页面，或在此浏览器上退出登录。",
    "login.openDashboard": "打开控制台",
    "login.methodsHeading": "登录方式",
    "login.methodsHint": "已验证此邮箱的 Google 或 GitHub 账号会在你首次使用时关联到此账号。",
    "login.methodNotUsed": "尚未使用",
    "login.signOut": "退出登录",
    "login.termsUpdateHeading": "查看条款以继续",
    "login.termsUpdateBody": "你的账号尚未同意当前版本的条款。",
    "login.termsUpdateNotice": `选择“同意并继续”，${termsConditions}`,
    "login.agreeAndContinue": "同意并继续",
    "login.termsNotice": `继续使用 Google、GitHub 或邮箱验证码登录，${termsConditions}`,
    "login.termsNoticeSso": `继续使用 Google、GitHub、邮箱验证码或单点登录，${termsConditions}`,
    "login.ssoHeading": "你所在的组织使用单点登录",
    "login.ssoContinue": "使用单点登录继续",
    "login.ssoUseCode": "改为获取邮箱验证码",
    "login.ssoLinkHint": "你所在的组织使用单点登录。将其与此账户关联一次，下次即可使用。",
    "login.ssoLink": "关联单点登录",
    "login.google": "使用 Google 继续",
    "login.github": "使用 GitHub 继续",
    "login.orEmail": "或使用邮箱",
    "login.emailLabel": "邮箱地址",
    "login.sendCode": "发送验证码",
    "login.codeHeading": "查看你的邮箱",
    "login.codeLabel": "6 位验证码",
    "login.codeHint": "验证码 5 分钟内有效，且只能使用一次。如果没有收到，请检查垃圾邮件文件夹。",
    "login.verify": "登录",
    "login.resend": "重新发送验证码",
    "login.changeEmail": "使用其他邮箱",
    "login.humanHeading": "还差一步：确认你是真人",
    "login.humanBody":
      "Portifact 继续之前，Cloudflare 需要快速验证。请在下方完成验证，你的登录会自动继续。",

    // device.html
    "device.title": "将设备关联到 Portifact",
    "device.eyebrow": "Portifact CLI 和应用",
    "device.heading": "关联设备",
    "device.intro": "批准 Portifact CLI 或其他向你显示了代码的应用。",
    "device.codeLabel": "终端中显示的代码",
    "device.continue": "继续",
    "device.reviewHeading": "批准此次登录？",
    "device.app": "应用",
    "device.code": "代码",
    "device.warning": "仅当你是从自己的终端发起此操作且代码一致时才批准。",
    "device.approve": "批准",

    // consent.html
    "consent.title": "允许访问 Portifact",
    "consent.eyebrow": "已关联的应用",
    "consent.heading": "允许访问",
    "consent.requestHeading":
      '<span id="client-name" class="font-semibold break-words"></span> 想要使用你的 Portifact 账号',
    "consent.publishedBy": "应用详情发布者",
    "consent.loopback": "它会返回到此设备上的一个应用。仅当你是从信任的应用发起此操作时才允许。",
    "consent.allow": "允许",
    "consent.disconnect": "你可以随时在控制台的账号页面中断开应用。",

    // report.html
    "report.title": "向 Portifact 举报 artifact",
    "report.heading": "举报 artifact",
    "report.intro":
      '告诉我们违反<a href="https://portifact.com/acceptable-use">可接受使用政策</a>的内容。你无需拥有账号。我们会尽量在 48 小时内回复。',
    "report.artifactLabel": "Artifact 地址或 ID",
    "report.reasonLabel": "存在什么问题",
    "report.reason.none": "选择原因",
    "report.reason.phishing": "网络钓鱼或伪造的登录页面",
    "report.reason.malware": "恶意软件、漏洞利用或加密货币挖矿",
    "report.reason.child_safety": "对未成年人进行性化",
    "report.reason.sexual_content": "露骨的色情内容",
    "report.reason.copyright": "侵犯版权或商标、盗版文件",
    "report.reason.impersonation": "冒充他人",
    "report.reason.harassment": "威胁、骚扰或暴力极端主义",
    "report.reason.private_information": "他人的私人信息",
    "report.reason.spam": "垃圾内容",
    "report.reason.other": "其他违反规则的内容",
    "report.detailsLabel": '详情<span class="font-normal text-text-muted">（可选）</span>',
    "report.detailsHint":
      "你看到了什么、在哪里看到的。不要粘贴非法内容，提供地址即可。最多 2000 个字符。",
    "report.emailLabel": '你的邮箱<span class="font-normal text-text-muted">（可选）</span>',
    "report.emailHint":
      '仅在你希望我们能回复你时填写。请参阅<a href="https://portifact.com/privacy">隐私政策</a>。',
    "report.send": "发送举报",
    "report.doneHeading": "谢谢，我们已收到你的举报",
    "report.doneBody":
      '我们会审核每一份举报。你也可以发送邮件至 <a href="mailto:abuse@portifact.com">abuse@portifact.com</a>。',
    // share.html
    "share.title": "打开共享的 artifact",
    "share.heading": "打开共享的 artifact",
    "share.passwordIntro": "共享此 artifact 的人为它设置了密码保护。",
    "share.passwordLabel": "密码",
    "share.humanCheckHint": "多次输入错误密码后，请先确认你是真人，然后再试。",
    "share.open": "打开",
    "share.unavailableHeading": "此链接无法使用",
    "share.unavailableBody":
      "它可能已过期或已被撤销，或者它不是共享链接。请向共享它的人索取新链接。",
    "share.incompleteHeading": "请重新打开链接",
    "share.incompleteBody":
      "此页面需要完整的共享链接，包括 # 后面的部分。为了你的安全，页面会从地址栏中移除这部分，所以重新加载后，请从你收到链接的地方再次打开它。",
    "share.privacy":
      "你无需账号即可阅读此 artifact。Portifact 不会记录你是谁；所有者只能看到链接被使用过。artifact 由其作者编写，而不是 Portifact：请不要在其中输入密码或个人数据。",
    "share.report": "举报滥用",

    // unsubscribe.html
    "unsubscribe.title": "关闭 Portifact 评论通知",
    "unsubscribe.heading": "关闭评论通知",
    "unsubscribe.intro":
      "你将不再收到有关 Portifact artifact 新评论和审阅的邮件。到期通知和登录邮件不受影响。",
    "unsubscribe.confirm": "关闭评论通知",
    "unsubscribe.doneHeading": "评论通知已关闭",
    "unsubscribe.doneBody": '你可以随时在<a href="/settings">设置</a>中重新开启。',
  },
};
