import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_APP_PATH,
  DEFAULT_CDP_ENDPOINT,
  getAppInfo,
  openApp,
} from "./app.js";
import {
  apiRequestExpression,
  chatRpcExpression,
  evaluateInApp,
  listTargets,
  loginExpression,
  unwrapChatRpc,
} from "./cdp.js";

const appPath = process.env.MTSLINK_APP_PATH ?? DEFAULT_APP_PATH;
const cdpEndpoint = process.env.MTSLINK_CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT;

const server = new McpServer({
  name: "mtslink-mcp",
  version: "0.1.0",
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

async function callChatRpc(method, body, expectedType, { targetId, maxResponseChars }) {
  const response = await evaluateInApp(
    cdpEndpoint,
    chatRpcExpression(method, body, maxResponseChars),
    { targetId },
  );
  return unwrapChatRpc(JSON.parse(response.value), expectedType);
}

server.registerTool(
  "mtslink_app_info",
  {
    description: "Read the installed MTS Link app version and integration defaults.",
    inputSchema: {},
  },
  handle(async () => ({
    ...await getAppInfo(appPath),
    cdpEndpoint,
  })),
);

server.registerTool(
  "mtslink_open",
  {
    description: "Open or focus MTS Link, optionally passing an HTTPS meeting/chat URL or mtslinkchats deep link. This uses the existing app session and does not require CDP.",
    inputSchema: {
      url: z.string().max(8192).optional().describe("Meeting, chat, or mtslinkchats URL"),
    },
  },
  handle(async ({ url }) => openApp({ appPath, url })),
);

server.registerTool(
  "mtslink_list_windows",
  {
    description: "List MTS Link renderer windows through the loopback CDP endpoint. URL query strings and fragments are omitted.",
    inputSchema: {},
  },
  handle(async () => ({ windows: await listTargets(cdpEndpoint) })),
);

server.registerTool(
  "mtslink_login",
  {
    description: "Check the current MTS Link login and return basic account details. Uses the existing app session; no password, cookies, or tokens are requested or extracted.",
    inputSchema: {
      targetId: z.string().optional().describe("Window ID from mtslink_list_windows; defaults to the main chats window"),
    },
  },
  handle(async ({ targetId }) => {
    const response = await evaluateInApp(cdpEndpoint, loginExpression(), { targetId });
    return response.value;
  }),
);

server.registerTool(
  "mtslink_api_request",
  {
    description: "Make an API request inside an MTS Link renderer using its existing cookies. No tokens or cookie values are read. Origins are restricted to the page and its configured MTS Link services.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path such as /api/login, or an HTTPS URL on a configured origin"),
      base: z.enum(["gateway", "webinar", "page", "admin"]).default("gateway"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      body: z.unknown().optional().describe("JSON request body; not allowed for GET"),
      targetId: z.string().optional().describe("Window ID from mtslink_list_windows; defaults to the main chats window"),
      maxResponseChars: z.number().int().min(100).max(100000).default(30000),
    },
  },
  handle(async (args) => {
    const { targetId, ...request } = args;
    const response = await evaluateInApp(
      cdpEndpoint,
      apiRequestExpression(request),
      { targetId },
    );
    return response.value;
  }),
);

server.registerTool(
  "mtslink_list_chats",
  {
    description: "List private and group chats available to the current MTS Link account. Returns chat IDs for mtslink_get_messages.",
    inputSchema: {
      limit: z.number().int().min(1).max(1000).default(100),
      targetId: z.string().optional().describe("Window ID from mtslink_list_windows; defaults to the main chats window"),
      maxResponseChars: z.number().int().min(100).max(100000).default(100000),
    },
  },
  handle(async ({ limit, ...options }) => callChatRpc(
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
      limit: z.number().int().min(1).max(1000).default(100),
      targetId: z.string().optional().describe("Window ID from mtslink_list_windows; defaults to the main chats window"),
      maxResponseChars: z.number().int().min(100).max(100000).default(100000),
    },
  },
  handle(async ({ limit, ...options }) => callChatRpc(
    "Chat.GetMyChannelsV3",
    { limit },
    "ChannelList",
    options,
  )),
);

server.registerTool(
  "mtslink_get_messages",
  {
    description: "Get messages from a private chat, group chat, channel, or thread using the current MTS Link session. Use Before/After with from for pagination, or Around to load context around a message.",
    inputSchema: {
      chatId: z.string().min(1).describe("Chat or channel ID from mtslink_list_chats, mtslink_list_channels, or the chat URL"),
      limit: z.number().int().min(1).max(100).default(50),
      from: z.string().min(1).optional().describe("Message ID to paginate from"),
      direction: z.enum(["Before", "After", "Around"]).optional(),
      orEqual: z.boolean().optional().describe("Include the message specified by from"),
      parentId: z.string().min(1).optional().describe("Parent message ID to read thread replies"),
      targetId: z.string().optional().describe("Window ID from mtslink_list_windows; defaults to the main chats window"),
      maxResponseChars: z.number().int().min(100).max(100000).default(100000),
    },
  },
  handle(async ({ chatId, limit, from, direction, orEqual, parentId, ...options }) => ({
    chatId,
    ...await callChatRpc(
      "Chat.GetMessagesV2",
      { chatId, limit, from, direction, orEqual, parentId },
      "MessagesV2",
      options,
    ),
  })),
);

server.registerTool(
  "mtslink_call_action",
  {
    description: "Accept, decline, or close the currently open MTS Link incoming-call window through the app's verified preload bridge.",
    inputSchema: {
      action: z.enum(["accept", "decline", "close"]),
      targetId: z.string().optional().describe("Specific window ID; otherwise finds the joinCall window"),
    },
  },
  handle(async ({ action, targetId }) => {
    const method = { accept: "accept", decline: "cancel", close: "close" }[action];
    const expression = `(() => {
      const api = window.__ELECTRON__?.joinCall;
      if (!api?.${method}) throw new Error("MTS Link call bridge is unavailable");
      api.${method}();
      return { action: ${JSON.stringify(action)}, completed: true };
    })()`;
    const response = await evaluateInApp(cdpEndpoint, expression, { targetId, windowType: "joinCall" });
    return response.value;
  }),
);

await server.connect(new StdioServerTransport());
