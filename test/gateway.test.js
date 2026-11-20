import test from "node:test";
import assert from "node:assert/strict";
import { gatewayCall, unwrapChatRpc } from "../src/gateway.js";

class FakeWebSocket {
  static sent = [];
  static response = { type: "DialogAndGroupChatsList", value: { items: [{ type: "Dialog", value: { chatId: "chat-1" } }], memberProfiles: [] } };
  #listeners = new Map();

  constructor(url) {
    this.url = url;
    queueMicrotask(() => this.#emit("message", {
      data: JSON.stringify({ control: { name: "open", param: {} }, seq: 0, ack: 0 }),
    }));
  }

  addEventListener(name, listener) {
    this.#listeners.set(name, listener);
  }

  #emit(name, event) {
    this.#listeners.get(name)?.(event);
  }

  send(text) {
    const message = JSON.parse(text);
    FakeWebSocket.sent.push(message);
    if (message.control?.name === "token") {
      queueMicrotask(() => this.#emit("message", {
        data: JSON.stringify({ control: { name: "setTokenResp", param: {} }, seq: 0, ack: 0 }),
      }));
    }
    if (message.messages) {
      const request = message.messages[0];
      queueMicrotask(() => this.#emit("message", {
        data: JSON.stringify({ messages: [{ id: request.id, result: FakeWebSocket.response }] }),
      }));
    }
  }

  close() {}
}

test("gateway authenticates the saved session and sends chat RPC over WebSocket", async () => {
  FakeWebSocket.sent = [];
  const result = await gatewayCall("Chat.GetMyDialogsAndGroupChatsV3", { limit: 10 }, {
    token: "test-token",
    endpoint: "ws://127.0.0.1:9222/v1",
    WebSocketImpl: FakeWebSocket,
  });
  assert.equal(result.type, "DialogAndGroupChatsList");
  assert.equal(FakeWebSocket.sent[0].control.name, "token");
  assert.equal(FakeWebSocket.sent[0].control.param.token, "test-token");
  assert.equal(FakeWebSocket.sent[1].messages[0].method, "Chat.GetMyDialogsAndGroupChatsV3");
  assert.deepEqual(FakeWebSocket.sent[1].messages[0].param, { limit: 10 });
  assert.deepEqual(unwrapChatRpc(result, "DialogAndGroupChatsList"), {
    items: [{ __typename: "Dialog", chatId: "chat-1" }],
    memberProfiles: [],
  });
});

test("gateway rejects non-MTS token destinations", async () => {
  await assert.rejects(gatewayCall("Chat.GetMyDialogsAndGroupChatsV3", { limit: 1 }, {
    token: "test-token",
    endpoint: "wss://example.com/v1",
    WebSocketImpl: FakeWebSocket,
  }), /WSS on mts-link.ru/);
});

test("gateway rejects unexpected RPC result types", () => {
  assert.throws(() => unwrapChatRpc({
    type: "AccessDeniedError",
    value: { message: "Access denied" },
  }, "MessagesV2"), /AccessDeniedError: Access denied/);
});
