import { Level } from "level";
import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PROFILE_PATH = join(homedir(), "Library/Application Support/LinkChats");
const SNAPSHOT_PREFIX = "mtslink-mcp-session-";
const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;

export async function cleanupSessionSnapshots({
  tempDirectory = tmpdir(),
  maxAgeMs = SNAPSHOT_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  let entries;
  try {
    entries = await readdir(tempDirectory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SNAPSHOT_PREFIX)) continue;
    const path = join(tempDirectory, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return removed;
}


function parseStoredString(value) {
  const encodings = [
    value[0] === 1 ? value.subarray(1).toString("utf8") : value.toString("utf8"),
    value[0] === 0 ? value.subarray(1).toString("utf16le") : value.toString("utf16le"),
  ];
  for (const text of encodings) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string" && parsed) return parsed;
    } catch {}
  }
  return null;
}

async function withStorageSnapshot(profilePath, relativePath, reader) {
  const tempRoot = await mkdtemp(join(tmpdir(), "mtslink-mcp-session-"));
  const snapshotPath = join(tempRoot, "storage");
  try {
    await cp(join(profilePath, relativePath), snapshotPath, { recursive: true });
    const db = new Level(snapshotPath, {
      keyEncoding: "buffer",
      valueEncoding: "buffer",
      createIfMissing: false,
    });
    await db.open();
    try {
      return await reader(db);
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

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

export async function readSessionToken(profilePath = DEFAULT_PROFILE_PATH) {
  return withStorageSnapshot(profilePath, "Session Storage", async (db) => {
    const tokens = [];
    for await (const [key, value] of db.iterator()) {
      if (!key.toString("utf8").endsWith("-gw_token")) continue;
      const token = parseStoredString(value);
      if (token) tokens.push(token);
    }
    tokens.sort((a, b) => tokenExpiry(b) - tokenExpiry(a));
    return tokens[0] ?? null;
  });
}

export async function readSelectedOrganizationId(profilePath = DEFAULT_PROFILE_PATH) {
  return withStorageSnapshot(profilePath, "Local Storage/leveldb", async (db) => {
    let organizationId = null;
    for await (const [key, value] of db.iterator()) {
      if (!key.toString("utf8").endsWith("selectedOrgId")) continue;
      organizationId = parseStoredString(value) ?? organizationId;
    }
    return organizationId;
  });
}

export async function requireSessionToken(profilePath) {
  const token = await readSessionToken(profilePath);
  if (!token) throw new Error("No active MTS Link session; open MTS Link and sign in");
  return token;
}
