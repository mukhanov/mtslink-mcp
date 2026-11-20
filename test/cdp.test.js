import test from "node:test";
import assert from "node:assert/strict";
import { chatRpcExpression, loginExpression, unwrapChatRpc } from "../src/cdp.js";

const evaluate = (expression, ...args) => new Function(
  "globalThis",
  "window",
  "performance",
  "fetch",
  `return (${expression})`,
)(...args);

test("Chat RPC calls the app's native service with the pagination body", async () => {
  const calls = [];
  const sandbox = {};
  sandbox[Symbol.for("mtslink-mcp.chatService")] = {
    getMessagesV2: async (body) => {
      calls.push(body);
      return { __typename: "MessagesV2", messages: [{ id: "message-1", text: "hello" }], memberProfiles: [] };
    },
  };
  const expression = chatRpcExpression("Chat.GetMessagesV2", {
    chatId: "chat-1",
    limit: 50,
    from: "message-2",
    direction: "Before",
    orEqual: false,
    parentId: undefined,
  });
  const serialized = await evaluate(expression, sandbox);

  assert.deepEqual(calls, [{
    chatId: "chat-1",
    limit: 50,
    from: "message-2",
    direction: "Before",
    orEqual: false,
  }]);
  assert.deepEqual(JSON.parse(serialized), {
    __typename: "MessagesV2",
    messages: [{ id: "message-1", text: "hello" }],
    memberProfiles: [],
  });
});

test("Chat RPC discovers the service from loaded application modules", async () => {
  const hostModule = `data:text/javascript,${encodeURIComponent(`
    const service = {
      getMessagesV2() {},
      getMyDialogsAndGroupChatsV3: async () => ({ __typename: "DialogAndGroupChatsList", items: [], memberProfiles: [] }),
    };
    export const C = { host: { services: { get: (name) => name === "chat" ? service : null } } };
  `)}`;
  const source = `import{C as host}from"${hostModule}"; Chat.GetMyDialogsAndGroupChatsV3; Chat.GetMessagesV2;`;
  const performance = { getEntriesByType: () => [{ name: "https://cdn.example/mf-host-orchestrator/release/client.js" }] };
  const fetch = async () => ({ ok: true, text: async () => source });
  const serialized = await evaluate(
    chatRpcExpression("Chat.GetMyDialogsAndGroupChatsV3", { limit: 10 }),
    {}, {}, performance, fetch,
  );
  assert.deepEqual(JSON.parse(serialized), { __typename: "DialogAndGroupChatsList", items: [], memberProfiles: [] });
});

test("Chat RPC rejects oversized and error responses", async () => {
  const sandbox = {};
  sandbox[Symbol.for("mtslink-mcp.chatService")] = {
    getMessagesV2: async () => ({ __typename: "MessagesV2", messages: [{ text: "too large" }] }),
  };
  await assert.rejects(
    evaluate(chatRpcExpression("Chat.GetMessagesV2", { limit: 50 }, 20), sandbox),
    /reduce the requested limit/,
  );

  assert.throws(() => unwrapChatRpc({
    __typename: "AccessDeniedError",
    message: "Access denied",
  }, "MessagesV2"), /AccessDeniedError: Access denied/);
});

test("login returns basic account details without exposing the full API response", async () => {
  const response = await evaluate(loginExpression(), {},
    { _env_: { HTTPS_SERVER_URL: "https://gw.mts-link.ru" } }, {},
    async () => ({
      status: 200,
      ok: true,
      json: async () => ({ id: 42, uid: "user-id", nickname: "Test User", type: "USER", privateField: "omitted" }),
    }));
  assert.deepEqual(response, {
    authenticated: true,
    user: { id: 42, uid: "user-id", nickname: "Test User", type: "USER" },
  });
});

test("login reports a signed-out session without throwing", async () => {
  const response = await evaluate(loginExpression(), {},
    { _env_: { HTTPS_SERVER_URL: "https://gw.mts-link.ru" } }, {},
    async () => ({ status: 401, ok: false }));
  assert.deepEqual(response, { authenticated: false, reason: "Sign in to MTS Link, then try again" });
});
