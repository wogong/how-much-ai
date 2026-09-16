# Self-hosting How Much AI

This guide covers the open-source, single-tenant edition. It does not require or support hosted identity or billing. One person or trusted group controls the instance, its password, storage backend, and connected provider credentials.

## 1. Choose a topology

Pick one storage path before connecting the first account:

| Topology | Vault | Shared refresh coordination | Scheduled notifications | Device pairing |
| --- | --- | --- | --- | --- |
| One persistent machine | Encrypted file | Local file lock/cache | No | No |
| Durable Convex deployment | Convex | Convex lease/cache | Yes | Yes |
| Durable Redis/KV REST | Redis | Redis lease/cache | No | No |

The selection is automatic:

1. a complete Convex URL/secret pair wins;
2. otherwise a complete Redis REST URL/token pair wins;
3. otherwise the app uses an encrypted local file.

A partial Convex or Redis configuration is an error. If both remote backends are complete, Convex takes precedence.

Notifications require Convex. Configuring Convex for notifications also makes Convex the vault and usage-coordination backend.

## 2. Requirements

- Node.js 22.18.0 or newer;
- npm;
- Git;
- a persistent directory or a supported remote storage backend;
- HTTPS for any non-loopback deployment;
- provider accounts you are authorized to monitor.

Clone and install exactly from the lockfile:

```bash
git clone https://github.com/SeraphKc/how-much-ai.git
cd how-much-ai
npm ci
```

Run the zero-configuration local edition:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Do not expose this default to an untrusted network: without `APP_PASSWORD`, every dashboard and API route is intentionally open.

## 3. Configure secrets

For anything beyond local-only evaluation:

```bash
cp .env.example .env.local
```

Generate each secret independently. On systems with OpenSSL:

```bash
openssl rand -hex 32
```

Repeat that command for each value; do not reuse one output everywhere. Put secrets in `.env.local` for a private machine or in the hosting platform's encrypted environment settings.

Recommended baseline:

```dotenv
APP_PASSWORD=<a strong login password>
AUTH_SECRET=<an independent random value>
VAULT_ENCRYPTION_SECRET=<an independent random value>
TRUST_PROXY_IP_HEADERS=0
```

- `APP_PASSWORD` enables the password gate.
- `AUTH_SECRET` signs the 30-day session cookie. Keeping it independent allows password changes without immediately invalidating every session.
- `VAULT_ENCRYPTION_SECRET` separates credential encryption from the login password. It is mandatory for Redis and strongly recommended for any networked install.

Do not rotate or delete vault key sources casually. Existing remote generations stay pinned to the exact key that encrypted them.

## 4. Connect provider accounts

After the dashboard loads, choose **Connect account**.

### Claude

The preferred path is the app-specific sign-in:

1. choose Claude;
2. open the secure Claude sign-in;
3. approve access;
4. paste the complete returned `code#state` into the dialog.

The server exchanges it once, verifies the account, and stores the renewable credential in the encrypted vault.

When the app runs on the same computer as Claude Code, it can also read that computer's Keychain or `~/.claude/.credentials.json`. This shortcut shares Claude Code's rotating credential and can require reconnection after either client renews it.

Development mode enables this same-machine shortcut automatically. A production-mode local install must opt in:

```dotenv
ENABLE_LOCAL_CONNECT=1
```

Never enable it on a remote, shared, or serverless host: the route reads the server's CLI credential, not the browser user's machine.

`claude setup-token` is not a monitoring credential. It can perform inference, but it lacks the profile permission required by the subscription-usage endpoint.

### ChatGPT/Codex

When the app runs on the same computer as Codex, it can read `~/.codex/auth.json`. Otherwise, paste the complete JSON file into the OpenAI connection form. The server validates and normalizes the credential before it writes the vault.

### sub2api administrator accounts

Choose **Add account → sub2api**. Enter the sub2api base URL and its **Admin API Key** (not a normal inference key) once, then load the combined Claude and ChatGPT account list. Choose **Connect all Claude & ChatGPT accounts** to import all supported subscription accounts across every page, or select an individual account. Bulk connection saves atomically after all pages are read; existing accounts are updated without duplicates, retaining their nicknames and original connection dates. Unrelated accounts are preserved. Accounts added in sub2api later are discovered automatically: the dashboard re-lists each connected instance at most every ten minutes when it loads the vault (page load or tab focus) and the notification cron does the same, appending new supported accounts. Accounts removed in sub2api are kept until you remove them here; they show a refresh error instead. The URL is resolved by the app server; `localhost` inside a container refers to that container. Use HTTPS for connections outside a trusted local network. Redirects are rejected to prevent forwarding the admin key to another host.

