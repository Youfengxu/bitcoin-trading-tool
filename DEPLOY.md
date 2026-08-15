# Self-Hosted Deployment (K11 / Tailscale)

This deploys the trading tool as a Docker Compose stack (app + MariaDB) on
`k11-services` (LXC 101) and exposes it tailnet-only via Tailscale Serve.

Source app was built for the Manus platform; the changes in this repo make
it run standalone:

- `vite-plugin-manus-runtime` removed from the Vite config.
- `notifyOwner()` becomes a no-op when `BUILT_IN_FORGE_API_*` are unset.
- An in-process scheduler ticks `handleHeartbeat()` every minute (Manus
  cron used to call `/api/scheduled/heartbeat`). The handler still gates
  its own work by `strategy_params.heartbeatScheduleMinutes`.
- OAuth, Forge LLM, and the storage proxy degrade gracefully when their
  env vars are blank. All tRPC procedures are already `publicProcedure`.

## Prerequisites

- LXC 101 (`k11-services`, 192.168.100.21) with Docker + Tailscale (already provisioned).
- SSH: `ssh k11-services` from the Mac Studio jump host.

## 1. Get the code onto k11-services

```bash
ssh k11-services
git clone git@github.com:Youfengxu/bitcoin-trading-tool.git /opt/btc-trading
cd /opt/btc-trading
```

(Use HTTPS if the LXC doesn't have a deploy key.)

## 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set:
#   MARIADB_ROOT_PASSWORD, MARIADB_PASSWORD  (any strong strings)
#   JWT_SECRET                              (`openssl rand -hex 32`)
#   APP_PORT                                (default 3002)
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID    (optional)
```

The compose file builds `DATABASE_URL` from the `MARIADB_*` vars — don't
set `DATABASE_URL` in `.env`.

## 3. Build and start

```bash
docker compose up -d --build
```

Compose order:
1. `db` (MariaDB) starts and passes healthcheck.
2. `migrate` runs `pnpm db:push` against the empty DB (one-shot).
3. `app` starts; binds to `127.0.0.1:${APP_PORT}` only.

Logs:
```bash
docker compose logs -f app
```

## 4. Expose via Tailscale Serve

Match the existing pattern in `~/homelab/infrastructure.md` (Open WebUI on
:3000, code-server on :6767). Choose an unused port — `:3002` is suggested.

```bash
# As root on k11-services:
tailscale serve --bg --https=3002 http://localhost:3002
tailscale serve status
```

URL: `https://k11-services.border-balance.ts.net:3002`

> Tailnet-only — do **not** use `tailscale funnel` for this app. Trading
> signals and simulator state are exposed without auth (all procedures
> are `publicProcedure`).

Update the Tailscale Serve table in `~/homelab/infrastructure.md` to record
the mapping.

## 5. Verify

From the Mac Studio (on the tailnet):
```bash
curl -sf https://k11-services.border-balance.ts.net:3002/api/trpc/market.currentPrice
# Should return JSON with the current BTC price.
```

Open the URL in a browser. The SPA should load; the Live Price page should
show real-time BTC; the Strategy Settings page should let you set the
heartbeat interval. Wait one heartbeat interval and check `docker compose
logs app` for a `[Heartbeat]` line.

## Day-to-day workflow (from the Mac)

Develop → verify → push → deploy → check. Deployment stays human-triggered by
design (homelab `CONSTITUTION.md` R1 pins deploys to the `human` tier); these
are shortcuts for the commands, not automation around them.

```bash
pnpm dev             # local server, hot reload
pnpm verify          # tsc --noEmit && vitest run  — run before every push
pnpm deploy:run      # ssh k11 → git pull --ff-only && docker compose up -d --build
pnpm deploy:status   # deployed commit + container status
pnpm deploy:logs     # last 40 lines of the app log
```

Analysis and preflight helpers:

```bash
pnpm okx:check                  # OKX connectivity; reads .env if present
pnpm okx:check -- --order       # one min-size round trip (refuses unless OKX_DEMO=1)
pnpm backtest                   # equity backtest over the live period
pnpm backtest:full              # + held-out period and rolling-block robustness
pnpm replay                     # signal precision/recall study
```

Three things that need more than a `git push`:

- **New environment variable** — add it to `.env.example`, *and* to the service
  in `docker-compose.yml` (variables are passed through explicitly), *and* set
  the value in `/opt/btc-trading/.env` on k11 by hand.
- **Schema change** — run `pnpm db:generate` and commit the file it writes to
  `drizzle/`. `db:push` is `drizzle-kit migrate`; it only applies migrations
  that already exist.
- **New script under `server/`** — the `app` image contains only `dist/`, so run
  it through the `tools` profile. **Rebuild first**: `docker compose run` reuses
  a cached image and will silently execute stale code after a `git pull`.
  ```bash
  docker compose build tools && docker compose run --rm tools pnpm tsx server/scripts/<name>.ts
  ```

## Operations

### Update
```bash
cd /opt/btc-trading
git pull
docker compose up -d --build
```
Or `pnpm deploy:run` from the Mac, which runs exactly this over ssh.

> The script is named `deploy:run`, not `deploy`, because `pnpm deploy` is a
> built-in pnpm command (workspace package deployment) that shadows any script
> of the same name — it fails with `ERR_PNPM_CANNOT_DEPLOY` instead of running
> yours. `deploy:run` also refuses to execute on k11 itself, since it ssh-es
> into k11 and the host has no pnpm; use the two commands above there.

### Reset simulator
Use the in-app "Reset Simulator" button, or:
```bash
docker compose exec db mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" btc_trading \
  -e "DELETE FROM simulator_trades; UPDATE simulator_state SET cash_usd=10000, btc_holding=0, total_value_usd=10000, last_price=0, is_running=1;"
```

### Apply a new migration
After pulling a commit that adds a migration:
```bash
docker compose run --rm migrate
docker compose up -d
```

### Backup
```bash
docker compose exec db mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" btc_trading \
  | gzip > /mnt/storage/backups/btc-trading-$(date +%F).sql.gz
```

The MariaDB volume lives in Docker's default location on the LXC root
disk. For larger retention, move `db_data:` to a bind mount under
`/mnt/storage/btc-trading/db/` (same pattern as Nextcloud / Immich).

## Troubleshooting

- **`app` exits immediately**: `docker compose logs app`. Most often
  `DATABASE_URL` is wrong or migrations haven't run — re-run `docker
  compose run --rm migrate`.
- **No signals being generated**: check Strategy Settings →
  `heartbeatScheduleMinutes` (0 = automation OFF). Logs show
  `[Heartbeat] Signal throttled` or `Signal generation skipped` when
  it's working but not yet due.
- **AI Analyze fails**: it requires `BUILT_IN_FORGE_API_*`. Either set
  them or ignore the feature.
- **OAuth login redirects to `/api/oauth/callback` and 500s**: expected
  — OAuth needs Manus. Users don't need to log in; all trading endpoints
  are public.
