<p align="center">
  <img src="https://cdn.h2u.lv/media/hookachu.png?v=2" alt="Hookachu logo" width="160">
</p>

# Hookachu

**Catch a webhook. Inspect the payload. Let it disappear.**

An open-source, self-hosted webhook inbox with live request inspection and automatic expiry. Create a temporary endpoint, send requests from any service, and inspect the body, headers, query parameters and sender IP. No account required.

- Independent private viewing links and live updates.
- Automatic expiry, manual deletion and bounded history.
- Light and dark themes.
- Runs in Docker or on Cloudflare Workers.

## Run with Docker

Requires Docker Engine with Docker Compose.

```sh
git clone https://github.com/h2u/hookachu.git
cd hookachu
docker compose up --build -d
```

Open **http://localhost:8787** and create an inbox. No Cloudflare account, external database or `.env` file is required. Data persists in the `hookachu-data` Docker volume across restarts; normal expiry still applies.

Send a test webhook to the receiver URL shown in the app:

```sh
curl -X POST 'http://localhost:8787/h/YOUR_INBOX_ID' \
  -H 'Content-Type: application/json' \
  -d '{"event":"hello","message":"Hookachu caught it"}'
```

Keep the viewing link private: it grants access to the inbox and deletion controls. Requests expire after one hour; an inbox can be explicitly extended up to 24 hours after creation. History is limited to 25 requests / 2 MiB per inbox, with a 256 KiB body limit.

Stop with `docker compose down`. To receive webhooks from external services, expose your instance through an HTTPS reverse proxy that supports WebSockets. See [operations notes](docs/operations.md) for configuration, storage, limits and privacy.

## Prebuilt image and CasaOS

The container workflow publishes `ghcr.io/h2u/hookachu:latest` from `main` and version tags such as `:v0.1.0` from matching Git tags, for Linux AMD64 and ARM64. **The image is available only after the first successful publishing workflow.** Until then, use the source build above.

After the image is published and its GHCR package visibility is set to Public, download [compose.image.yaml](compose.image.yaml) and run:

```sh
docker compose -f compose.image.yaml up -d
```

In CasaOS, open **Custom Install → Import** and paste the contents of `compose.image.yaml`, or configure a custom app with:

| Setting | Value |
| :--- | :--- |
| Image | `ghcr.io/h2u/hookachu:latest` |
| Host / container port | `8787` / `8787` (TCP) |
| Persistent volume | `hookachu-data` → `/data` |
| Web UI | `http://YOUR_SERVER_IP:8787` |
| Restart policy | `unless-stopped` |

Use a Docker named volume as in the Compose example. If using a host folder instead, give UID/GID `1000:1000` write access before starting. No privileged mode or Docker socket is needed. Images target 64-bit Intel/AMD and ARM systems. 32-bit ARM is not supported.

To update after publication:

```sh
docker compose -f compose.image.yaml pull
docker compose -f compose.image.yaml up -d
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development, architecture, tests and Cloudflare deployment.

## License

[MIT](LICENSE).
