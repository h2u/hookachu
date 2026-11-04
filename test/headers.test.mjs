import { test } from "node:test";
import assert from "node:assert/strict";
import { isProxyHeader } from "../src/headers.js";

test("proxy header classification preserves application and custom headers", () => {
  for (const name of [
    "CF-Ray",
    "cf-connecting-ip",
    "x-forwarded-proto",
    "X-Real-IP",
    "accept-encoding",
    "connection",
  ])
    assert.equal(isProxyHeader(name), true);
  for (const name of [
    "authorization",
    "content-type",
    "content-length",
    "host",
    "user-agent",
    "x-signature",
    "cf-custom-event",
    "x-forwarded-custom",
  ])
    assert.equal(isProxyHeader(name), false);
});
