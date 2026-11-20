import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Level } from "level";
import { WebSocketServer } from "ws";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("list_chats applies its default limit when MCP arguments are empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "mtslink-server-test-"));
  const profilePath = join(root, "profile");
  const storagePath = join(profilePath, "Session Storage");
  await mkdir(storagePath, { recursive: true });
  const db = new Level(storagePath, { keyEncoding: "buffer", valueEncoding: "buffer" });
  await db.open();
  await db.put(Buffer.from("map-0-gw_token"), Buffer.from(JSON.stringify("test-token"), "utf16le"));
  await db.close();

  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => gateway.once("listening", resolve));
  let requestBody;
  gateway.on("connection", (socket) => {
    socket.send(JSON.stringify({ control: { name: "open", param: {} }, seq: 0, ack: 0 }));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.control?.name === "token") {
        socket.send(JSON.stringify({ control: { name: "setTokenResp", param: {} }, seq: 0, ack: 0 }));
      }
      if (message.messages) {
        const request = message.messages[0];
        requestBody = request.param;
        socket.send(JSON.stringify({
          messages: [{
            id: request.id,
            result: { type: "DialogAndGroupChatsList", value: { items: [], memberProfiles: [] } },
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
  } finally {
    await client.close();
    await new Promise((resolve) => gateway.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
