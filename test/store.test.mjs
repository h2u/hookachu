import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

test("homepage recovery and intentional navigation preserve the inbox without connection errors", async () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.location = {
    pathname: "/",
    hash: "",
    origin: "https://test.local",
    protocol: "https:",
    host: "test.local",
  };
  globalThis.history = { replaceState() {} };
  const sockets = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    readyState = 1;
    constructor() {
      sockets.push(this);
    }
    send() {}
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  };
  const box = {
    id: "a".repeat(24),
    secret: "b".repeat(43),
    expiresAt: Date.now() + 3600000,
    maxExpiresAt: Date.now() + 86400000,
  };
  let expired = false;
  globalThis.fetch = async (url, options) => {
    if (url === "/api/inboxes" && options.method === "POST")
      return Response.json(box, { status: 201 });
    if (expired)
      return Response.json({ error: "Inbox expired" }, { status: 410 });
    return Response.json({ ...box, requests: [] });
  };
  const built = await build({
    stdin: {
      contents:
        "import { createPinia, setActivePinia } from 'pinia'; import { useInbox } from './src/store.js'; export function makeStore() { setActivePinia(createPinia()); return useInbox() }",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  const { makeStore } = await import(
    "data:text/javascript;base64," +
      Buffer.from(built.outputFiles[0].text).toString("base64")
  );
  const store = makeStore();
  await store.create();
  const snapshot = (items) =>
    sockets[0].onmessage({
      data: JSON.stringify({ type: "snapshot", requests: items }),
    });
  store.setAttended(false);
  const initial = Array.from({ length: 25 }, (_, index) => ({
    id: `request-${index}`,
  }));
  snapshot(initial);
  assert.equal(store.unreadCount, 0, "initial history is not unread");
  const replaced = [{ id: "new-request" }, ...initial.slice(0, 24)];
  snapshot(replaced);
  assert.equal(store.unreadCount, 1, "new IDs count even when history is full");
  snapshot(replaced);
  assert.equal(store.unreadCount, 1, "repeated snapshots do not double count");
  snapshot([]);
  assert.equal(store.unreadCount, 1, "expiry or clearing is not a new request");
  snapshot(replaced);
  assert.equal(
    store.unreadCount,
    1,
    "previously received IDs are not counted again",
  );
  store.setAttended(true);
  assert.equal(
    store.unreadCount,
    0,
    "returning to the focused tab acknowledges requests",
  );
  snapshot([{ id: "seen-in-focus" }, ...replaced.slice(0, 24)]);
  assert.equal(store.unreadCount, 0);
  store.setAttended(false);
  snapshot([{ id: "another-new-request" }, ...replaced.slice(0, 24)]);
  assert.equal(store.unreadCount, 1);
  const oldClose = sockets[0].onclose;
  assert.equal(
    JSON.parse(storage.get("hookachu-last-inbox")).secret,
    box.secret,
  );
  store.goHome();
  oldClose({ code: 1006 }); // Even a queued close from the previous socket must be ignored.
  assert.equal(store.unreadCount, 0, "leaving the inbox resets notifications");
  assert.equal(store.id, "");
  assert.equal(store.error, "");
  assert.equal(store.savedInbox.id, box.id);
  assert.equal(sockets[0].onclose, null);
  store.resume();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.id, box.id);
  assert.equal(store.secret, box.secret);
  assert.equal(sockets.length, 2);
  store.goHome();
  const reloaded = makeStore();
  assert.equal(reloaded.savedInbox.id, box.id);
  expired = true;
  reloaded.resume();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reloaded.secret, "");
  assert.match(reloaded.error, /expired/i);
  assert.equal(storage.has("hookachu-last-inbox"), false);
  storage.set(
    "hookachu-last-inbox",
    JSON.stringify({ ...box, expiresAt: Date.now() - 1 }),
  );
  assert.equal(makeStore().savedInbox, null);
  storage.set("hookachu-last-inbox", "invalid json");
  assert.equal(makeStore().savedInbox, null);
});
