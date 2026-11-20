import test from "node:test";
import assert from "node:assert/strict";
import { apiRequest, login } from "../src/api.js";

test("login returns only basic account fields", async () => {
  let authorization;
  const response = await login("test-token", {
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return {
        status: 200,
        ok: true,
        json: async () => ({ id: 42, uid: "user-id", nickname: "Test User", type: "USER", privateField: "omitted" }),
      };
    },
  });
  assert.equal(authorization, "Bearer test-token");
  assert.deepEqual(response, {
    authenticated: true,
    user: { id: 42, uid: "user-id", nickname: "Test User", type: "USER" },
  });
});

test("login reports missing and expired sessions without throwing", async () => {
  assert.deepEqual(await login(null), {
    authenticated: false,
    reason: "Open MTS Link and sign in, then try again",
  });
  assert.deepEqual(await login("expired", {
    fetchImpl: async () => ({ status: 401, ok: false }),
  }), {
    authenticated: false,
    reason: "MTS Link session expired; open MTS Link and sign in again",
  });
});

test("API requests use bearer authentication and reject foreign origins", async () => {
  let request;
  const response = await apiRequest({
    path: "/api/login",
    base: "gateway",
    method: "GET",
    query: { full: false },
    maxResponseChars: 1000,
  }, "test-token", {
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return {
        status: 200,
        statusText: "OK",
        url: String(url),
        headers: new Headers({ "Content-Type": "application/json" }),
        text: async () => JSON.stringify({ id: 42 }),
      };
    },
  });
  assert.equal(request.url, "https://gw.mts-link.ru/api/login?full=false");
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.deepEqual(response.body, { id: 42 });
  await assert.rejects(apiRequest({
    path: "https://example.com/steal",
    base: "gateway",
    method: "GET",
  }, "test-token"), /not an MTS Link service/);
});
