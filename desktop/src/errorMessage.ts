import type { Language } from "./store";
import { isClientOutdatedError } from "./clientOutdated";

export type ErrorMessageLanguage = Language;

type ErrorCopy = {
  clientOutdated: string;
  authentication: string;
  upstreamCredentialExpired: string;
  signInExpired: string;
  connection: string;
  contextLimit: string;
  reasoningContinuation: string;
  rateLimited: string;
  modelUnavailable: string;
  serviceUnavailable: string;
  localFile: string;
  localFileMissing: string;
  localFilePermission: string;
  localFileBusy: string;
  unexpected: string;
};

const COPY: Record<ErrorMessageLanguage, ErrorCopy> = {
  cn: {
    clientOutdated: "当前版本已停止服务，请更新 SomniQ Studio 后继续使用。",
    authentication: "身份验证失败，请重新登录或检查 API Key。",
    upstreamCredentialExpired: "所选模型的服务端密钥已过期，请切换模型或联系服务管理员。",
    signInExpired: "登录已过期，请重新登录。",
    connection: "暂时无法连接到服务，请检查网络后重试。",
    contextLimit: "当前对话上下文过长，请新建对话或压缩上下文后重试。",
    reasoningContinuation: "模型未能接续工具调用所需的思考记录，请重试或切换模型后继续。",
    rateLimited: "请求过于频繁或当前额度不足，请稍后重试。",
    modelUnavailable: "所选模型当前不可用，请在设置中更换模型后重试。",
    serviceUnavailable: "服务暂时不可用，请稍后重试。",
    localFile: "无法访问本地文件，请检查文件是否存在及访问权限。",
    localFileMissing: "本地文件或目录不存在，可能已被移动或删除，请重新选择后重试。",
    localFilePermission: "没有访问该本地文件或目录的权限，请检查权限或选择可访问的位置。",
    localFileBusy: "本地文件正被其他程序占用，请关闭占用它的程序后重试。",
    unexpected: "操作未完成，请稍后重试。",
  },
  en: {
    clientOutdated: "This version of SomniQ Studio is no longer supported. Update it to continue.",
    authentication: "Authentication failed. Sign in again or check the API key.",
    upstreamCredentialExpired: "The selected model's service credential has expired. Switch models or contact the service administrator.",
    signInExpired: "Your sign-in has expired. Please sign in again.",
    connection: "Unable to reach the service. Check your network connection and try again.",
    contextLimit: "This chat is too long for the selected model. Start a new chat or compact the context, then try again.",
    reasoningContinuation: "The model could not continue with the reasoning history required for tool calls. Retry or switch models to continue.",
    rateLimited: "The request was rate-limited or the current quota is unavailable. Please try again later.",
    modelUnavailable: "The selected model is unavailable. Choose another model in Settings and try again.",
    serviceUnavailable: "The service is temporarily unavailable. Please try again later.",
    localFile: "The local file could not be accessed. Check that it exists and that you have permission to use it.",
    localFileMissing: "The local file or folder was not found. It may have been moved or deleted; select it again and retry.",
    localFilePermission: "You do not have permission to access this local file or folder. Check its permissions or select an accessible location.",
    localFileBusy: "The local file is in use by another program. Close that program and retry.",
    unexpected: "The operation could not be completed. Please try again.",
  },
  es: {
    clientOutdated: "Esta versión de SomniQ Studio ya no tiene soporte. Actualízala para continuar.",
    authentication: "Error de autenticación. Vuelve a iniciar sesión o revisa la API key.",
    upstreamCredentialExpired: "La credencial del servicio del modelo seleccionado ha caducado. Cambia de modelo o contacta con el administrador del servicio.",
    signInExpired: "Tu sesión ha caducado. Vuelve a iniciar sesión.",
    connection: "No se puede conectar con el servicio. Revisa tu conexión de red y vuelve a intentarlo.",
    contextLimit: "Este chat es demasiado largo para el modelo seleccionado. Empieza un chat nuevo o compacta el contexto y vuelve a intentarlo.",
    reasoningContinuation: "El modelo no pudo continuar con el historial de razonamiento que requieren las llamadas a herramientas. Reintenta o cambia de modelo para continuar.",
    rateLimited: "La solicitud se limitó por frecuencia o la cuota actual no está disponible. Vuelve a intentarlo más tarde.",
    modelUnavailable: "El modelo seleccionado no está disponible. Elige otro modelo en Configuración y vuelve a intentarlo.",
    serviceUnavailable: "El servicio no está disponible temporalmente. Vuelve a intentarlo más tarde.",
    localFile: "No se pudo acceder al archivo local. Comprueba que existe y que tienes permiso para usarlo.",
    localFileMissing: "No se encontró el archivo o la carpeta local. Puede que se haya movido o eliminado; selecciónalo de nuevo y reintenta.",
    localFilePermission: "No tienes permiso para acceder a este archivo o carpeta local. Revisa sus permisos o selecciona una ubicación accesible.",
    localFileBusy: "Otro programa está usando el archivo local. Cierra ese programa y reintenta.",
    unexpected: "No se pudo completar la operación. Vuelve a intentarlo.",
  },
};

