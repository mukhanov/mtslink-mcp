# MTS Link MCP

Local stdio MCP server for MTS Link on macOS. It uses the desktop app's existing session for direct HTTPS and WebSocket API calls. No remote debugging port, browser automation, or password input is required.

Verified against MTS Link 0.91.0 (build 0.91.0.3140).

## Install and run

Requires Node.js 22.5 or newer, macOS, and an installed MTS Link app. Open MTS Link and sign in before using authenticated tools. The app does not need any launch flags.

The package is not currently published to npm. Run it from a local checkout:

```sh
git clone https://github.com/mukhanov/mtslink-mcp.git
cd mtslink-mcp
npm install
```

MCP client configuration:

```json
{
  "mcpServers": {
    "mtslink": {
      "command": "node",
      "args": ["/absolute/path/to/mtslink-mcp/src/server.js"]
    }
  }
}
```

Restart the MCP client after changing its configuration.

Environment variables:

- `MTSLINK_APP_PATH`: alternate `.app` path; default `/Applications/МТС Линк.app`.
- `MTSLINK_PROFILE_PATH`: alternate app profile; default `~/Library/Application Support/LinkChats`.
- `MTSLINK_GATEWAY_WS_URL`: alternate gateway; default `wss://prod-ws-chat.mts-link.ru/v1`.

## Tools

| Tool | Purpose |
|---|---|
| `mtslink_app_info` | Installed version, bundle ID, workspace, and integration defaults |
| `mtslink_open` | Open/focus the app or dispatch a meeting/chat/deep-link URL |
| `mtslink_login` | Check the saved session and return basic current-account details |
| `mtslink_api_request` | Authenticated JSON/text HTTPS request to MTS Link services |
| `mtslink_list_chats` | List private and group chats with their chat IDs |
| `mtslink_list_channels` | List channels with IDs accepted as `chatId` |
| `mtslink_search_messages` | Search messages across the selected organization or within one chat |
| `mtslink_get_messages` | Read messages from a private chat, group chat, channel, or thread |

API example:

```json
{
  "path": "/api/login",
  "base": "gateway",
  "method": "GET"
}
```

Supported bases are `gateway`, `webinar`, `page`, and `admin`. Absolute request URLs must use an MTS Link origin. HTTPS is required except for loopback development endpoints. Generic `POST`, `PUT`, `PATCH`, and `DELETE` requests can perform real account mutations.

## Session handling

The server reads `gw_token` from a temporary copy of the app's Chromium `Session Storage` database. The token is used only in memory for the current request, is never included in tool results or logs, and the temporary database copy is deleted immediately afterward.

If the session is absent or expired, `mtslink_login` returns `authenticated: false`. Open MTS Link and sign in again to refresh it.

## Search messages

Only `query` is required. The server uses the organization currently selected in MTS Link:

```json
{
  "query": "SEARCH_TEXT",
  "size": 20
}
```

Use `chatId` to restrict results to one chat or channel. For the next page, pass `from` equal to the previous offset plus the number of requested results, for example `from: 20, size: 20`. The response includes `items`, `memberProfiles`, and `total`.

## Read chats and channels

Use `mtslink_list_chats` or `mtslink_list_channels` to obtain an ID, then pass it as `chatId` to `mtslink_get_messages`:

```json
{
  "chatId": "CHAT_OR_CHANNEL_ID",
  "limit": 50
}
```

For older messages, pass the first returned message ID as `from` with `direction: "Before"`. Use `direction: "After"` for newer messages and `orEqual: true` to include the boundary message. For thread replies, pass the parent message ID as `parentId`.

These operations use the read-only RPC methods `Chat.GetMyDialogsAndGroupChatsV3`, `Chat.GetMyChannelsV3`, and `Chat.GetMessagesV2` over the MTS Link gateway WebSocket.

## Verification

```sh
npm test
```

Runtime smoke testing covers direct login, chat and channel lists, and message reading with the desktop app running normally without remote debugging.
