const DEFAULT_GATEWAY_URL = "https://gw.mts-link.ru";
const DEFAULT_WEB_URL = "https://my.mts-link.ru";

function requestUrl(request) {
  const bases = {
    gateway: DEFAULT_GATEWAY_URL,
    webinar: DEFAULT_WEB_URL,
    page: DEFAULT_WEB_URL,
    admin: `${DEFAULT_WEB_URL}/chats/admin/api`,
  };
  const url = new URL(request.path, bases[request.base]);
  const allowedOrigins = new Set([DEFAULT_GATEWAY_URL, DEFAULT_WEB_URL]);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error("API requests require HTTPS except on loopback");
  }
  if (!allowedOrigins.has(url.origin)) throw new Error("API origin is not an MTS Link service");
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function parseResponse(response, maxResponseChars) {
  const text = await response.text();
  const truncated = text.length > maxResponseChars;
  const bodyText = truncated ? text.slice(0, maxResponseChars) : text;
  let body = bodyText;
  if (!truncated && response.headers.get("content-type")?.includes("json")) {
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch {}
  }
  const responseUrl = new URL(response.url);
  responseUrl.search = "";
  responseUrl.hash = "";
  return {
    status: response.status,
    statusText: response.statusText,
    url: responseUrl.toString(),
    contentType: response.headers.get("content-type"),
    body,
    truncated,
  };
}

export async function apiRequest(request, token, { fetchImpl = fetch } = {}) {
  const url = requestUrl(request);
  const hasBody = request.body !== undefined;
  if (hasBody && request.method === "GET") throw new Error("GET requests cannot have a body");
  const response = await fetchImpl(url, {
    method: request.method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(request.body) : undefined,
  });
  return parseResponse(response, request.maxResponseChars);
}

export async function login(token, { fetchImpl = fetch } = {}) {
  if (!token) return { authenticated: false, reason: "Open MTS Link and sign in, then try again" };
  const response = await fetchImpl(`${DEFAULT_GATEWAY_URL}/api/login`, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if ([401, 403, 404].includes(response.status)) {
    return { authenticated: false, reason: "MTS Link session expired; open MTS Link and sign in again" };
  }
  if (!response.ok) throw new Error(`MTS Link login check returned HTTP ${response.status}`);
  let user = await response.json();
  if (typeof user === "string") user = JSON.parse(user);
  if (!user || typeof user !== "object" || !user.id) {
    throw new Error("MTS Link returned an invalid login response");
  }
  return {
    authenticated: true,
    user: { id: user.id, uid: user.uid, nickname: user.nickname, type: user.type },
  };
}
