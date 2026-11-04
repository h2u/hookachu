import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { LIMITS } from "../worker/shared.js";

test("Workers runtime: isolation, retention, eviction, capacity, streaming limits and WebSockets", async (t) => {
  const built = await build({
    entryPoints: ["test/harness.js"],
    bundle: true,
    write: false,
    format: "esm",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "test",
          modules: true,
          script: built.outputFiles[0].text,
          compatibilityDate: "2026-11-04",
          durableObjects: {
            INBOX: { className: "Inbox", useSQLite: true },
            ADMISSION: { className: "Admission", useSQLite: true },
          },
          bindings: { MAX_INBOXES: "2" },
          ratelimits: {
            IP_LIMIT: {
              namespace_id: "1001",
              simple: { limit: 10000, period: 60 },
            },
            CREATE_LIMIT: {
              namespace_id: "1002",
              simple: { limit: 10000, period: 60 },
            },
          },
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  const call = (path, options) =>
    mf.dispatchFetch("https://test.local" + path, options);
  const make = async () => {
    const r = await call("/api/inboxes", { method: "POST" });
    assert.equal(r.status, 201);
    return r.json();
  };
  const api = (box, path = "/requests", method = "GET") =>
    call(`/api/inboxes/${box.id}${path}`, {
      method,
      headers: { Authorization: `Bearer ${box.secret}` },
    });
  const control = async (box, op) =>
    (await call(`/__test/${box.id}/${op}`)).json();
  const a = await make(),
    b = await make();
  assert.match(a.id, /^[\w-]{24}$/);
  assert.match(a.secret, /^[\w-]{43}$/);
  assert.notEqual(a.secret, b.secret);
  await t.test(
    "capacity waits and origin checks reject foreign sites",
    async () => {
      assert.equal(
        (await call("/api/inboxes", { method: "POST" })).status,
        503,
      );
      assert.equal(
        (
          await call("/api/inboxes", {
            method: "POST",
            headers: { Origin: "https://evil.local" },
          })
        ).status,
        403,
      );
    },
  );
  await t.test("receiver URL never grants read or delete access", async () => {
    assert.equal((await call(`/api/inboxes/${a.id}/requests`)).status, 404);
    assert.equal((await api({ ...a, secret: b.secret })).status, 404);
    assert.equal(
      (await api({ ...a, secret: b.secret }, "", "DELETE")).status,
      404,
    );
    assert.equal(
      (await api(a)).headers.get("cache-control"),
      "no-store, private",
    );
  });
  await t.test(
    "binary body, duplicate query parameters and hostile strings survive safely as data",
    async () => {
      const payload = new Uint8Array([0, 255, 1, 128]);
      const r = await call(`/h/${a.id}/extra?a=1&a=2`, {
        method: "PATCH",
        headers: { "X-Sample": "<script>alert(1)</script>" },
        body: payload,
      });
      assert.equal(r.status, 200);
      const list = await (await api(a)).json();
      assert.equal(list.requests.length, 1);
      assert.equal(list.requests[0].body, undefined);
      const item = await (
        await api(a, "/requests/" + list.requests[0].id)
      ).json();
      assert.equal(item.body, Buffer.from(payload).toString("base64"));
      assert.ok(item.url.endsWith("?a=1&a=2"));
      assert.ok(item.headers.includes("<script>alert(1)</script>"));
      assert.equal((await (await api(b)).json()).requests.length, 0);
      assert.equal((await api(b, "/requests/" + item.id)).status, 404);
    },
  );
  await t.test("oversized and compressed bodies rejected", async () => {
    assert.equal(
      (
        await call(`/h/${a.id}`, {
          method: "POST",
          body: "x".repeat(LIMITS.bodyBytes + 1),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await call(`/h/${a.id}`, {
          method: "POST",
          headers: { "Content-Encoding": "gzip" },
          body: "x",
        })
      ).status,
      415,
    );
  });
  await t.test(
    "2 MiB cap evicts oldest entries; 25-count cap holds separately",
    async () => {
      await api(a, "/requests", "DELETE");
      for (let i = 0; i < 8; i++)
        assert.equal(
          (
            await call(`/h/${a.id}/${i}`, {
              method: "POST",
              body: "x".repeat(LIMITS.bodyBytes),
            })
          ).status,
          200,
        );
      const stats = await control(a, "stats");
      assert.ok(stats.usage.bytes <= LIMITS.inboxBytes);
      assert.ok(stats.usage.n < 8);
      const list = (await (await api(a)).json()).requests;
      assert.ok(list[0].url.endsWith("/7"));
      assert.ok(!list.some((r) => r.url.endsWith("/0")));
      await api(a, "/requests", "DELETE");
      await control(a, "resetRate");
      for (let i = 0; i < 26; i++)
        assert.equal(
          (await call(`/h/${a.id}/${i}`, { method: "POST", body: "ok" }))
            .status,
          200,
        );
      assert.equal((await control(a, "stats")).usage.n, 25);
    },
  );
  await t.test(
    "30/minute limit persists and hooks never renew viewer expiry",
    async () => {
      await control(a, "resetRate");
      const before = (await control(a, "stats")).meta.viewed;
      for (let i = 0; i < 30; i++)
        assert.equal(
          (await call(`/h/${a.id}`, { method: "POST" })).status,
          200,
        );
      assert.equal((await call(`/h/${a.id}`, { method: "POST" })).status, 429);
      assert.equal((await control(a, "stats")).meta.viewed, before);
    },
  );
  await t.test(
    "only authenticated explicit extensions in the last 10 minutes renew the inbox",
    async () => {
      assert.equal(
        (await api({ ...b, secret: a.secret }, "/extend", "POST")).status,
        404,
      );
      assert.equal((await api(b, "/extend", "POST")).status, 409);
      await control(b, "nearExpiry");
      const before = (await (await api(b)).json()).expiresAt;
      assert.equal(
        (await (await api(b, "/heartbeat", "POST")).json()).expiresAt,
        before,
      );
      const response = await api(b, "/extend", "POST");
      assert.equal(response.status, 200);
      const extended = await response.json();
      assert.ok(extended.expiresAt > before + 3000000);
      assert.ok(extended.expiresAt <= Date.now() + LIMITS.ttl);
      assert.equal((await api(b, "/extend", "POST")).status, 409);
      await control(b, "nearMax");
      assert.equal((await api(b, "/extend", "POST")).status, 409);
      const capped = await (await api(b)).json();
      assert.equal(capped.expiresAt, capped.maxExpiresAt);
    },
  );
  await t.test(
    "hibernation-compatible WebSocket authenticates, receives snapshot and heartbeat",
    async () => {
      const response = await call(`/api/inboxes/${a.id}/events`, {
        headers: {
          Upgrade: "websocket",
          Origin: "https://test.local",
          "Sec-WebSocket-Protocol": `hookachu, key.${a.secret}`,
        },
      });
      assert.equal(response.status, 101);
      const ws = response.webSocket;
      ws.accept();
      t.after(() => {
        try {
          ws.close();
        } catch {}
      });
      const heartbeat = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket timeout")),
          5000,
        );
        ws.addEventListener("message", (event) => {
          const value = JSON.parse(event.data);
          if (value.type === "heartbeat") {
            clearTimeout(timeout);
            resolve(value);
          }
        });
      });
      ws.send("heartbeat");
      assert.ok((await heartbeat).expiresAt);
      assert.equal(
        (
          await call(`/api/inboxes/${a.id}/events`, {
            headers: {
              Upgrade: "websocket",
              Origin: "https://evil.local",
              "Sec-WebSocket-Protocol": `hookachu, key.${a.secret}`,
            },
          })
        ).status,
        403,
      );
    },
  );
  await t.test(
    "request age expires independently of visible inbox; manual deletion frees slot",
    async () => {
      await control(a, "ageRequest");
      assert.equal((await (await api(a)).json()).requests.length, 0);
      assert.equal((await api(a, "", "DELETE")).status, 200);
      assert.equal((await call(`/h/${a.id}`, { method: "POST" })).status, 410);
      const c = await make();
      assert.notEqual(c.id, a.id);
    },
  );
  await t.test(
    "alarm expires unviewed inbox and clears private data",
    async () => {
      await control(b, "expire");
      assert.equal((await api(b)).status, 410);
      assert.equal((await call(`/h/${b.id}`)).status, 410);
      const d = await make();
      assert.notEqual(d.id, b.id);
    },
  );

  await t.test(
    "100 isolated simultaneous viewers receive only their own live requests",
    async () => {
      const load = new Miniflare(
        convertV4MiniflareOptions({
          workers: [
            {
              name: "test",
              modules: true,
              script: built.outputFiles[0].text,
              compatibilityDate: "2026-11-04",
              durableObjects: {
                INBOX: { className: "Inbox", useSQLite: true },
                ADMISSION: { className: "Admission", useSQLite: true },
              },
              bindings: { MAX_INBOXES: "200" },
              ratelimits: {
                IP_LIMIT: {
                  namespace_id: "1001",
                  simple: { limit: 10000, period: 60 },
                },
                CREATE_LIMIT: {
                  namespace_id: "1002",
                  simple: { limit: 10000, period: 60 },
                },
              },
            },
          ],
        }),
      );
      const sockets = [];
      try {
        const send = (path, options) =>
          load.dispatchFetch("https://test.local" + path, options);
        const boxes = [];
        for (let batch = 0; batch < 4; batch++) {
          await send("/__test/reset-create-rate");
          const created = await Promise.all(
            Array.from({ length: 25 }, async () => {
              const response = await send("/api/inboxes", { method: "POST" });
              assert.equal(response.status, 201);
              return response.json();
            }),
          );
          boxes.push(...created);
        }
        const deliveries = await Promise.all(
          boxes.map(async (box, index) => {
            const response = await send(`/api/inboxes/${box.id}/events`, {
              headers: {
                Upgrade: "websocket",
                Origin: "https://test.local",
                "Sec-WebSocket-Protocol": `hookachu, key.${box.secret}`,
              },
            });
            assert.equal(response.status, 101);
            const ws = response.webSocket;
            ws.accept();
            sockets.push(ws);
            const received = new Promise((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error("Live delivery timed out")),
                10000,
              );
              ws.addEventListener("message", (event) => {
                const data = JSON.parse(event.data);
                if (data.type === "snapshot" && data.requests.length) {
                  clearTimeout(timeout);
                  resolve(data);
                }
              });
            });
            return { box, index, received };
          }),
        );
        await Promise.all(
          deliveries.map(async ({ box, index, received }) => {
            assert.equal(
              (
                await send(`/h/${box.id}/sender-${index}`, {
                  method: "POST",
                  body: JSON.stringify({ privateFor: index }),
                })
              ).status,
              200,
            );
            const snapshot = await received;
            assert.equal(snapshot.requests.length, 1);
            assert.equal(
              snapshot.requests[0].url,
              `/h/${box.id}/sender-${index}`,
            );
            const detail = await send(
              `/api/inboxes/${box.id}/requests/${snapshot.requests[0].id}`,
              { headers: { Authorization: `Bearer ${box.secret}` } },
            );
            assert.equal(
              JSON.parse(
                Buffer.from((await detail.json()).body, "base64").toString(),
              ).privateFor,
              index,
            );
          }),
        );
      } finally {
        for (const ws of sockets) {
          try {
            ws.close();
          } catch {}
        }
        await load.dispose();
      }
    },
  );
});
