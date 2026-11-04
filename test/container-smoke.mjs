import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";

const base = "http://127.0.0.1:8787";
const state = "/data/.container-smoke.json";
const call = (path, options) => fetch(base + path, options);
let box;
if (process.env.SMOKE_RESTORE) {
  box = JSON.parse(await readFile(state, "utf8"));
} else {
  const home = await call("/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Hookachu/i);
  const created = await call("/api/inboxes", { method: "POST" });
  assert.equal(created.status, 201);
  box = await created.json();
  assert.equal(
    (await call(`/h/${box.id}`, { method: "POST", body: "container-smoke" }))
      .status,
    200,
  );
  await writeFile(state, JSON.stringify(box));
}
const path = `/api/inboxes/${box.id}`;
const headers = { Authorization: `Bearer ${box.secret}` };
assert.equal((await call(`${path}/requests`)).status, 404);
const response = await call(`${path}/requests`, { headers });
assert.equal(response.status, 200);
const { requests } = await response.json();
assert.equal(requests.length, 1);
const detail = await call(`${path}/requests/${requests[0].id}`, { headers });
assert.equal(detail.status, 200);
const item = await detail.json();
assert.equal(Buffer.from(item.body, "base64").toString(), "container-smoke");
if (process.env.SMOKE_RESTORE) {
  assert.equal((await call(path, { method: "DELETE", headers })).status, 200);
  await unlink(state);
}
console.log(
  process.env.SMOKE_RESTORE
    ? "Persistence after restart: PASS"
    : "Homepage, capture and authenticated inspection: PASS",
);
