import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Level } from "level";
import { cleanupSessionSnapshots, readSelectedOrganizationId, readSessionToken } from "../src/session.js";

function tokenWithExpiry(exp) {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

test("session reader finds the newest token in a Chromium session database", async () => {
  const root = await mkdtemp(join(tmpdir(), "mtslink-session-test-"));
  const profilePath = join(root, "profile");
  const storagePath = join(profilePath, "Session Storage");
  try {
    await mkdir(storagePath, { recursive: true });
    const db = new Level(storagePath, { keyEncoding: "buffer", valueEncoding: "buffer" });
    await db.open();
    const oldToken = tokenWithExpiry(100);
    const currentToken = tokenWithExpiry(200);
    await db.put(Buffer.from("map-0-gw_token"), Buffer.from(JSON.stringify(oldToken), "utf16le"));
    await db.put(Buffer.from("map-1-gw_token"), Buffer.from(JSON.stringify(currentToken), "utf16le"));
    await db.close();
    assert.equal(await readSessionToken(profilePath), currentToken);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session reader decodes the selected organization from local storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "mtslink-organization-test-"));
  const profilePath = join(root, "profile");
  const storagePath = join(profilePath, "Local Storage/leveldb");
  try {
    await mkdir(storagePath, { recursive: true });
    const db = new Level(storagePath, { keyEncoding: "buffer", valueEncoding: "buffer" });
    await db.open();
    const key = Buffer.from("_https://my.mts-link.ru\0\x01selectedOrgId", "utf8");
    const value = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify("org-1"), "utf8")]);
    await db.put(key, value);
    await db.close();
    assert.equal(await readSelectedOrganizationId(profilePath), "org-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot cleanup removes only old MCP-owned directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "mtslink-cleanup-test-"));
  try {
    const stale = join(root, "mtslink-mcp-session-stale1");
    await mkdir(stale);
    await mkdir(join(root, "mtslink-mcp-session-fresh1"));
    await mkdir(join(root, "unrelated-directory"));
    const oldTime = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    await utimes(stale, oldTime, oldTime);
    assert.equal(await cleanupSessionSnapshots({ tempDirectory: root }), 1);
    assert.deepEqual((await readdir(root)).sort(), [
      "mtslink-mcp-session-fresh1",
      "unrelated-directory",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session reader reports an absent profile as signed out", async () => {
  assert.equal(await readSessionToken(join(tmpdir(), "mtslink-absent-profile")), null);
});
