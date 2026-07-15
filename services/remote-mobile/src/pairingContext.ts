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

export function isStandalonePairingContainer(
  displayModeStandalone: boolean,
  appleStandalone: boolean,
): boolean {
  return displayModeStandalone || appleStandalone;
}
