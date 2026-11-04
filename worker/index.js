import { DurableObject } from "cloudflare:workers";
import {
  LIMITS,
  json,
  randomToken,
  toBase64,
  hash,
  sameHash,
  readBody,
} from "./shared.js";

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === "/healthz") return json({ ok: true });
      if (!path.startsWith("/api/") && !path.startsWith("/h/"))
        return env.ASSETS.fetch(request);
      if (request.url.length > 4096)
        return json({ error: "URL too long" }, 414);
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      if (!(await env.IP_LIMIT.limit({ key: ip })).success)
        return json({ error: "Too many requests" }, 429, {
          "Retry-After": "60",
        });
      if (path.startsWith("/api/")) {
        if (
          request.headers.get("Origin") &&
          request.headers.get("Origin") !== url.origin
        )
          return json({ error: "Origin rejected" }, 403);
        if (request.headers.get("Sec-Fetch-Site") === "cross-site")
          return json({ error: "Cross-site request rejected" }, 403);
        if (path === "/api/inboxes" && request.method === "POST") {
          if (!(await env.CREATE_LIMIT.limit({ key: ip })).success)
            return json(
              { error: "Creation limit reached. Retrying shortly." },
              429,
              { "Retry-After": "60" },
            );
          return env.ADMISSION.getByName("global").create();
        }
      }
      const match = /^\/(?:h|api\/inboxes)\/([\w-]{24})(?:\/.*)?$/.exec(path);
      if (!match) return json({ error: "Not found" }, 404);
      return await env.INBOX.getByName(match[1]).fetch(request);
    } catch {
      return json({ error: "Service temporarily unavailable" }, 503, {
        "Retry-After": "15",
      });
    }
  },
};

export class Admission extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS rate (id INTEGER PRIMARY KEY, bucket INTEGER, count INTEGER)",
    );
  }
  async create() {
    // Serialise reservation and initialization, including concurrent creation requests.
    return this.ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql,
        now = Date.now(),
        bucket = Math.floor(now / 60000);
      sql.exec("DELETE FROM leases WHERE expires <= ?", now);
      const rate = sql
        .exec("SELECT bucket,count FROM rate WHERE id=1")
        .toArray()[0];
      if (rate?.bucket === bucket && rate.count >= 30)
        return json({ error: "Creation limit reached" }, 429, {
          "Retry-After": "60",
        });
      const count = sql.exec("SELECT count(*) AS n FROM leases").one().n;
      if (count >= Number(this.env.MAX_INBOXES || 200))
        return json(
          { error: "All inbox slots are occupied. Waiting for space." },
          503,
          { "Retry-After": "15" },
        );
      sql.exec(
        "INSERT OR REPLACE INTO rate VALUES (1,?,?)",
        bucket,
        rate?.bucket === bucket ? rate.count + 1 : 1,
      );
      const id = randomToken(18),
        secret = randomToken(32),
        created = Date.now();
      sql.exec("INSERT INTO leases VALUES (?,?)", id, created + LIMITS.maxAge);
      await this.ctx.storage.setAlarm(created + LIMITS.ttl);
      try {
        await this.env.INBOX.getByName(id).initialize(
          id,
          await hash(secret),
          created,
        );
      } catch {
        sql.exec("DELETE FROM leases WHERE id=?", id);
        return json({ error: "Could not create inbox" }, 503);
      }
      return json(
        {
          id,
          secret,
          maxExpiresAt: created + LIMITS.maxAge,
          expiresAt: created + LIMITS.ttl,
        },
        201,
      );
    });
  }
  async release(id) {
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE id=?", id);
  }
  async alarm() {
    this.ctx.storage.sql.exec(
      "DELETE FROM leases WHERE expires <= ?",
      Date.now(),
    );
    const next = this.ctx.storage.sql
      .exec("SELECT min(expires) AS next FROM leases")
      .one().next;
    if (next) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAll();
  }
}

