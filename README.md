# MTS Link MCP

Local stdio MCP server for the installed MTS Link macOS desktop app. It uses the app's deep links for navigation and its renderer session for API calls; cookies and tokens are never extracted.

Verified against MTS Link 0.91.0 (build 0.91.0.3140), Electron 44.1.1.

## Install

```sh
npm install
```

Requires Node.js 22.5 or newer and macOS. The default app path is `/Applications/МТС Линк.app`.

MCP client configuration:

```json
{
  "mcpServers": {
    "mtslink": {
      "command": "node",
      "args": ["/absolute/path/to/mtslink/src/server.js"]
    }
  }
}
```

Environment variables:

- `MTSLINK_APP_PATH`: alternate `.app` path.
- `MTSLINK_CDP_ENDPOINT`: loopback CDP endpoint; default `http://127.0.0.1:9222`.

## Enable renderer tools

`mtslink_app_info` and `mtslink_open` work without CDP. Window, API, chat-reading, and call tools require the app to be running with remote debugging enabled.

Fully quit MTS Link before launching it with the flag; its single-instance lock otherwise drops the flag from a second launch.

```sh
'/Applications/МТС Линк.app/Contents/MacOS/МТС Линк' \
  --remote-debugging-port=9222
```

This exposes a local debugging interface. Keep it on loopback and do not expose port 9222 to other hosts.

## Tools

| Tool | Purpose | CDP required |
|---|---|---|
| `mtslink_app_info` | Installed version, bundle ID, workspace, and integration defaults | No |
| `mtslink_open` | Open/focus the app or dispatch a meeting/chat/deep-link URL | No |
| `mtslink_login` | Check the existing session and return basic current-account details | Yes |
| `mtslink_list_windows` | List renderer targets; strips URL queries and fragments | Yes |
| `mtslink_api_request` | Authenticated JSON/text request using the app's existing session | Yes |
| `mtslink_list_chats` | List private and group chats with their chat IDs | Yes |
| `mtslink_list_channels` | List channels with IDs accepted as `chatId` | Yes |
| `mtslink_get_messages` | Read messages from a private chat, group chat, channel, or thread | Yes |
| `mtslink_call_action` | Accept, decline, or close an open incoming-call window | Yes |

API example:

```json
{
  "path": "/api/login",
  "base": "gateway",
  "method": "GET"
}
```

Supported bases are `gateway` (`HTTPS_SERVER_URL`), `webinar` (`WEBINAR_HOST`), `page` (current origin), and `admin` (`ADMIN_API_URL`). Absolute request URLs must use one of those configured origins. HTTPS is required except for loopback development endpoints. Generic `POST`, `PUT`, `PATCH`, and `DELETE` requests can perform real account mutations.

## Read chats and channels

Use `mtslink_list_chats` or `mtslink_list_channels` to obtain an ID, then pass it as `chatId` to `mtslink_get_messages`:

```json
{
  "chatId": "CHAT_OR_CHANNEL_ID",
  "limit": 50
}
```

For older messages, pass the first returned message ID as `from` with `direction: "Before"`. Use `direction: "After"` for newer messages and `orEqual: true` to include the boundary message. For thread replies, pass the parent message ID as `parentId`.

These operations use the read-only RPC methods `Chat.GetMyDialogsAndGroupChatsV3`, `Chat.GetMyChannelsV3`, and `Chat.GetMessagesV2`. They return the API's message and member-profile fields without extracting session credentials.

## Verification

```sh
npm test
```

REA static analysis established the Electron preload bridge, deep-link dispatch, default `my.mts-link.ru` workspace, and gateway configuration flow. Runtime smoke testing verified the dedicated login check, chat and channel lists, and message pagination through the app's native services. The packaged app loads most product UI remotely, so the static endpoint inventory is not a complete MTS Link API specification.
