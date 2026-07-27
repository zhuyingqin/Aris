export type ErrorMessageLanguage = "cn" | "en";

type ErrorCopy = {
  authentication: string;
  signInExpired: string;
  connection: string;
  contextLimit: string;
  rateLimited: string;
  modelUnavailable: string;
  serviceUnavailable: string;
  localFile: string;
  unexpected: string;
};

const COPY: Record<ErrorMessageLanguage, ErrorCopy> = {
  cn: {
    authentication: "身份验证失败，请重新登录或检查 API Key。",
    signInExpired: "登录已过期，请重新登录。",
    connection: "暂时无法连接到服务，请检查网络后重试。",
    contextLimit: "当前对话上下文过长，请新建对话或压缩上下文后重试。",
    rateLimited: "请求过于频繁或当前额度不足，请稍后重试。",
    modelUnavailable: "所选模型当前不可用，请在设置中更换模型后重试。",
    serviceUnavailable: "服务暂时不可用，请稍后重试。",
    localFile: "无法访问本地文件，请检查文件是否存在及访问权限。",
    unexpected: "操作未完成，请稍后重试。",
  },
  en: {
    authentication: "Authentication failed. Sign in again or check the API key.",
    signInExpired: "Your sign-in has expired. Please sign in again.",
    connection: "Unable to reach the service. Check your network connection and try again.",
    contextLimit: "This chat is too long for the selected model. Start a new chat or compact the context, then try again.",
    rateLimited: "The request was rate-limited or the current quota is unavailable. Please try again later.",
    modelUnavailable: "The selected model is unavailable. Choose another model in Settings and try again.",
    serviceUnavailable: "The service is temporarily unavailable. Please try again later.",
    localFile: "The local file could not be accessed. Check that it exists and that you have permission to use it.",
    unexpected: "The operation could not be completed. Please try again.",
  },
};

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/i;
const IP_ADDRESS_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/;
const HOST_PATTERN = /\b(?:localhost|(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|cn|dev|app|cloud|local|internal|test|co|uk|us|de|jp|info|online|me|xyz))(?::\d{1,5})?(?:\/[^\s"']*)?/i;
const WINDOWS_PATH_PATTERN = /(?:[a-z]:\\|\\\\)[^\r\n"']+/i;
const UNIX_PATH_PATTERN = /(?:^|[\s"'(])\/(?:[^\s"')]+\/)+[^\s"')]+/;
const SECRET_PATTERN = /(?:\bbearer\s+[a-z0-9._~-]+|\b(?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\b\s*[:=]\s*[^\s,;]+)/i;

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error == null) return "";
  return String(error);
}

function hasLocalPath(message: string): boolean {
  return WINDOWS_PATH_PATTERN.test(message) || UNIX_PATH_PATTERN.test(message);
}

function hasPrivateDetail(message: string): boolean {
  return URL_PATTERN.test(message)
    || IP_ADDRESS_PATTERN.test(message)
    || HOST_PATTERN.test(message)
    || SECRET_PATTERN.test(message);
}

/**
 * Converts an implementation error into a short, user-actionable message.
 * Raw transport errors frequently contain configured endpoints, request paths,
 * or credentials, so they must never be rendered directly in the desktop UI.
 */
export function formatUserFacingError(
  error: unknown,
  language: ErrorMessageLanguage = "cn",
): string {
  const message = rawErrorMessage(error).trim();
  const lower = message.toLowerCase();
  const copy = COPY[language];

  if (!message) return copy.unexpected;

  if (
    lower.includes("context window")
    || lower.includes("context length")
    || lower.includes("context_length_exceeded")
    || lower.includes("上下文长度")
    || lower.includes("上下文过长")
  ) {
    return copy.contextLimit;
  }

  if (lower.includes("login expired") || lower.includes("sign in again")) return copy.signInExpired;

  if (
    lower.includes("invalid api key")
    || lower.includes("invalid access token")
    || lower.includes("invalid token")
    || lower.includes("unauthorized")
    || lower.includes("authentication failed")
    || lower.includes("http 401")
    || lower.includes("status 401")
  ) {
    return copy.authentication;
  }

  if (
    lower.includes("rate limit")
    || lower.includes("too many requests")
    || lower.includes("http 429")
    || lower.includes("status 429")
    || lower.includes("quota")
    || lower.includes("额度")
  ) {
    return copy.rateLimited;
  }

  if (
    lower.includes("model not found")
    || lower.includes("model unavailable")
    || lower.includes("unknown model")
    || lower.includes("model does not exist")
    || lower.includes("模型不存在")
    || lower.includes("模型不可用")
  ) {
    return copy.modelUnavailable;
  }

  if (
    lower.includes("connection refused")
    || lower.includes("connection reset")
    || lower.includes("connect error")
    || lower.includes("network error")
    || lower.includes("failed to connect")
    || lower.includes("dns")
    || lower.includes("econnrefused")
    || lower.includes("enotfound")
    || lower.includes("timed out")
    || lower.includes("timeout")
    || lower.includes("无法连接")
    || lower.includes("连接超时")
  ) {
    return copy.connection;
  }

  if (/\b(?:http\s*)?5\d\d\b/.test(lower) || lower.includes("internal server error")) {
    return copy.serviceUnavailable;
  }

  if (hasLocalPath(message)) return copy.localFile;

  // Any remaining endpoint or credential-shaped detail is not suitable for a
  // user-facing surface. Keep the failure actionable without naming the host.
  if (hasPrivateDetail(message)) return copy.serviceUnavailable;

  // Server response dumps, stack traces, and long exception chains are neither
  // useful nor safe to show in a toast or chat card.
  if (
    message.length > 280
    || lower.includes("stack trace")
    || lower.includes("failed to execute")
    || lower.includes("panic")
    || lower.includes("reqwest::")
  ) {
    return copy.unexpected;
  }

  return message;
}
