import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const MAX_REQUEST_BODY_BYTES = 128 * 1024;
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function response(statusCode, body, headers = {}) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function normalizedPath(path) {
  const value = (path || "/").replace(/\\/g, "/");
  return value.startsWith("/") ? value : `/${value}`;
}

function rawBodySize(body) {
  return Buffer.byteLength(body || "", "utf8");
}

function proxyRequest(target, method, headers, body) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const request = client.request(target, { method, headers, timeout: REQUEST_TIMEOUT_MS }, (upstream) => {
      const chunks = [];
      let size = 0;
      upstream.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BODY_BYTES) {
          request.destroy(new Error("Upstream response exceeded the gateway limit"));
          return;
        }
        chunks.push(chunk);
      });
      upstream.on("end", () => {
        resolve({ statusCode: upstream.statusCode || 502, body: Buffer.concat(chunks).toString("utf8") });
      });
    });

    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Upstream request timed out")));
    if (body) request.write(body);
    request.end();
  });
}

function gatewayUrl(path, query) {
  const target = new URL(`https://api.openalex.org${path}`);
  target.search = query || "";
  const apiKey = process.env.OPENALEX_API_KEY?.trim();
  if (apiKey) target.searchParams.set("api_key", apiKey);
  return target;
}

function openAlexPath(path) {
  if (path === "/openalex" || path === "/openalex/") return "/";
  return path.slice("/openalex".length);
}

function eventQuery(event) {
  const raw = event.rawQueryString ?? event.queryString;
  if (typeof raw === "string") return raw;
  const parameters = event.queryStringParameters ?? raw;
  if (!parameters || typeof parameters !== "object") return "";
  return new URLSearchParams(
    Object.entries(parameters).flatMap(([key, value]) => value == null ? [] : [[key, String(value)]]),
  ).toString();
}

function zhihuQueryFromBody(body) {
  if (!body) return "";
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Zhihu request body must be valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Zhihu request body must be a JSON object");
  }
  const query = payload.Query ?? payload.query;
  const count = payload.Count ?? payload.count;
  const params = new URLSearchParams();
  if (query != null) params.set("Query", String(query));
  if (count != null) params.set("Count", String(count));
  return params.toString();
}

export async function handleRequest(path, method, query = "", body = "") {
  const requestPath = normalizedPath(path);
  const requestMethod = (method || "GET").toUpperCase();
  const requestBody = body || "";

  if (requestMethod === "OPTIONS") return response(204, "", corsHeaders);
  if (requestPath === "/" || requestPath === "/release" || requestPath === "/release/") {
    return response(200, { status: "ok", service: "somniq-research-gateway" });
  }
  if (rawBodySize(requestBody) > MAX_REQUEST_BODY_BYTES) {
    return response(413, { error: "Request body exceeds the gateway limit" });
  }

  try {
    if (requestPath === "/openalex" || requestPath.startsWith("/openalex/")) {
      if (requestMethod !== "GET") return response(405, { error: "OpenAlex accepts GET only" });
      const upstream = await proxyRequest(
        gatewayUrl(openAlexPath(requestPath), query),
        "GET",
        { "User-Agent": "SomniQ-Cloud-Gateway/1.0", Accept: "application/json" },
        null,
      );
      return response(upstream.statusCode, upstream.body);
    }

    if (requestPath === "/bocha") {
      if (requestMethod !== "POST") return response(405, { error: "Bocha accepts POST only" });
      const apiKey = process.env.BOCHA_API_KEY?.trim();
      if (!apiKey) return response(503, { error: "Bocha is not configured on the gateway" });
      const upstream = await proxyRequest(
        new URL("https://api.bochaai.com/v1/web-search"),
        "POST",
        { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        requestBody,
      );
      return response(upstream.statusCode, upstream.body);
    }

    if (requestPath === "/zhihu") {
      if (requestMethod !== "POST") return response(405, { error: "Zhihu accepts POST only" });
      const accessSecret = process.env.ZHIHU_ACCESS_SECRET?.trim();
      if (!accessSecret) return response(503, { error: "Zhihu is not configured on the gateway" });
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const upstream = await proxyRequest(
        new URL(`https://developer.zhihu.com/api/v1/content/zhihu_search?${zhihuQueryFromBody(requestBody)}`),
        "GET",
        {
          Accept: "application/json",
          Authorization: `Bearer ${accessSecret}`,
          "X-Access-Secret": accessSecret,
          "X-Request-Timestamp": timestamp,
        },
        null,
      );
      return response(upstream.statusCode, upstream.body);
    }

    return response(404, { error: "Endpoint not found", path: requestPath });
  } catch (error) {
    return response(502, { error: error instanceof Error ? error.message : "Gateway request failed" });
  }
}

export async function main_handler(event) {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  return handleRequest(
    event.path || event.rawPath || "/",
    event.httpMethod || event.requestContext?.http?.method || "GET",
    eventQuery(event),
    body,
  );
}

export default { main_handler };

// Local development is opt-in. Tencent Serverless imports this module and
// invokes main_handler; it must never create a listener during import.
if (process.env.SOMNIQ_RESEARCH_GATEWAY_LOCAL_SERVER === "1") {
  const port = Number(process.env.PORT || 9000);
  http.createServer(async (request, serverResponse) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await handleRequest(url.pathname, request.method, url.search, Buffer.concat(chunks).toString("utf8"));
    serverResponse.writeHead(result.statusCode, result.headers);
    serverResponse.end(result.body);
  }).listen(port, "0.0.0.0");
}
