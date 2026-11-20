import { Level } from "level";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PROFILE_PATH = join(homedir(), "Library/Application Support/LinkChats");

function parseTokenValue(value) {
  const encodings = [
    value.toString("utf16le"),
    value[0] === 1 ? value.subarray(1).toString("utf8") : value.toString("utf8"),
  ];
  for (const text of encodings) {
    try {
      const token = JSON.parse(text);
      if (typeof token === "string" && token) return token;
    } catch {}
  }
  return null;
}

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

export async function readSessionToken(profilePath = DEFAULT_PROFILE_PATH) {
  const tempRoot = await mkdtemp(join(tmpdir(), "mtslink-mcp-session-"));
  const snapshotPath = join(tempRoot, "Session Storage");
  try {
    await cp(join(profilePath, "Session Storage"), snapshotPath, { recursive: true });
    const db = new Level(snapshotPath, {
      keyEncoding: "buffer",
      valueEncoding: "buffer",
      createIfMissing: false,
    });
    await db.open();
    try {
      const tokens = [];
      for await (const [key, value] of db.iterator()) {
        if (!key.toString("utf8").endsWith("-gw_token")) continue;
        const token = parseTokenValue(value);
        if (token) tokens.push(token);
      }
      tokens.sort((a, b) => tokenExpiry(b) - tokenExpiry(a));
      return tokens[0] ?? null;
    } finally {
      await db.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Cannot read the MTS Link session; open MTS Link and sign in again");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function requireSessionToken(profilePath) {
  const token = await readSessionToken(profilePath);
  if (!token) throw new Error("No active MTS Link session; open MTS Link and sign in");
  return token;
}