export class Inbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.receiving = 0;
  }
  async initialize(id, keyHash, created) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get("meta"))
        throw new Error("Already initialized");
      this.ctx.storage.sql.exec(
        "CREATE TABLE requests (id TEXT PRIMARY KEY, received INTEGER NOT NULL, bytes INTEGER NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE INDEX received_idx ON requests(received)",
      );
      await this.ctx.storage.put("meta", {
        id,
        keyHash,
        created,
        viewed: created,
        bucket: 0,
        count: 0,
      });
      await this.ctx.storage.setAlarm(created + LIMITS.ttl);
    });
  }
  async meta() {
    const meta = await this.ctx.storage.get("meta");
    if (!meta) return null;
    if (
      Date.now() >=
      Math.min(meta.viewed + LIMITS.ttl, meta.created + LIMITS.maxAge)
    ) {
      await this.destroy(meta);
      return null;
    }
    return meta;
  }
  async destroy(meta) {
    // Release first: if this fails the alarm can retry; deletion must not orphan the lease.
    await this.env.ADMISSION.getByName("global").release(meta.id);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4004, "Inbox expired or deleted");
      } catch {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
  prune() {
    this.ctx.storage.sql.exec(
      "DELETE FROM requests WHERE received <= ?",
      Date.now() - LIMITS.ttl,
    );
  }
  summaries() {
    this.prune();
    return this.ctx.storage.sql
      .exec("SELECT summary FROM requests ORDER BY received DESC, rowid DESC")
      .toArray()
      .map((r) => JSON.parse(r.summary));
  }
  expiry(meta) {
    return Math.min(meta.viewed + LIMITS.ttl, meta.created + LIMITS.maxAge);
  }
  async schedule(meta) {
    const oldest = this.ctx.storage.sql
      .exec("SELECT min(received) AS t FROM requests")
      .one().t;
    await this.ctx.storage.setAlarm(
      Math.min(this.expiry(meta), oldest ? oldest + LIMITS.ttl : Infinity),
    );
  }
  broadcast(value) {
    const message = JSON.stringify(value);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {}
    }
  }
  async touch(meta) {
    return this.expiry(meta);
  }
  async fetch(request) {
    const url = new URL(request.url),
      path = url.pathname;
    const meta = await this.meta();
    if (!meta) return json({ error: "Inbox expired or does not exist" }, 410);
    if (path.startsWith("/h/")) return this.receive(request, meta);
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "")
      .split(",")
      .map((v) => v.trim());
    const secret =
      request.headers.get("Authorization")?.replace(/^Bearer /, "") ||
      protocols.find((v) => v.startsWith("key."))?.slice(4) ||
      "";
    if (!sameHash(meta.keyHash, await hash(secret)))
      return json({ error: "Inbox not found or viewing key invalid" }, 404);
    const suffix = path.replace(/^\/api\/inboxes\/[\w-]{24}/, "");
    if (
      suffix === "/events" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      if (
        request.headers.get("Origin") !== url.origin ||
        !protocols.includes("hookachu")
      )
        return json({ error: "Origin or protocol rejected" }, 403);
      if (this.ctx.getWebSockets().length >= 3)
        return json({ error: "At most 3 viewers per inbox" }, 429);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ last: 0 });
      pair[1].send(
        JSON.stringify({
          type: "snapshot",
          requests: this.summaries(),
          maxExpiresAt: meta.created + LIMITS.maxAge,
          expiresAt: this.expiry(meta),
        }),
      );
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": "hookachu" },
      });
    }
    if (request.method === "GET" && suffix === "/requests")
      return json({
        requests: this.summaries(),
        maxExpiresAt: meta.created + LIMITS.maxAge,
        expiresAt: this.expiry(meta),
        limits: LIMITS,
      });
    const detail = /^\/requests\/([\w-]{24})$/.exec(suffix);
    if (request.method === "GET" && detail) {
      this.prune();
      const row = this.ctx.storage.sql
        .exec("SELECT data FROM requests WHERE id=?", detail[1])
        .toArray()[0];
      return row
        ? json(JSON.parse(row.data))
        : json({ error: "Request expired or evicted" }, 404);
    }
    if (request.method === "POST" && suffix === "/extend") {
      const now = Date.now(),
        expiresAt = this.expiry(meta);
      if (expiresAt - now > LIMITS.extendWindow)
        return json(
          { error: "You can extend during the last 10 minutes" },
          409,
        );
      if (expiresAt >= meta.created + LIMITS.maxAge)
        return json(
          { error: "Maximum inbox lifetime reached (24 hours)" },
          409,
        );
      meta.viewed = now;
      await this.ctx.storage.put("meta", meta);
      await this.schedule(meta);
      this.broadcast({
        type: "heartbeat",
        maxExpiresAt: meta.created + LIMITS.maxAge,
        expiresAt: this.expiry(meta),
      });
      return json({
        maxExpiresAt: meta.created + LIMITS.maxAge,
        expiresAt: this.expiry(meta),
      });
    }
    if (request.method === "POST" && suffix === "/heartbeat")
      return json({ expiresAt: await this.touch(meta) });
    if (request.method === "DELETE" && suffix === "/requests") {
      this.ctx.storage.sql.exec("DELETE FROM requests");
      await this.schedule(meta);
      this.broadcast({
        type: "snapshot",
        requests: [],
        maxExpiresAt: meta.created + LIMITS.maxAge,
        expiresAt: this.expiry(meta),
      });
      return json({ ok: true });
    }
    if (request.method === "DELETE" && !suffix) {
      await this.destroy(meta);
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }
  async receive(request, meta) {
    if (this.receiving >= 2)
      return json({ error: "Too many concurrent uploads" }, 503);
    if (
      request.headers.has("Content-Encoding") &&
      request.headers.get("Content-Encoding") !== "identity"
    )
      return json({ error: "Compressed bodies are not supported" }, 415);
    const bucket = Math.floor(Date.now() / 60000);
    // Persist the rate counter across hibernation, before awaiting body bytes.
    if (meta.bucket !== bucket) {
      meta.bucket = bucket;
      meta.count = 0;
    }
    if (++meta.count > LIMITS.perMinute)
      return json(
        { error: `Inbox limit: ${LIMITS.perMinute} requests/minute` },
        429,
        { "Retry-After": "60" },
      );
    await this.ctx.storage.put("meta", meta);
    this.receiving++;
    try {
      const body = await readBody(request);
      // The inbox may have expired or been deleted while an upload was in flight.
      const current = await this.meta();
      if (!current) return json({ error: "Inbox expired" }, 410);
      const url = new URL(request.url),
        id = randomToken(18),
        receivedAt = Date.now();
      const summary = {
        id,
        receivedAt,
        method: request.method,
        url: url.pathname + url.search,
        bodyBytes: body.length,
        remoteAddress: request.headers.get("CF-Connecting-IP") || "unknown",
      };
      const headers = [...request.headers.entries()].flat();
      if (JSON.stringify(headers).length > 16384)
        return json({ error: "Headers too large" }, 431);
      const item = {
        ...summary,
        headers,
        body: toBase64(body),
        encoding: "base64",
        httpVersion: "Not exposed by Workers",
      };
      const data = JSON.stringify(item),
        bytes = new TextEncoder().encode(data).length;
      this.prune();
      const sql = this.ctx.storage.sql;
      sql.exec(
        "INSERT INTO requests VALUES (?,?,?,?,?)",
        id,
        receivedAt,
        bytes,
        JSON.stringify(summary),
        data,
      );
      let usage = sql
        .exec(
          "SELECT count(*) AS n, coalesce(sum(bytes),0) AS bytes FROM requests",
        )
        .one();
      while (usage.n > LIMITS.history || usage.bytes > LIMITS.inboxBytes) {
        sql.exec(
          "DELETE FROM requests WHERE id=(SELECT id FROM requests ORDER BY received ASC,rowid ASC LIMIT 1)",
        );
        usage = sql
          .exec(
            "SELECT count(*) AS n, coalesce(sum(bytes),0) AS bytes FROM requests",
          )
          .one();
      }
      await this.schedule(current);
      this.broadcast({
        type: "snapshot",
        requests: this.summaries(),
        expiresAt: this.expiry(current),
      });
      return json({ ok: true });
    } catch (e) {
      return json(
        {
          error: e instanceof RangeError ? e.message : "Could not read request",
        },
        e instanceof RangeError ? 413 : 400,
      );
    } finally {
      this.receiving--;
    }
  }
  async webSocketMessage(ws, message) {
    const state = ws.deserializeAttachment() || { last: 0 };
    if (
      typeof message !== "string" ||
      message.length > 100 ||
      message !== "heartbeat"
    ) {
      ws.close(1008, "Invalid message");
      return;
    }
    if (Date.now() - state.last < 30000) {
      ws.close(1008, "Heartbeat rate exceeded");
      return;
    }
    state.last = Date.now();
    ws.serializeAttachment(state);
    const meta = await this.meta();
    if (!meta) return;
    ws.send(
      JSON.stringify({ type: "heartbeat", expiresAt: await this.touch(meta) }),
    );
  }
  async webSocketClose(ws, code, reason) {
    ws.close(code, reason);
  }
  async webSocketError(ws) {
    ws.close(1011, "Connection error");
  }
  async alarm() {
    const meta = await this.meta();
    if (!meta) return;
    this.prune();
    this.broadcast({
      type: "snapshot",
      requests: this.summaries(),
      maxExpiresAt: meta.created + LIMITS.maxAge,
      expiresAt: this.expiry(meta),
    });
    await this.schedule(meta);
  }
}
