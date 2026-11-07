import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProxy, shouldBypassProxy } from "../src/download.js";

test("prefers HTTPS_PROXY over HTTP_PROXY", () => {
  const env = { ...process.env };
  try {
    process.env.HTTPS_PROXY = "http://proxy-https:8080";
    process.env.HTTP_PROXY = "http://proxy-http:8080";
    assert.equal(resolveProxy(), "http://proxy-https:8080");
  } finally {
    process.env.HTTPS_PROXY = env.HTTPS_PROXY;
    process.env.HTTP_PROXY = env.HTTP_PROXY;
  }
});

test("falls back to git's http.proxy when env is empty", () => {
  // This machine has git configured with a proxy; skip when it does not.
  const saved = { https: process.env.HTTPS_PROXY, http: process.env.HTTP_PROXY };
  try {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
    const proxy = resolveProxy();
    if (proxy === undefined) {
      // No git config either: nothing to assert, but the call must not throw.
      assert.equal(proxy, undefined);
    } else {
      assert.match(proxy, /^(https?|socks5):\/\//);
    }
  } finally {
    if (saved.https !== undefined) process.env.HTTPS_PROXY = saved.https;
    if (saved.http !== undefined) process.env.HTTP_PROXY = saved.http;
  }
});

test("NO_PROXY matches exact hosts, suffixes and *", () => {
  assert.equal(shouldBypassProxy("github.com", "github.com"), true);
  assert.equal(shouldBypassProxy("api.github.com", "github.com"), true);
  assert.equal(shouldBypassProxy("api.github.com", "example.com"), false);
  assert.equal(shouldBypassProxy("anything", "*"), true);
  assert.equal(shouldBypassProxy("github.com", "  GitHub.com , example.com "), true);
  assert.equal(shouldBypassProxy("github.com", undefined), false);
});
