import { sanitizeUrl, validateLoopbackEndpoint } from "./app.js";

const REQUEST_TIMEOUT_MS = 20_000;

async function fetchJson(endpoint, path) {
  const response = await fetch(`${endpoint}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`CDP returned HTTP ${response.status}`);
  return response.json();
}

export async function listTargets(endpointValue) {
  const endpoint = validateLoopbackEndpoint(endpointValue);
  const targets = await fetchJson(endpoint, "/json/list");
  return targets
    .filter((target) => target.type === "page")
    .map((target) => ({
      id: target.id,
      title: target.title,
      url: target.url ? sanitizeUrl(target.url) : null,
    }));
}

class CdpSession {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket connection timed out")), 5000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket connection failed"));
      }, { once: true });
    });
    return new CdpSession(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${message.error.message}`));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed"));
      }
      this.#pending.clear();
    });
  }

  request(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.request("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description;
      throw new Error(description?.split("\n")[0] ?? "Page evaluation failed");
    }
    return response.result?.value;
  }

  close() {
    this.#socket.close();
  }
}

async function selectTarget(endpoint, { targetId, windowType } = {}) {
  const targets = await fetchJson(endpoint, "/json/list");
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (targetId) {
    const target = pages.find((candidate) => candidate.id === targetId);
    if (!target) throw new Error("CDP target not found");
    return target;
  }
  if (windowType) {
    for (const target of pages) {
      const session = await CdpSession.connect(target.webSocketDebuggerUrl);
      try {
        if (await session.evaluate("window.__ELECTRON__?.app?.windowType ?? null") === windowType) {
          return target;
        }
      } finally {
        session.close();
      }
    }
    throw new Error(`No ${windowType} window is open`);
  }
  const target = pages.find((candidate) => candidate.url.includes("/chats"))
    ?? pages.find((candidate) => /^https?:/.test(candidate.url))
    ?? pages[0];
  if (!target) throw new Error("No MTS Link page target found");
  return target;
}

export async function evaluateInApp(endpointValue, expression, options = {}) {
  const endpoint = validateLoopbackEndpoint(endpointValue);
  const target = await selectTarget(endpoint, options);
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    return { targetId: target.id, value: await session.evaluate(expression) };
  } finally {
    session.close();
  }
}

export function apiRequestExpression(request) {
  return `(async (request) => {
    const config = window._env_ ?? {};
    const bases = {
      gateway: config.HTTPS_SERVER_URL,
      webinar: config.WEBINAR_HOST,
      page: location.origin,
      admin: config.ADMIN_API_URL,
    };
    const base = bases[request.base];
    if (!base) throw new Error("The selected API base is unavailable in this window");
    const url = new URL(request.path, base);
    const allowedOrigins = new Set([
      location.origin,
      config.HTTPS_SERVER_URL,
      config.WEBINAR_HOST,
      config.ADMIN_API_URL,
      config.CHAT_URL,
      config.CHAT_REDIRECT_URL,
    ].filter(Boolean).map((value) => new URL(value, location.origin).origin));
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
      throw new Error("API requests require HTTPS except on loopback");
    }
    if (!allowedOrigins.has(url.origin)) throw new Error("API origin is not configured by this MTS Link window");
    if (url.username || url.password) throw new Error("URL credentials are not allowed");
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const hasBody = request.body !== undefined;
    if (hasBody && request.method === "GET") throw new Error("GET requests cannot have a body");
    const response = await fetch(url, {
      method: request.method,
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: hasBody ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: hasBody ? JSON.stringify(request.body) : undefined,
    });
    const text = await response.text();
    const truncated = text.length > request.maxResponseChars;
    const bodyText = truncated ? text.slice(0, request.maxResponseChars) : text;
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
  })(${JSON.stringify(request)})`;
}

export function loginExpression() {
  return `(async () => {
    const base = window._env_?.HTTPS_SERVER_URL;
    if (!base) return { authenticated: false, reason: "MTS Link gateway configuration is unavailable" };
    const response = await fetch(new URL("/api/login", base), {
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) {
      return { authenticated: false, reason: "Sign in to MTS Link, then try again" };
    }
    if (!response.ok) throw new Error("MTS Link login check returned HTTP " + response.status);
    let user = await response.json();
    if (typeof user === "string") user = JSON.parse(user);
    if (!user || typeof user !== "object" || !user.id) {
      throw new Error("MTS Link returned an invalid login response");
    }
    return {
      authenticated: true,
      user: {
        id: user.id,
        uid: user.uid,
        nickname: user.nickname,
        type: user.type,
      },
    };
  })()`;
}

export function chatRpcExpression(method, body, maxResponseChars = 100000) {
  if (!/^Chat\.[A-Za-z0-9]+$/.test(method)) throw new Error("Invalid Chat RPC method");
  const serviceMethod = method.slice(5, 6).toLowerCase() + method.slice(6);
  return `(async () => {
    const cacheKey = Symbol.for("mtslink-mcp.chatService");
    let service = globalThis[cacheKey];
    if (!service) {
      const urls = [...new Set(performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => url.includes("/mf-host-orchestrator/") && url.includes(".js")))];
      for (const url of urls) {
        try {
          const response = await fetch(url);
          if (!response.ok) continue;
          const source = await response.text();
          if (!source.includes("Chat.GetMyDialogsAndGroupChatsV3") || !source.includes("Chat.GetMessagesV2")) continue;
          const imports = [...source.matchAll(/import\s*[^;]*?from\s*["']([^"']+)["']/g)];
          for (const match of imports) {
            const module = await import(new URL(match[1], url).href);
            for (const candidate of Object.values(module)) {
              let found;
              try { found = candidate?.host?.services?.get("chat"); } catch {}
              if (typeof found?.getMessagesV2 === "function" && typeof found?.getMyDialogsAndGroupChatsV3 === "function") {
                service = found;
                break;
              }
            }
            if (service) break;
          }
        } catch {}
        if (service) break;
      }
      if (!service) throw new Error("MTS Link chat service is unavailable; open Chats in the app and try again");
      globalThis[cacheKey] = service;
    }
    const value = await service[${JSON.stringify(serviceMethod)}](${JSON.stringify(body)});
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("MTS Link Chat RPC returned no value");
    if (serialized.length > ${JSON.stringify(maxResponseChars)}) {
      throw new Error("MTS Link API response exceeds maxResponseChars; reduce the requested limit");
    }
    return serialized;
  })()`;
}

export function unwrapChatRpc(response, expectedType) {
  const type = response?.__typename ?? response?.type;
  if (type !== expectedType) {
    const detail = response?.message ?? response?.value?.message;
    const suffix = typeof detail === "string" && detail ? `: ${detail}` : "";
    throw new Error(`MTS Link Chat RPC failed: ${type ?? "unknown response"}${suffix}`);
  }
  return response;
}
