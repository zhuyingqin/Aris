export type PairingBrowserContext = "embedded" | "wechat" | "qq" | "dingtalk" | "alipay" | "weibo";

const CONTEXT_LABELS: Record<PairingBrowserContext, string> = {
  embedded: "内嵌网页",
  wechat: "微信内置浏览器",
  qq: "QQ 内置浏览器",
  dingtalk: "钉钉内置浏览器",
  alipay: "支付宝内置浏览器",
  weibo: "微博内置浏览器",
};

export function pairingBrowserContext(
  userAgent: string,
  embedded: boolean,
): PairingBrowserContext | null {
  if (embedded) {
    return "embedded";
  }
  if (/MicroMessenger|WxWork/i.test(userAgent)) {
    return "wechat";
  }
  if (/(?:^|\s)QQ\//i.test(userAgent)) {
    return "qq";
  }
  if (/DingTalk/i.test(userAgent)) {
    return "dingtalk";
  }
  if (/AlipayClient/i.test(userAgent)) {
    return "alipay";
  }
  if (/Weibo/i.test(userAgent)) {
    return "weibo";
  }
  return null;
}

export function pairingBrowserContextLabel(context: PairingBrowserContext): string {
  return CONTEXT_LABELS[context];
}

/**
 * Whether being embedded puts this frame's storage at risk.
 *
 * The guard this feeds exists because in-app browsers (WeChat, QQ, …) discard
 * or partition storage on exit, which would silently destroy a pairing the
 * moment it was made. A *same-origin* frame has no such problem: it reads and
 * writes the very same origin storage as the top-level document, so refusing
 * to pair there blocks a working flow for no benefit — the account console
 * embeds this app in exactly that way.
 *
 * A cross-origin parent, or one whose origin cannot be read at all, keeps the
 * original treatment.
 */
export function isEphemeralEmbedding(
  topOrigin: string | null,
  ownOrigin: string,
): boolean {
  return topOrigin === null || topOrigin !== ownOrigin;
}

export function isStandalonePairingContainer(
  displayModeStandalone: boolean,
  appleStandalone: boolean,
): boolean {
  return displayModeStandalone || appleStandalone;
}
