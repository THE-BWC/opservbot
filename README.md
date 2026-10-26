# OpServBot

Black Widow Company's Discord bot. Talks to OpServ V10 only through its HTTP APIs
(`../OpServ-V10/docs/bot-api.md`); keeps its own small state in SQLite. What it does and why: `SPEC.md`.

## Run

```sh
cp .env.example .env   # fill in
pnpm install
pnpm start
```

Docker: `compose.yml` is the production (Portainer) stack. Values come from the stack's environment
(`${VAR:?}` = required), state lives in `${ROOT}/opservbot/data` (writable by uid 1000; back it up),
and it joins the external `opserv_bot` network. OpServ reaches the bot at
`http://opservbot:4500/opserv/v1`. CI publishes `ghcr.io/the-bwc/opservbot:main` (and `:<sha>`),
scanned and signed; check a pulled image with
`cosign verify ghcr.io/the-bwc/opservbot:main --certificate-identity-regexp 'https://github.com/the-bwc/opservbot/' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.

Bot permissions in the guild: Manage Roles, Manage Nicknames, Manage Events, Manage Threads,
Ban Members (only used when an admin confirms a ban; SPEC "Resolved" 6), plus the privileged
Server Members and Presence intents.

## Cutover from Discord_OpServBot

1. Stop the old bot.
2. Before the first start of this one, import the old state (else every event is posted twice):
   `mysql -N bwcsvr_opservIntegration < scripts/export-legacy.sql | docker compose run --rm -T opservbot node scripts/import-legacy.ts`
3. Start it. Slash commands register themselves; the old Rapid Response panel keeps working.

## Develop

`pnpm test`, `pnpm lint`, `pnpm check` (types), `pnpm format`. Security checks run in CI
(`.github/workflows/security.yml`, as in OpServ-V10).
