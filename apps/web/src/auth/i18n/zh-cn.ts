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
    read_rate_limited: "此账号在短时间内打开了过多 artifact。请等待几分钟后重新打开链接。",
  },
  providerErrorFallback: "登录未完成。请重试。",
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
  },
};