The app saves the admin key in its encrypted vault and returns only display metadata to the browser. It retains the upstream provider badge and uses the existing usage cache. Removing an account only disconnects it from this dashboard. To replace a key, reconnect each affected account using the same instance URL and account selection.

Automatic polling reads `GET /api/v1/admin/accounts/:id`; connection also reads the account list. Clicking an account’s **Refresh** or **Refresh all** additionally requests `GET /api/v1/admin/accounts/:id/usage?source=active&force=true`, then rereads the saved snapshot. OpenAI may run an upstream inference probe, while Claude can still use sub2api’s own cache. Concurrent refreshes share the existing refresh coordination; completed active refreshes are reused for ten seconds and upstream rate-limit cooldowns are respected. The integration never calls the credential-refresh endpoint. Upstream credentials remain owned by sub2api. Claude API-key accounts and OpenAI API-key accounts are not subscription accounts and are excluded.

The quota sample timestamp is shown as a local date/time and relative age, separately from the dashboard's last fetch time and the last completed active-refresh request. A successful refresh request does not guarantee a new upstream sample. OpenAI freshness is based on saved `codex_usage_updated_at`, not the usage endpoint’s response time; Claude OAuth can use the active response’s `updated_at`, which may describe a cached result. SetupToken estimates are not treated as live quota samples. Missing or expired windows remain unknown rather than being inferred as 100% remaining. Samples older than five minutes or without a valid sample time are marked stale and do not trigger notifications. A quiet sub2api account may therefore have no current data until sub2api itself records another sample. ChatGPT plan labels are used when metadata supplies them; Claude currently uses the generic provider label. These fields are version-dependent; see [the source investigation](sub2api-research.md).

### Remote machines

“Connect from this machine” always means the machine running the Next.js server. On a remote server it cannot inspect a visitor's laptop.

With Convex configured, the Claude dialog can generate a short-lived, single-use pairing code and an exact command for the computer holding the Claude Code login. Copy the generated command rather than constructing a target manually. The helper shows the destination and asks for confirmation before it transmits a credential.

## 5. Storage option A: encrypted local file

No storage variables are required. The default files are:

- `.data/vault.enc` — AES-256-GCM encrypted account data;
- `.data/vault.enc.last-good` — previous readable generation, when present;
- `.data/vault.key` — generated local key when no configured secret supplies encryption;
- `.data/token-recovery/` — encrypted crash-recovery journals for rotating tokens.

You may place them on another persistent volume:

```dotenv
VAULT_DATA_DIR=/absolute/private/persistent/path
```

Requirements:

- the directory must persist across restarts and upgrades;
- only the service account should be able to read it;
- back up the entire directory as one unit;
- stop the app or take a filesystem-consistent snapshot before copying;
- never include the directory in an image, deployment bundle, or Git repository.

Losing `vault.key` while the vault depends on it makes the ciphertext unrecoverable. Copying only `vault.enc` is not a backup.

Local file storage is unsuitable for ephemeral or horizontally scaled instances. The app explicitly refuses this fallback on Vercel; use Convex or Redis on any serverless platform.

## 6. Storage option B: Convex

Convex provides the encrypted vault store, cross-instance usage coordination, device pairing, notification state, and scheduler. The provider credentials remain encrypted by the app before Convex receives them.

### Development deployment

Start the Convex setup and follow its project prompts:

```bash
npx convex dev
```

The CLI normally writes `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL` into `.env.local`. Add a strong `VAULT_ACCESS_SECRET` to the same file, then set the identical value in that Convex deployment without putting it in shell history:

```bash
npx convex env set VAULT_ACCESS_SECRET
```

Omitting the value makes the CLI prompt for it. The app accepts the generated `NEXT_PUBLIC_CONVEX_URL` when `VAULT_ACCESS_SECRET` is present. You may instead set the server-only form explicitly:

```dotenv
CONVEX_URL=https://your-deployment.convex.cloud
VAULT_ACCESS_SECRET=<same value stored in Convex>
```

Never prefix the access secret with `NEXT_PUBLIC_`.

### Production deployment

Deploy the Convex functions and schema:

```bash
npx convex deploy
```

Set the production backend secret interactively:

```bash
npx convex env set --prod VAULT_ACCESS_SECRET
```

Copy the production deployment URL from the CLI or Convex dashboard into the Next.js host as `CONVEX_URL`, and put the same access secret in the host as `VAULT_ACCESS_SECRET`.

The URL is not a credential; `VAULT_ACCESS_SECRET` is. Anyone with both can call the secret-gated backend functions, so use a deployment-specific value and do not share a production Convex deployment with an untrusted app.

### Existing notification deployment