/** Presentation rules only; raw authentication text must not trigger logout. */
export const AUTH_SESSION_EXPIRED_NEEDLES = ["login expired", "sign in again"];
export const AUTH_TOKEN_INVALID_NEEDLES = ["invalid access token", "invalid token"];

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/i;
const IP_ADDRESS_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/;
const HOST_PATTERN = /\b(?:localhost|(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|cn|dev|app|cloud|local|internal|test|co|uk|us|de|jp|info|online|me|xyz))(?::\d{1,5})?(?:\/[^\s"']*)?/i;
const WINDOWS_PATH_PATTERN = /(?:\b[a-z]:[\\/]|\\\\)[^\r\n"']+/i;
const UNIX_PATH_PATTERN = /(?:^|[\s"'(])\/(?:[^\s"')]+\/)+[^\s"')]+/;
const SECRET_PATTERN = /(?:\bbearer\s+[a-z0-9._~-]+|\b(?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\b\s*[:=]\s*[^\s,;]+)/i;

// A provider may quote tool inputs, its own filesystem, or a stack trace.
// Those paths do not establish that the user's local file could not be read.
const SERVICE_FAILURE_PATTERN = /\b(?:http(?:\/\d(?:\.\d)?)?\s+[45]\d{2}|(?:openai|anthropic|gemini)\s+(?:api error|request failed|stream\b)|upstream_error|invalid_request_error)\b/i;
const FILE_MISSING_PATTERN = /\b(?:enoent|enotdir|no such file or directory)\b|\bos error [23]\b|\b(?:file|directory|path) (?:does not exist|not found)\b|系统找不到指定的(?:文件|路径)/i;
const FILE_BUSY_PATTERN = /\b(?:ebusy|etxtbsy|sharing violation|being used by another process)\b|\bos error (?:32|33)\b|另一个程序正在使用此文件|文件正由另一进程使用/i;
const FILE_PERMISSION_CODE_PATTERN = /\b(?:eacces|eperm)\b|\bos error 5\b/i;
const FILE_PERMISSION_PATTERN = /\b(?:permission denied|access (?:is )?denied)\b|拒绝访问|权限不足/i;
const FILE_OPERATION_FAILURE_PATTERN = /\b(?:(?:failed|unable) to|could not|cannot)\s+(?:read|write|open|save|create|copy|move|rename|delete|remove|access|canonicalize)\s+(?:(?:(?:the|a|an|selected|local|source|target)\s+)*(?:file|directory|folder|path)\b|[`"'(<]*(?:[a-z]:[\\/]|\\\\|\/))/i;

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error == null) return "";
  return String(error);
}

/** This provider explicitly says account sign-in cannot renew its static key. */
export function isUpstreamCredentialExpiredError(error: unknown): boolean {
  const lower = rawErrorMessage(error).toLowerCase();
  return lower.includes("api_key_expired")
    && (lower.includes("opencode") || lower.includes("signing in again will not renew this key"));
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

  // The gateway refused this release (HTTP 426); only an update helps.
  if (isClientOutdatedError(message)) return copy.clientOutdated;

  if (isUpstreamCredentialExpiredError(error)) return copy.upstreamCredentialExpired;

  if (
    lower.includes("reasoning_content")
    && (
      lower.includes("must be passed back")
      || lower.includes("missing")
      || lower.includes("required")
    )
  ) {
    return copy.reasoningContinuation;
  }

  if (
    lower.includes("context window")
    || lower.includes("context length")
    || lower.includes("context_length_exceeded")
    || lower.includes("上下文长度")
    || lower.includes("上下文过长")
  ) {
    return copy.contextLimit;
  }

  if (AUTH_SESSION_EXPIRED_NEEDLES.some((needle) => lower.includes(needle))) return copy.signInExpired;

  if (
    lower.includes("invalid api key")
    || AUTH_TOKEN_INVALID_NEEDLES.some((needle) => lower.includes(needle))
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
    || lower.includes("cuota")
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
    || lower.includes("modelo no disponible")
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
    || lower.includes("no se pudo conectar")
  ) {
    return copy.connection;
  }

  if (
    SERVICE_FAILURE_PATTERN.test(message)
    || /\b(?:http\s*)?5\d\d\b/.test(lower)
    || lower.includes("internal server error")
  ) {
    return copy.serviceUnavailable;
  }

  if (FILE_MISSING_PATTERN.test(message)) return copy.localFileMissing;
  if (FILE_BUSY_PATTERN.test(message)) return copy.localFileBusy;
  const localPath = hasLocalPath(message);
  if (FILE_PERMISSION_CODE_PATTERN.test(message) || (localPath && FILE_PERMISSION_PATTERN.test(message))) {
    return copy.localFilePermission;
  }
  if (localPath && FILE_OPERATION_FAILURE_PATTERN.test(message)) return copy.localFile;

  // Any remaining endpoint or credential-shaped detail is not suitable for a
  // user-facing surface. Keep the failure actionable without naming the host.
  if (hasPrivateDetail(message)) return copy.serviceUnavailable;

  // An unexplained path is private detail, not proof of a file access failure.
  // Server dumps, stack traces, and long exception chains also stay out of UI.
  if (
    localPath
    || message.length > 280
    || lower.includes("stack trace")
    || lower.includes("failed to execute")
    || lower.includes("panic")
    || lower.includes("reqwest::")
  ) {
    return copy.unexpected;
  }

  return message;
}
