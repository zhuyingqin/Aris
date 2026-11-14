import { describe, expect, it } from "vitest";
import { formatUserFacingError } from "./errorMessage";

describe("formatUserFacingError", () => {
  it("hides endpoint details from connection failures", () => {
    const message = formatUserFacingError(
      "request to http://10.24.8.17:8080/v1/chat failed: connection refused",
    );

    expect(message).toBe("暂时无法连接到服务，请检查网络后重试。");
    expect(message).not.toContain("10.24.8.17");
    expect(message).not.toContain("http");
  });

  it("classifies common model-provider failures accurately", () => {
    expect(formatUserFacingError("HTTP 401 Unauthorized")).toBe("身份验证失败，请重新登录或检查 API Key。");
    expect(formatUserFacingError("HTTP 429 too many requests")).toBe("请求过于频繁或当前额度不足，请稍后重试。");
    expect(formatUserFacingError("context_length_exceeded")).toBe("当前对话上下文过长，请新建对话或压缩上下文后重试。");
    expect(formatUserFacingError("model not found")).toBe("所选模型当前不可用，请在设置中更换模型后重试。");
  });

  it("explains upstream key expiry before generic authentication or sign-in hints", () => {
    const error = 'OpenAI API error 401 Unauthorized: {"error":{"message":"This API key has expired. Create a new API key in OpenCode Console. Signing in again will not renew this key.","type":"authentication_error","code":"api_key_expired"}}';
    expect(formatUserFacingError(error)).toBe("所选模型的服务端密钥已过期，请切换模型或联系服务管理员。");
    expect(formatUserFacingError(new Error(error), "en")).toBe("The selected model's service credential has expired. Switch models or contact the service administrator.");
    expect(formatUserFacingError(error + " Please sign in again. https://gateway.internal sk-private-key")).toBe(formatUserFacingError(error));
    expect(formatUserFacingError('HTTP 401 {"error":{"code":"api_key_expired","message":"The account API key expired"}}')).toBe("身份验证失败，请重新登录或检查 API Key。");
  });

  it("explains a rejected reasoning continuation without exposing the provider dump", () => {
    const error = 'OpenAI API error 400 Bad Request: {"error":{"message":"Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: test-request-id)","type":"invalid_request_error","param":"","code":"invalid_request_error"}}';

    expect(formatUserFacingError(error)).toBe("模型未能接续工具调用所需的思考记录，请重试或切换模型后继续。");
    expect(formatUserFacingError(error, "en")).toBe("The model could not continue with the reasoning history required for tool calls. Retry or switch models to continue.");
    expect(formatUserFacingError("Missing reasoning_content for an assistant tool call", "en")).toBe(formatUserFacingError(error, "en"));
    expect(formatUserFacingError("reasoning_content is required: https://gateway.internal/token?secret=value")).toBe(formatUserFacingError(error));
  });

  it("does not leak paths or credentials from otherwise unknown failures", () => {
    expect(formatUserFacingError("failed to write C:\\Users\\name\\secret.txt")).toBe("无法访问本地文件，请检查文件是否存在及访问权限。");
    expect(formatUserFacingError("request failed: Authorization: Bearer sk-secret-value")).toBe("服务暂时不可用，请稍后重试。");
    expect(formatUserFacingError("malformed response from gateway.internal")).toBe("服务暂时不可用，请稍后重试。");
  });

  it.each([
    'OpenAI API error 400 Bad Request: {"error":{"message":"Invalid tool arguments for /tmp/reports/main.tex"}}',
    'OpenAI stream returned a mid-stream error: upstream could not open file C:\\service\\cache.json',
    'HTTP 403 Forbidden: permission denied for /srv/uploads/report.pdf',
  ])("does not report a provider failure containing a path as a local file problem: %s", (error) => {
    expect(formatUserFacingError(error)).toBe("服务暂时不可用，请稍后重试。");
  });

  it.each([
    "TypeError: Cannot read properties of undefined\n    at C:\\app\\chat.ts:42:7",
    'failed to parse tool arguments: {"path":"/tmp/reports/main.tex"}',
    "unexpected failure at F:/Research/私人目录/main.tex",
  ])("hides paths without inferring a filesystem failure: %s", (error) => {
    expect(formatUserFacingError(error)).toBe("操作未完成，请稍后重试。");
  });

  it.each([
    "failed to read F:/Research/main.tex",
    "could not open file /tmp/reports/main.tex",
    "unable to write C:\\Research\\main.tex",
  ])("recognizes an explicit local file operation failure: %s", (error) => {
    expect(formatUserFacingError(error)).toBe("无法访问本地文件，请检查文件是否存在及访问权限。");
  });

  it.each([
    "file does not exist: F:/Research/report.docx",
    "ENOENT: no such file or directory, open '/tmp/reports/report.docx'",
    "系统找不到指定的路径。 (os error 3)",
  ])("explains a missing local file: %s", (error) => {
    expect(formatUserFacingError(error)).toBe("本地文件或目录不存在，可能已被移动或删除，请重新选择后重试。");
    expect(formatUserFacingError(error, "en")).toBe("The local file or folder was not found. It may have been moved or deleted; select it again and retry.");
  });

  it.each([
    "EACCES: permission denied, open '/tmp/reports/report.docx'",
    "Access is denied. (os error 5)",
    "Permission denied: F:/Research/report.docx",
  ])("explains a local permission failure: %s", (error) => {
    expect(formatUserFacingError(error)).toBe("没有访问该本地文件或目录的权限，请检查权限或选择可访问的位置。");
    expect(formatUserFacingError(error, "en")).toBe("You do not have permission to access this local file or folder. Check its permissions or select an accessible location.");
  });

  it.each([
    "The process cannot access the file because it is being used by another process. (os error 32)",
    "EBUSY: resource busy or locked, open 'F:/Research/report.docx'",
  ])("explains a file lock without suggesting a permission change: %s", (error) => {
    expect(formatUserFacingError(error)).toBe("本地文件正被其他程序占用，请关闭占用它的程序后重试。");
    expect(formatUserFacingError(error, "en")).toBe("The local file is in use by another program. Close that program and retry.");
  });

  it("keeps short, safe validation feedback", () => {
    expect(formatUserFacingError("文件名不能为空")).toBe("文件名不能为空");
    expect(formatUserFacingError("invalid folder name", "en")).toBe("invalid folder name");
  });
});
