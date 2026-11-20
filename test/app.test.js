import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeUrl, validateDeepLink } from "../src/app.js";

test("returned URLs remove credentials, query strings, and fragments", () => {
  assert.equal(
    sanitizeUrl("https://user:secret@my.mts-link.ru/j/123?jwt=secret#media"),
    "https://my.mts-link.ru/j/123",
  );
});

test("deep links accept only app-supported protocols", () => {
  assert.equal(validateDeepLink("mtslinkchats://join?eventId=1"), "mtslinkchats://join?eventId=1");
  assert.equal(validateDeepLink("https://my.mts-link.ru/j/123"), "https://my.mts-link.ru/j/123");
  assert.throws(() => validateDeepLink("file:///etc/passwd"), /https, http, or mtslinkchats/);
  assert.throws(() => validateDeepLink("https://user:secret@my.mts-link.ru/j/123"), /credentials/);
});