Fresh deployments need no migration. If an older release created notification rows before they were scoped to the default self-hosted tenant, deploy the current Convex functions and run once:

```bash
npx convex run migrations:backfillNotifyUserIds --prod
```

The migration is idempotent.

### Access-secret rotation

A fresh Convex vault uses `VAULT_ACCESS_SECRET` as its first server-consistent encryption key and records a proof of that key. Before changing the Convex access secret, preserve the old value as a supported decryption source, deploy and verify the app, and only then update the secret in both the app and Convex.

If you are not certain which key encrypted the current generation, do not rotate it. Back up the ciphertext and test the migration on a copy first.

## 7. Storage option C: Redis/KV REST

The Redis implementation expects an Upstash-compatible REST API, not a `redis://` TCP URL.

Configure either pair:

```dotenv
KV_REST_API_URL=https://your-rest-endpoint
KV_REST_API_TOKEN=<secret token>
VAULT_ENCRYPTION_SECRET=<stable independent random value>
```

or the Upstash aliases:

```dotenv
UPSTASH_REDIS_REST_URL=https://your-rest-endpoint
UPSTASH_REDIS_REST_TOKEN=<secret token>
VAULT_ENCRYPTION_SECRET=<stable independent random value>
```

The app refuses the first Redis vault write without `VAULT_ENCRYPTION_SECRET`; an instance-generated key would not be stable across servers. All old app instances should be drained together when changing the Redis writer protocol or encryption configuration.

Redis provides durable vault storage and distributed refresh coordination. It does not provide the Convex notification scheduler or device-pairing tables.

## 8. Configure notifications

First complete the Convex setup. Then give both the Next.js app and Convex the same scheduler secret.

In the app environment:

```dotenv
APP_URL=https://your-app.example
CRON_SECRET=<independent random value>
```

In the production Convex deployment:

```bash
npx convex env set --prod APP_URL https://your-app.example
npx convex env set --prod CRON_SECRET
```

`APP_URL` must be the public HTTPS origin that reaches this app. The Convex cron runs every five minutes and calls `/api/cron/check`; that route rejects requests without the matching `CRON_SECRET`.

### Browser Web Push

Generate one VAPID key pair:

```bash
npx web-push generate-vapid-keys
```

Store it only in the app environment:

```dotenv
VAPID_PUBLIC=<public key>
VAPID_PRIVATE=<private key>
VAPID_SUBJECT=mailto:operator@example.com
```

Web Push requires a secure browser context (HTTPS, with the normal localhost development exception). Each browser must opt in from the notification panel.

### Telegram

```dotenv
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_CHAT_ID=<destination chat id>
```

Create the bot with BotFather, message it once, and obtain the intended chat id. These variables define one deployment-wide destination, appropriate for this single-tenant edition.

### Generic webhook

```dotenv
WEBHOOK_URL=https://your-receiver.example/usage-events
```

The app sends JSON containing `source`, human-readable `text`, and structured `events`. The receiver should honor the `Idempotency-Key` header because notification delivery is intentionally at least once across a crash between delivery and state commit.

## 9. Build and run in production

Verify the exact checkout before deployment:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Start the production server:

```bash
npm start
```

The default port is 3000. Put a TLS-terminating reverse proxy in front of the process, run it as an unprivileged service account, and keep environment files and persistent vault storage readable only by that account.

The in-process password-login limiter is a safe baseline for one instance, not a distributed denial-of-service control. Multi-instance or public deployments should also enforce rate limits at a trusted proxy, firewall, or WAF.

Keep:

```dotenv
TRUST_PROXY_IP_HEADERS=0
```

Set it to `1` only when the immediate proxy removes client-supplied forwarding headers and writes the authoritative client address. Vercel, Cloudflare Pages, and Fly deployments are recognized by their platform environment, but operators remain responsible for their proxy chain.

### Isolated Docker Compose test deployment

The repository includes a production Docker image and a separate evaluation stack.

The Dockerfile sets `BUILD_STANDALONE=1` during compilation to package its server. Leave this variable unset for ordinary `npm run build` / `npm start` deployments. Run from the repository root:

```bash
docker compose --env-file /dev/null -p how-much-ai-sub2api-test -f compose.test.yaml up -d --build
docker compose --env-file /dev/null -p how-much-ai-sub2api-test -f compose.test.yaml ps
```

