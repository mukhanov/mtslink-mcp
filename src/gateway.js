import { randomUUID } from "node:crypto";

export const DEFAULT_GATEWAY_WS_URL = "wss://prod-ws-chat.mts-link.ru/v1";
const REQUEST_TIMEOUT_MS = 20_000;

function gatewayError(error) {
  if (error?.name === "invalidToken") {
    return new Error("MTS Link session expired; open MTS Link and sign in again");
  }
  return new Error(`MTS Link gateway error: ${error?.message ?? error?.name ?? "unknown error"}`);
}

export async function gatewayCall(method, param, {
  token,
  endpoint = DEFAULT_GATEWAY_WS_URL,
  WebSocketImpl = WebSocket,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!/^Chat\.[A-Za-z0-9]+$/.test(method)) throw new Error("Invalid Chat RPC method");
  if (!token) throw new Error("An MTS Link session token is required");
  const url = new URL(endpoint);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error("MTS Link gateway must use WSS except on loopback");
  }
  url.searchParams.set("p", "desktop-mac");
  url.searchParams.set("v", "0.91.0-1.0.0");

  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const id = randomUUID();
    let settled = false;
    let acknowledgement = 0;
    const timer = setTimeout(() => finish(new Error(`MTS Link ${method} timed out`)), timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    }

    function sendRequest() {
      socket.send(JSON.stringify({
        messages: [{ id, dst: "chat", method, param, kind: "command", seq: 1 }],
        seq: 1,
        ack: acknowledgement,
      }));
    }

    socket.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        finish(new Error("MTS Link gateway returned invalid JSON"));
        return;
      }
      if (typeof data.seq === "number") acknowledgement = data.seq;
      if (data.control?.name === "open") {
        socket.send(JSON.stringify({
          control: { name: "token", param: { token } },
          seq: 0,
          ack: data.seq ?? 0,
        }));
        return;
      }
      if (data.control?.name === "setTokenResp") {
        if (data.control.param?.error) finish(gatewayError(data.control.param.error));
        else sendRequest();
        return;
      }
      const response = data.messages?.find((message) => message.id === id);
      if (!response) return;
      if (response.error) finish(gatewayError(response.error));
      else finish(null, response.result);
    });
    socket.addEventListener("error", () => finish(new Error("MTS Link gateway connection failed")));
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("MTS Link gateway connection closed"));
    });
  });
}

export function unwrapChatRpc(response, expectedType) {
  const type = response?.type ?? response?.__typename;
  if (type !== expectedType) {
    const detail = response?.value?.message ?? response?.message;
    const suffix = typeof detail === "string" && detail ? `: ${detail}` : "";
    throw new Error(`MTS Link Chat RPC failed: ${type ?? "unknown response"}${suffix}`);
  }
  const value = response.value ?? response;
  if (["DialogAndGroupChatsList", "ChannelList"].includes(expectedType) && Array.isArray(value.items)) {
    return {
      ...value,
      items: value.items.map((item) => item?.type && item.value
        ? { __typename: item.type, ...item.value }
        : item),
    };
  }
  return value;
}
