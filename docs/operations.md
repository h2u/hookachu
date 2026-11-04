# Operations notes

## Docker hosting

Run `docker compose up --build -d`. The container runs as an unprivileged user and serves on port 8787. Check status with `docker compose ps` and logs with `docker compose logs --tail=100`. Stop with `docker compose down`; this preserves the named volume. `docker compose down -v` permanently deletes stored inboxes.

The self-hosted runtime uses Miniflare/workerd and local SQLite Durable Objects. It needs no Cloudflare account or external database. It is a single-instance service: do not share the data directory between replicas. Miniflare is primarily a local Workers runtime; managed Cloudflare availability, recovery and edge protection do not apply to Docker.

For an Internet-facing deployment, put an HTTPS reverse proxy in front, preserve the original Host and support WebSocket upgrades. Do not cache `/api/*`, `/h/*` or private inbox pages. Bind the published port to `127.0.0.1:8787:8787` when the proxy runs on the same host. The application derives receiver URLs from the browser origin.

Stop the container before backing up its volume for a consistent SQLite copy. Backups contain webhook data and remain sensitive after application expiry; define your own backup retention. Restore only into a stopped instance with compatible application code. To update, pull the desired revision and run `docker compose up --build -d` after backing up.

The server does not trust arbitrary forwarding headers to identify clients. Behind a proxy, IP capture and IP limits may reflect the proxy address; do not assume forwarded client IPs are verified. Apply per-client abuse controls at your trusted proxy. Inbox and global limits still apply.

## Access model

Receiver IDs contain 144 random bits. Viewing keys contain 256 independent random bits. The viewer link keeps its key in the URL fragment; REST calls authenticate with a bearer header and WebSockets offer a secret subprotocol. Only a key hash is stored in the inbox metadata. Treat viewing links and handshake headers as credentials. The browser stores the last inbox ID, private viewing key and expiry in localStorage to offer resume, alongside the theme preference. Payloads are not stored there. Treat browser storage as sensitive.

Bodies are rendered as text, not HTML. Browser API and WebSocket access includes origin checks. Receiving a webhook does not grant access to its history. Each inbox has its own Durable Object.

## Storage and expiry

Every request expires after one hour. An inbox expires one hour after creation or its last explicit extension, capped at 24 hours after creation. An authenticated viewer can extend it by one hour from the time of clicking during the last 10 minutes. Heartbeats, viewing and incoming requests do not extend it. Extension never changes individual request expiry. On expiry the UI clears private data and shows an unavailable screen with actions to create a new inbox or return home; the receiver returns HTTP 410.

Alarms schedule the earliest pending expiry. Every access also checks expiry, so delayed cleanup cannot expose expired data. Deletion releases the admission slot, closes viewers, cancels the alarm and clears object storage. Request eviction removes the oldest records first.

At the default capacity, serialized request data can occupy roughly 400 MiB across 200 full inboxes, plus summaries, metadata, SQLite overhead and recovery storage. This is a disk/session budget, not preallocated RAM. Individual reads load summaries or one selected payload.

Cloudflare's SQLite Durable Objects support point-in-time recovery over the previous 30 days. Application deletion is not a guarantee of immediate irreversible physical destruction. See [storage recovery documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

Local Wrangler data is separate from production and remains in ignored `.wrangler/` files. Tests use isolated ephemeral runtime storage. Never commit local inbox databases or runtime logs.

## Full limits

| Resource | Default |
| :--- | ---: |
| Active inboxes | 200 (`MAX_INBOXES`) |
| Creation per IP | 5 / minute |
| Global creation | 30 / minute |
| Incoming requests per inbox | 30 / minute |
| Combined API and receiver requests per IP | 120 / minute |
| Concurrent uploads per inbox | 2 |
| Upload timeout | 10 seconds |
| Body | 256 KiB |
| Captured normalized headers | 16 KiB |
| URL | 4,096 characters |
| History | 25 requests / 2 MiB serialized data |
| WebSocket viewers per inbox | 3 |

Native IP rate limits are per-location, not exact globally shared counters. Inbox traffic counters persist across hibernation. Creation and capacity are coordinated by one Admission object. See [rate limit semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Capacity exhaustion returns `503` and `Retry-After`; rate limits return `429`. The frontend retries with delay and jitter while visible. This is a local waiting room, not a persistent FIFO queue. Senders may retry rejected webhooks according to their own policies.

## Hosting and abuse

Workers and Durable Objects have separate request, compute and storage-operation quotas. Review the [current platform pricing](https://developers.cloudflare.com/workers/platform/pricing/) before deployment; free hosting is limited by usage, not just simultaneous user count.

For example, 100 continuously visible viewers generate 28,800 incoming heartbeat messages per day, plus initial connections, webhook traffic, detail fetches, reconnects, alarms and database operations. Local tests cover 100 simultaneous isolated viewers, not production billing or throughput guarantees.

Platform DDoS protection and application limits reduce abuse; distributed attacks can still exhaust quotas. Where available, apply edge WAF rules or challenges to suspicious creation traffic before Worker execution. Do not challenge legitimate webhook receiver traffic. A friendly waiting screen cannot run when the platform rejects a request before application code executes.

Observability is disabled in the checked-in configuration. The application does not log payloads or credentials. Review privacy implications before enabling request-header logs, external analytics or caching API/receiver routes. The infrastructure provider still processes traffic according to its own policies.

## HTTP fidelity

The inspector records method, path, repeated query parameters, normalized headers, sender IP, receipt timestamp and exact body bytes encoded as Base64. It displays decoded text or pretty JSON when possible. Compressed request bodies are rejected.

Workers does not expose original wire-level header casing/order, TCP peer details or the original HTTP version. The platform may normalize/add headers. This service acknowledges received requests; it does not forward them, execute payload code, verify signatures or capture an upstream response.

## Validation

Integration tests execute the actual Worker classes in workerd/Miniflare. They cover cross-inbox read/delete isolation, binary capture, count/byte eviction, rate/body limits, slot exhaustion and release, WebSocket authentication, request expiry, inbox alarms and 100 simultaneous isolated viewers.

Administrative helpers in `test/harness.js` are test-only. The production entrypoint is `worker/index.js`, which does not import the harness.