Open [http://mt-gpu2.bunny-viper.ts.net:3301](http://mt-gpu2.bunny-viper.ts.net:3301) from a device with Tailscale access to this host. The test stack binds to this host's Tailscale IPv4 address and sets `APP_URL` to this Tailscale DNS origin so same-origin protection works across Docker's port mapping. On another host, update both the published address and `APP_URL` in `compose.test.yaml` to that host's Tailscale IP and browser-facing origin, respectively.

Isolation is deliberate:

- Compose project: `how-much-ai-sub2api-test`; no shared container names or existing networks.
- Binding: `100.126.0.101:3301` on Tailscale, leaving port 3000 and existing instances alone.
- New project-scoped named volume: `test-vault`, mounted at `/app/.data`; no host `.data` bind mount.
- Neither `.env.local` nor existing Convex/Redis configuration is loaded. `--env-file /dev/null` also prevents Compose from loading the repository's `.env` for interpolation.
- `.dockerignore` excludes all environment files, local vaults, and generated artifacts from the build context. The container runs as the unprivileged `node` user.
- The test dashboard is intentionally password-free and bound only to the Tailscale address; access is limited by the tailnet policy. Do not publish it through an external proxy without configuring separate test authentication.

For a sub2api instance published on this Docker host's port 8080, enter `http://host.docker.internal:8080` in the connection form. The Compose file supplies the Linux host-gateway mapping. Do not copy sub2api database files, provider tokens, or the current dashboard's vault into this test volume.

Stop only the test stack, retaining its vault for the next run:

```bash
docker compose --env-file /dev/null -p how-much-ai-sub2api-test -f compose.test.yaml down
```

Do not add `-v` if you want to retain test connections and their encryption key. Rebuilding or recreating the container with the same test volume preserves those connections. Promotion or replacement of an existing deployment is a separate operation after testing; this stack does not perform migration or cutover.

## 10. Back up and upgrade

Before an upgrade:

1. record the current commit;
2. back up the encrypted vault and every key source;
3. back up remote storage through the provider's supported mechanism;
4. keep the old application image or checkout available for rollback;
5. never copy secrets into the repository.

Upgrade:

```bash
git pull --ff-only
npm ci
npm test
npm run typecheck
npm run build
```

If `convex/` changed, deploy the compatible Convex functions before restarting the Next.js app:

```bash
npx convex deploy
```

Then restart the application and verify:

- password login and logout;
- vault load;
- one refresh for each configured provider;
- add/reconnect on a non-critical account;
- notification settings and a browser subscription, when enabled;
- logs contain errors but no credentials.

## 11. Troubleshooting

### The app opens without a login

`APP_PASSWORD` is blank or missing. That is the intended local default. Set it in the runtime environment and restart the already-built server.

If this is an upgrade from a hosted-mode build, remove any stale `AUTH_MODE` variable. Unsupported legacy auth modes deliberately fail closed; this edition requires `APP_PASSWORD` for network access.

### Storage is “partially configured”

One half of a URL/secret pair is missing. Set both values or remove both. A stray `CONVEX_URL` also prevents fallback to a complete Redis configuration because partial remote configuration fails closed.

### Vercel says durable storage is required

Configure Convex or Redis. Vercel's filesystem is not a persistent vault.

### Redis refuses the first account

Set a stable `VAULT_ENCRYPTION_SECRET` before saving any account.

### The vault is unreadable

Do not overwrite it with an empty vault. Restore the exact previous encryption/access/password source and the matching last-known-good backup. Use the in-app archive/recovery action only after preserving the unreadable ciphertext for investigation.

### Notifications are unavailable

Confirm that the app has a complete Convex URL/access-secret pair. For scheduled checks, also verify that production Convex has `APP_URL` and `CRON_SECRET`, and that the app has the matching `CRON_SECRET`. Web Push additionally needs a valid VAPID pair and HTTPS.

### “Connect from this machine” finds the wrong account

The route reads the CLI credential on the server host. Sign that host's CLI into the intended account, use the provider's paste/private sign-in flow, or use the generated Convex pairing command from the computer that holds the desired Claude login.

### Usage says reauthentication is required

Reconnect the selected account. Do not repeatedly retry a shared rotating CLI credential after another client has already replaced it.

## 12. Final exposure checklist

- [ ] `APP_PASSWORD` is set and tested.
- [ ] `AUTH_SECRET` and vault secrets are independent and backed up.
- [ ] The vault backend is durable for the chosen host.
- [ ] The app is reachable only over HTTPS.
- [ ] `TRUST_PROXY_IP_HEADERS` matches the real proxy boundary.
- [ ] `.env*`, `.data/`, provider credentials, and backups are absent from Git and build artifacts.
- [ ] `npm test`, `npm run typecheck`, and `npm run build` pass.
- [ ] Both provider paths needed by the operator have been exercised.
- [ ] Convex cron and notification channels have been verified, if enabled.
- [ ] Recovery and rollback copies can be located without relying on the running server.
