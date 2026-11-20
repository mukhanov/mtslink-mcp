import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Level } from "level";
import { readSessionToken } from "../src/session.js";

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

test("session reader reports an absent profile as signed out", async () => {
  assert.equal(await readSessionToken(join(tmpdir(), "mtslink-absent-profile")), null);
});
