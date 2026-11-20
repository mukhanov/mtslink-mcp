import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Level } from "level";
import { WebSocketServer } from "ws";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("MCP tools apply defaults for empty list arguments and query-only search", async () => {
  const root = await mkdtemp(join(tmpdir(), "mtslink-server-test-"));
  const profilePath = join(root, "profile");
  const storagePath = join(profilePath, "Session Storage");
  await mkdir(storagePath, { recursive: true });
  const db = new Level(storagePath, { keyEncoding: "buffer", valueEncoding: "buffer" });
  await db.open();
  await db.put(Buffer.from("map-0-gw_token"), Buffer.from(JSON.stringify("test-token"), "utf16le"));
  await db.close();

  const localStoragePath = join(profilePath, "Local Storage/leveldb");
  await mkdir(localStoragePath, { recursive: true });
  const localDb = new Level(localStoragePath, { keyEncoding: "buffer", valueEncoding: "buffer" });
  await localDb.open();
  await localDb.put(
    Buffer.from("_https://my.mts-link.ru\0\x01selectedOrgId", "utf8"),
    Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify("org-1"), "utf8")]),
  );
  await localDb.close();

  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => gateway.once("listening", resolve));
  let requestBody;
  let searchBody;
  gateway.on("connection", (socket) => {
    socket.send(JSON.stringify({ control: { name: "open", param: {} }, seq: 0, ack: 0 }));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.control?.name === "token") {
        socket.send(JSON.stringify({ control: { name: "setTokenResp", param: {} }, seq: 0, ack: 0 }));
      }
      if (message.messages) {
        const request = message.messages[0];
        const isSearch = request.method === "Chat.SearchMessagesV4";
        if (isSearch) searchBody = request.param;
        else requestBody = request.param;
        socket.send(JSON.stringify({
          messages: [{
            id: request.id,
            result: isSearch
              ? { type: "SearchMessagesV3", value: { items: [], memberProfiles: [], total: 0 } }
              : { type: "DialogAndGroupChatsList", value: { items: [], memberProfiles: [] } },
          }],
          seq: 1,
          ack: 1,
        }));
      }
    });
  });

  const port = gateway.address().port;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.js"],
    env: {
      ...process.env,
      MTSLINK_PROFILE_PATH: profilePath,
      MTSLINK_GATEWAY_WS_URL: `ws://127.0.0.1:${port}/v1`,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mtslink-server-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: "mtslink_list_chats", arguments: {} });
    assert.equal(response.isError, undefined);
    assert.deepEqual(JSON.parse(response.content[0].text), { items: [], memberProfiles: [] });
    assert.deepEqual(requestBody, { limit: 50 });

    const searchResponse = await client.callTool({
      name: "mtslink_search_messages",
      arguments: { query: "СТО" },
    });
    assert.equal(searchResponse.isError, undefined);
    assert.deepEqual(JSON.parse(searchResponse.content[0].text), {
      query: "СТО",
      from: 0,
      size: 20,
      items: [],
      memberProfiles: [],
      total: 0,
    });
    assert.deepEqual(searchBody, {
      query: "СТО",
      organizationId: "org-1",
      from: 0,
      size: 20,
      previewCharsSize: 200,
    });
  } finally {
    await client.close();
    await new Promise((resolve) => gateway.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
