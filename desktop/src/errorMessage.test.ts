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

  it("does not leak paths or credentials from otherwise unknown failures", () => {
    expect(formatUserFacingError("failed to write C:\\Users\\name\\secret.txt")).toBe("无法访问本地文件，请检查文件是否存在及访问权限。");
    expect(formatUserFacingError("request failed: Authorization: Bearer sk-secret-value")).toBe("服务暂时不可用，请稍后重试。");
    expect(formatUserFacingError("malformed response from gateway.internal")).toBe("服务暂时不可用，请稍后重试。");
  });

  it("keeps short, safe validation feedback", () => {
    expect(formatUserFacingError("文件名不能为空")).toBe("文件名不能为空");
    expect(formatUserFacingError("invalid folder name", "en")).toBe("invalid folder name");
  });
});
