# Contributing to Hookachu

Thanks for contributing! Open an issue for substantial changes, keep pull requests focused, and include a description of the behavior and validation. Never include captured webhooks, viewing keys, credentials or local databases.

## Local setup

Use Node.js 24 and npm. In WSL, run commands inside WSL.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:8787. No Cloudflare account or environment file is required for local development.

## Development

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Build the frontend and start the local Workers runtime |
| `npm run build` | Build the frontend into `dist/` |
| `npm test` | Run integration tests in workerd / Miniflare |
| `npx wrangler deploy --dry-run` | Validate the deployment bundle without publishing |
| `npm run deploy` | Build and deploy to your authenticated account |

Wrangler watches backend changes. Rebuild after frontend changes. Development data stays in the ignored `.wrangler/` directory; tests use separate ephemeral storage.

**No `.env` file is required.** Public runtime settings and bindings are declared in `wrangler.jsonc`; retention and payload limits live in `worker/shared.js`. Authentication for deployment is handled by Wrangler, not committed credentials. If secrets are introduced later, use Wrangler secrets in production and an ignored `.dev.vars` file locally.

## Architecture

```text
Vue application
  ├── REST API → selected request details and deletion
  └── WebSocket → live metadata and viewer heartbeats
                          │
                       Worker
                          ├── Admission object → capacity and creation limits
                          └── Inbox object     → isolated history and expiry alarms
```

The backend runs on Cloudflare Workers with SQLite-backed Durable Objects. Each inbox has its own object. Hibernating WebSockets deliver live updates without HTTP polling; full payloads are loaded only when selected. No standalone database or VPS is required.

## Formatting

Run `npm run format` after editing Vue, JavaScript, CSS or HTML files. Run `npm run format:check` to check formatting without changing files. Generated assets, dependencies and local runtime storage are ignored.

## Checks before a pull request

```sh
npm run format:check
npm test
npm run build
npx wrangler deploy --dry-run
docker compose up --build -d
```

Verify inbox creation, webhook capture, authenticated viewing, live WebSocket updates and deletion. Restart the container and verify an unexpired inbox survives. Use test payloads only. Tests use isolated temporary storage and the test harness must never be included in deployment.

## Self-hosted runtime

`scripts/serve.mjs` bundles the same Worker and runs it using Miniflare/workerd, including SQLite Durable Objects, alarms, rate-limit bindings, static assets and WebSockets. This is a single-instance deployment using a local volume; do not scale replicas against the same directory. Miniflare is a local Workers runtime, not the managed Cloudflare service: validate it for your workload. Runtime configuration is derived from `wrangler.jsonc`.

## Deployment

```sh
npx wrangler login
npm run deploy
```

For deployment through Workers Builds, connect `h2u/hookachu` with these settings:

| Setting | Value |
| :--- | :--- |
| Worker name | `hookachu` (must match `wrangler.jsonc`) |
| Production branch | `main` |
| Root directory | Repository root |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Node.js | `24` (also declared in `.nvmrc`) |

Dependencies are installed by the build service. No runtime secrets, manual database provisioning or cron configuration are required. The initial deployment provisions both SQLite Durable Object namespaces; per-inbox tables are initialized by the application. Use the deploy command above, rather than a versions-only upload, for the initial migration.

The default address is `https://hookachu.<account-subdomain>.workers.dev` when the workers.dev route is enabled. Receiver URLs and WebSocket connections use the current browser origin automatically. To use your own hostname, add it in the Worker's **Settings → Domains & Routes → Add → Custom Domain**; the domain must be managed in the same Cloudflare account. No application base-URL variable is needed.

Wrangler uploads the frontend and Worker, applies the Durable Object migration, and prints the deployed URL. Configure a custom domain after deployment. Keep `MAX_INBOXES` conservative and review platform quotas before increasing it: a successful local concurrency test does not guarantee unlimited free hosting.

## Project layout

```text
src/                 Vue UI, inbox state and themes
public/              Static assets and response headers
worker/              Request routing, admission, inboxes and shared limits
test/                Integration tests and a test-only Worker harness
docs/operations.md   Storage, privacy, rate limits and deployment notes
wrangler.jsonc       Worker configuration and bindings
```

See [operations notes](docs/operations.md) for hosting, privacy, storage and limits.

## UI behavior

The homepage offers to resume the last unexpired inbox saved in this browser. Its receiver ID, private viewing key and expiry are stored in localStorage; no cross-device recovery is provided. Expiry and deletion remove the saved link when observed by the app.

While an inbox tab is open, its WebSocket stays connected in the background. New request IDs received while the tab or window is unfocused increment the page-title counter; returning to a visible, focused tab clears it. The initial history is not counted as new. Browser suspension or disconnection can delay updates; reconnecting can only recover requests still retained in the inbox.

## License

By submitting a contribution, you agree that it may be distributed under the project's MIT license.

## Publishing container images

`.github/workflows/image.yml` tests the application and runtime image for Linux AMD64 and ARM64 before publishing to GHCR. Runtime checks cover serving the homepage, receiving a webhook, authenticated inspection and persistence after a restart. Pull requests run checks without publishing.

Pushes to `main` publish `ghcr.io/h2u/hookachu:latest` and a commit SHA tag. Git tags beginning with `v` publish matching image tags, for example `v0.1.0`. A manual workflow run publishes its selected ref; only the default branch updates `latest`. Prefer a version tag or digest for fixed deployments. 32-bit ARM is not built.

The workflow uses GITHUB_TOKEN with `packages: write`; no registry password secret is required. Actions are pinned to commit SHAs. After the first publication, set the package visibility to Public in GitHub package settings to allow installation without login. Repository and package visibility are separate. Forks must update the image reference in `compose.image.yaml` to their namespace.

For local runtime checks against a disposable test instance:

```sh
docker compose exec -T hookachu node --input-type=module < test/container-smoke.mjs
docker compose restart
docker compose exec -T -e SMOKE_RESTORE=1 hookachu node --input-type=module < test/container-smoke.mjs
```

Wait for the container to become healthy before each check. These commands create a test inbox, persist a temporary viewing key inside the data volume and remove both after the final check. Use test instances, not production data, for validation.

## Main branch protection

All paths are owned by `@h2u` in `.github/CODEOWNERS`. The importable configuration is `.github/rulesets/main.json`.

1. Merge `.github/CODEOWNERS` into `main` before activating the ruleset. GitHub uses the CODEOWNERS file from the PR base branch.
2. Open repository **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, select `main.json`, and save it. The JSON is active when imported; merely committing it does not apply repository settings.
3. Confirm the bypass list contains only user `h2u` (GitHub user ID `5619582`), with **For pull requests only**. Do not change it to an always-on bypass.

Direct pushes to `main` are blocked, including pushes by the owner. Other authors need a PR and an approving code-owner review from `@h2u`; new commits dismiss stale approvals. Other users can leave reviews, but their approvals cannot replace the required owner approval. The owner can manually merge PRs, including their own, without approval using the PR-only bypass. This exemption is tied to the specific user, not to all administrators or everyone listed in CODEOWNERS. Branch deletion and force pushes are also blocked.

GitHub CODEOWNERS does not prevent other users from submitting an approving review; it controls whose approval is required for merge. If ownership changes, update both CODEOWNERS and the numeric bypass actor ID before importing. Ruleset settings can still be edited by users who have repository administration permissions.

See [GitHub ruleset API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset) and [code owner documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).
