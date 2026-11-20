#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_APP_PATH, getAppInfo, openApp } from "./app.js";
import { apiRequest, login } from "./api.js";
import { DEFAULT_GATEWAY_WS_URL, gatewayCall, unwrapChatRpc } from "./gateway.js";
import { cleanupSessionSnapshots, DEFAULT_PROFILE_PATH, readSelectedOrganizationId, readSessionToken, requireSessionToken } from "./session.js";

const appPath = process.env.MTSLINK_APP_PATH ?? DEFAULT_APP_PATH;
const profilePath = process.env.MTSLINK_PROFILE_PATH ?? DEFAULT_PROFILE_PATH;
const gatewayEndpoint = process.env.MTSLINK_GATEWAY_WS_URL ?? DEFAULT_GATEWAY_WS_URL;

const server = new McpServer({
  name: "mtslink-mcp",
  version: "0.2.0",
});

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function handle(handler) {
  return async (args) => {
    try {
      return result(await handler(args));
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        }],
      };
    }
  };
}

async function callChatRpc(method, body, expectedType, { maxResponseChars = 100000 } = {}) {
  const token = await requireSessionToken(profilePath);
  const response = await gatewayCall(method, body, { token, endpoint: gatewayEndpoint });
  const value = unwrapChatRpc(response, expectedType);
  if (JSON.stringify(value).length > maxResponseChars) {
    throw new Error("MTS Link API response exceeds maxResponseChars; reduce the requested limit");
  }
  return value;
}

server.registerTool(
  "mtslink_app_info",
  {
    description: "Read the installed MTS Link app version and integration defaults.",
    inputSchema: {},
  },
  handle(async () => ({
    ...await getAppInfo(appPath),
    profilePath,
  })),
);

server.registerTool(
  "mtslink_open",
  {
    description: "Open or focus MTS Link, optionally passing an HTTPS meeting/chat URL or mtslinkchats deep link.",
    inputSchema: {
      url: z.string().max(8192).optional().describe("Meeting, chat, or mtslinkchats URL"),
    },
  },
  handle(async ({ url }) => openApp({ appPath, url })),
);

server.registerTool(
  "mtslink_login",
  {
    description: "Check the current MTS Link login using the desktop app's saved session. No password is requested and tokens are never returned.",
    inputSchema: {},
  },
  handle(async () => login(await readSessionToken(profilePath))),
);

server.registerTool(
  "mtslink_api_request",
  {
    description: "Make an authenticated HTTP request to an MTS Link service using the desktop app's saved session. Tokens are never returned.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path such as /api/login, or an HTTPS URL on an MTS Link origin"),
      base: z.enum(["gateway", "webinar", "page", "admin"]).default("gateway"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      body: z.unknown().optional().describe("JSON request body; not allowed for GET"),
      maxResponseChars: z.number().int().min(100).max(100000).default(30000),
    },
  },
  handle(async (request) => apiRequest({
    base: "gateway",
    method: "GET",
    maxResponseChars: 30000,
    ...request,
  }, await requireSessionToken(profilePath))),
);

server.registerTool(
  "mtslink_list_chats",
  {
    description: "List private and group chats available to the current MTS Link account. Returns chat IDs for mtslink_get_messages.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(50),
      maxResponseChars: z.number().int().min(100).max(100000).default(100000),
    },
  },
  handle(async ({ limit = 50, ...options }) => callChatRpc(
    "Chat.GetMyDialogsAndGroupChatsV3",
    { limit },
    "DialogAndGroupChatsList",
    options,
  )),
);

server.registerTool(
  "mtslink_list_channels",
  {
    description: "List channels available to the current MTS Link account. Channel IDs are used as chatId in mtslink_get_messages.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(50),
      maxResponseChars: z.number().int().min(100).max(100000).default(100000),
    },
  },
  handle(async ({ limit = 50, ...options }) => callChatRpc(
    "Chat.GetMyChannelsV3",
    { limit },
    "ChannelList",
    options,
  )),
);

server.registerTool(
  "mtslink_search_messages",
  {
    description: "Search messages in the current MTS Link organization. Optionally restrict results to one chat. Use from and size for offset pagination.",
    inputSchema: {
      query: z.string().min(1).max(500).describe("Text to find in messages"),
      chatId: z.string().min(1).optional().describe("Restrict search to this chat or channel"),
      organizationId: z.string().min(1).optional().describe("Organization ID; defaults to the currently selected organization"),
      from: z.number().int().min(0).default(0).describe("Result offset; use 0 for the first page"),
      size: z.number().int().min(1).max(50).default(20).describe("Number of results per page"),
      maxResponseChars: z.number().int().min(100).max(100000).default(100000),
    },
  },
  handle(async ({ query, chatId, organizationId, from = 0, size = 20, ...options }) => {
    const organization = organizationId ?? await readSelectedOrganizationId(profilePath);
    if (!organization) throw new Error("No MTS Link organization is selected; pass organizationId explicitly");
    return {
      query,
      from,
      size,
      ...await callChatRpc(
        "Chat.SearchMessagesV4",
        { query, organizationId: organization, from, size, chatId, previewCharsSize: 200 },
        "SearchMessagesV3",
        options,
      ),
    };
  }),
);

server.registerTool(
  "mtslink_get_messages",
  {
    description: "Get messages from a private chat, group chat, channel, or thread. Use Before/After with from for pagination, or Around to load context around a message.",
    inputSchema: {
      chatId: z.string().min(1).describe("Chat or channel ID from mtslink_list_chats, mtslink_list_channels, or the chat URL"),
      limit: z.number().int().min(1).max(100).default(50),
      from: z.string().min(1).optional().describe("Message ID to paginate from"),
      direction: z.enum(["Before", "After", "Around"]).optional(),
      orEqual: z.boolean().optional().describe("Include the message specified by from"),
      parentId: z.string().min(1).optional().describe("Parent message ID to read thread replies"),
      maxResponseChars: z.number().int().min(100).max(100000).default(100000),
    },
  },
  handle(async ({ chatId, limit = 50, from, direction, orEqual, parentId, ...options }) => ({
    chatId,
    ...await callChatRpc(
      "Chat.GetMessagesV2",
      { chatId, limit, from, direction, orEqual, parentId },
      "MessagesV2",
      options,
    ),
  })),
);

await cleanupSessionSnapshots();
await server.connect(new StdioServerTransport());
