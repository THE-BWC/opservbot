# Spec: OpServBot

Status: **Approved 2026-10-26** — defaults marked _(default)_ stand until the owner says otherwise.

## Objective

Rewrite `Discord_OpServBot` (commit `d5d98e7`) so that it:

1. serves the **bot API** in `../OpServ-V10/docs/bot-api.md` (OpServ → bot);
2. reads OpServ only through the **read API** in the same doc (no MySQL, no XenForo);
3. keeps BWC's Discord-side features: op events, OPSEC op lists/notifications, Rapid Response,
   streamer role.

Success = every row in "Behaviour" works against a V10 instance, with no database credentials
other than the bot's own SQLite file.

## Decisions (owner, 2026-10-26)

| #   | Decision                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | TypeScript like V10: Node 26 native TS, pnpm, vitest, zod                                                                                                                                      |
| 2   | Bot state in SQLite (`node:sqlite`), file on a Docker volume                                                                                                                                   |
| 3   | Fresh repo (`OpServBot`); legacy repo stays untouched for reference                                                                                                                            |
| 4   | Keep Rapid Response and streamer role. Moderation (`/lock`, `/lockdown`, `/prune`) dropped                                                                                                     |
| 5   | Info commands only "if they make sense" → all dropped _(default)_: Discord shows server/user/role info natively; `/ping`, `/uptime`, `/info`, `/systeminfo` are covered by `/healthz` and logs |

## Configuration (env)

| Var                     | Use                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`         | bot login                                                                                                                                                 |
| `DISCORD_GUILD_ID`      | the one BWC guild (single-guild; legacy's multi-guild tables dropped)                                                                                     |
| `OPSERV_READ_API_URL`   | `http://opserv:3000/api/bot/v1`                                                                                                                           |
| `BOT_READ_API_TOKEN`    | bot → OpServ                                                                                                                                              |
| `DISCORD_BOT_API_TOKEN` | OpServ → bot (checked)                                                                                                                                    |
| `OPSERV_PUBLIC_URL`     | link base for posts → `${url}/operations/{id}`. Staging `https://opserv-staging.blackwidowcompany.com`, production `https://opserv.blackwidowcompany.com` |
| `PORT`                  | default `4500`; bot API at `/opserv/v1/*`, health at `/healthz`                                                                                           |
| `DB_PATH`               | default `data/bot.db`                                                                                                                                     |
| `STREAMER_ROLE_ID`      | streamer role                                                                                                                                             |

Rapid Response ids (channel, roles, emojis) live in one const table in `src/rapid-response.ts`
_(default; they never changed in 3 years — env if a dev guild is needed)_.

## Behaviour

### Bot API (OpServ → bot), `/opserv/v1`

All: `Authorization: Bearer` checked with `timingSafeEqual`, else 401. Unknown path 404, wrong
method 405. Body parsed with zod, else 400. OpServ times out at 5 s, so handlers do the Discord
work inline and stay well under it.

| Endpoint                           | Does                                                                                | Answers                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST operations/changed`          | `GET operations/{id}`; reconcile its scheduled event (below)                        | 200 `{ message }`; 502 if read API fails                                                    |
| `POST members/sync`                | `GET members/{id}/discord`; apply key role + nickname for `discordId` from the body | 200; 404 not in guild; 409 refused status                                                   |
| `POST roles/give` / `roles/remove` | add/remove `roleId` on `discordId`                                                  | 200; 404 role not in guild, or member not in guild on give (remove: 200, nothing to remove) |
| `GET roles`                        | guild roles minus `@everyone`, by position desc                                     | `[{ id, name }]`                                                                            |
| `GET voice-channels`               | guild voice channels, by name                                                       | `[{ id, name }]`                                                                            |

**Event reconcile** (one function, used by `operations/changed` and startup sync):

- op 404, completed, OPSEC, or ended (`endsAt` past) → delete our event if we have one.
- started (`startsAt` past) → leave as is (a started event can't be moved; a restart mid-op mustn't delete it).
- else no event → create; event exists and `updatedAt` differs from stored → edit (re-create if deleted by hand).
- Event: name `[${gameTag}] - ${name}`, description = `description` HTML → text, cut to 1000,
  guild-only; voice channel if `discordVoiceChannelId`, else external at
  `discordEventLocation ?? 'TBD'`.
- _Fixes legacy:_ an op switched to OPSEC used to keep its public event; now it's removed.

**members/sync by `status`** (legacy `syncRole` + `#checkUserGroupIds`, SPEC-discord D6 §2):

| status        | Key roles                                                                 | Nickname                  | Answer                                                                                                           |
| ------------- | ------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `active`      | + BWC, − Guest                                                            | `[BWC] ${username}`       | 200                                                                                                              |
| `applicant`   | + Guest, − BWC; if BWC was removed, say so in the bot log channel (owner) | leading `[BWC] ` stripped | 200                                                                                                              |
| `banned`      | − BWC, logged to the bot log channel (owner)                              | leading `[BWC] ` stripped | 409 "Member is banned from BWC. If this is in error contact S-1." (+ " BWC role removed." if it was)             |
| `sentinel`    | − BWC, logged to the bot log channel (owner)                              | leading `[BWC] ` stripped | 409 "Hol up... Member is marked as departed. Please contact S-1 Immediately!" (+ " BWC role removed." if it was) |
| `ambassador`  | none                                                                      | none                      | 409 "Member is an Ambassador, please contact S-1 to receive Ambassador tags"                                     |
| `discharged`  | − BWC, logged to the bot log channel (owner)                              | leading `[BWC] ` stripped | 409 "Member is discharged. Cannot give role" (+ " BWC role removed." if it was)                                  |
| `placeholder` | none                                                                      | none                      | 409 "Member is a placeholder account" _(default; legacy had no case)_                                            |

Refused syncs apply their role/nickname changes before answering 409, so "Sync perms" cleans up a banned or
departed member. Guild owner: roles applied, nickname skipped (Discord forbids it), still 200. Key role ids from
`GET key-roles`; a null `roleId` → 500 "Key role X not set in OpServ".

`roles/give` does **not** re-check status _(default)_: OpServ already decided; legacy's check
there was a side effect of looking the user up.

### Background (one tick per minute)

| Job            | When                                                | Does                                                                                                                                                                                                                                          |
| -------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event sync     | on ready                                            | reconcile every op in `operations/upcoming?opsec=exclude`; delete stored events whose op isn't there                                                                                                                                          |
| Op list        | daily 07:00 America/New_York, once per day (stored) | `operations/upcoming?opsec=include`; per game channel: that game's ops; announcement channel: **non-OPSEC ops of games without a channel** (owner); an OPSEC op with no game channel is skipped with a warning log (ids only); embeds of ≤ 15 |
| Notify         | every tick                                          | ops starting within 30 min, not yet notified for that `(id, startsAt)` → game channel, else announcement channel if non-OPSEC                                                                                                                 |
| Thread archive | every tick                                          | RR threads idle > 3 h → message, lock, archive, delete starter message                                                                                                                                                                        |

Times in posts use Discord timestamps `<t:…:F>` (each reader's own timezone) instead of
legacy's fixed New York format _(default)_.

### Slash commands (guild-registered on startup; legacy `deploy-commands.js` dropped)

| Command                           | Who                                   | Does                                                                                                                                                                          |
| --------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/setgamechannel game channel`    | Administrator                         | game = autocomplete from `GET games`; channel = channel option (legacy took raw ids)                                                                                          |
| `/setannouncementchannel channel` | Administrator                         |                                                                                                                                                                               |
| `/setlogchannel channel`          | Administrator                         | bot log channel (applicant BWC removals)                                                                                                                                      |
| `/updatenicknames all\|user`      | Administrator                         | `GET discord-links`; `user` runs the members/sync logic; `all` sets `[BWC] name` for linked members holding BWC _(default; legacy renamed every linked member, even non-BWC)_ |
| `/postoplist`                     | Administrator                         | run the op list now (legacy `/getopslist`)                                                                                                                                    |
| `/rapidresponse`                  | Administrator (owner; legacy: anyone) | post the RR panel                                                                                                                                                             |

Dropped: `/emit` (stub), `/getops` (no cache now), `/notify` (tick does it), moderation and info
commands.

### Rapid Response (port as-is, minus the duplication)

Panel with 5 buttons (medical, logistics, prison, combat, economy) → modal (location,
description, voice channel) → public thread in the RR channel pinging `SC RR <Type>`, requester
added; 3 h per-user cooldown per type. Reactions on the panel toggle the 5 notification roles.
Threads tracked in SQLite; a message bumps the 3 h idle timer. One table of 5 types drives
buttons, modals and roles (legacy: 15 near-identical files). Cooldown starts on submit, as legacy;
it's in memory, so a restart resets it _(default)_.

### Streamer role

`presenceUpdate` in the guild: member holding BWC (key role from `GET key-roles`, cached 5 min)
and streaming → add `STREAMER_ROLE_ID`; not streaming → remove.

## Data (SQLite)

```
event        operation_id INTEGER PK, event_id TEXT, op_updated_at TEXT
game_channel game_id INTEGER PK, channel_id TEXT
setting      key TEXT PK, value TEXT          -- announcement_channel, log_channel, oplist_last_date
notified     operation_id INTEGER, starts_at TEXT, PK(operation_id, starts_at)
rr_thread    thread_id TEXT PK, last_activity INTEGER
```

Cutover import, before the bot's first start (`mysql -N … < scripts/export-legacy.sql | pnpm import-legacy`); V10 keeps V9 op and game ids (SPEC-platform): `discord_events` → `event`
(`op_updated_at` NULL, so the first sync edits once), `game_channel`, `guild.announcement_channel`,
`guild.log_channel`.

## Files

```
src/main.ts            client, intents, wiring, tick, command registration
src/config.ts          env → zod
src/opserv.ts          read API client + zod schemas (mirror of the contract)
src/db.ts              node:sqlite schema + queries
src/api.ts             bot API server (node:http)
src/events.ts          scheduled event reconcile + startup sync
src/members.ts         sync/give/remove decisions + nickname
src/op-posts.ts        daily list + notify
src/commands.ts        admin slash commands
src/rapid-response.ts  RR panel/buttons/modals/threads/reaction roles
src/streamer.ts        presence → streamer role
Dockerfile, compose.yml (network opserv_bot, volume ./data)
```

## Testing

- `members.test.ts`: every status → roles/nickname/answer; owner skip.
- `events.test.ts`: reconcile decision for 404 / completed / OPSEC / past / new / unchanged / changed; event options.
- `op-posts.test.ts`: partition per channel (OPSEC never in announcement), chunking, notify window and dedupe.
- `api.test.ts`: 401 missing/wrong token, 400 bad body, 405, 404, happy path with stubbed handlers.
- `opserv.test.ts`: schema parse of the contract's examples; non-2xx → error with `message`.
- Manual: against a dev guild + a V10 staging instance before cutover.

## Resolved (owner, 2026-10-26)

1. OPSEC ops only ever go to their game's channel (never the announcement channel).
2. Public URLs: staging `opserv-staging.blackwidowcompany.com`, production `opserv.blackwidowcompany.com`.
3. An applicant holding BWC: remove BWC, grant Guest, log it to the bot log channel.
4. `/rapidresponse` is admin-only.
5. A sync of a banned, departed (sentinel) or discharged member removes BWC and the `[BWC] ` tag and logs it,
   still answering 409. Ambassadors and placeholders are left alone.
6. A sync of a `banned` member also posts a **"Ban from Discord"** button with its log entry, even if the
   member already left the server. Never automatic: someone with Ban Members clicks it; the bot re-reads
   `members/{id}/discord` at click time and refuses unless the status is still `banned` and the link
   still points to the same account. The ban reason names the OpServ member and the confirming admin,
   and the log post is edited to say who banned. Needs a bot log channel and the bot's Ban Members
   permission.
7. Key roles Verify and Unsigned are gone from Discord (and OpServ, owner's side). The bot uses only BWC
   and Guest and ignores any other `key-roles` row, so it works before and after OpServ drops them.

## Plan

1. Scaffold: package.json, tsconfig, prettier, vitest, config.ts, db.ts, `/healthz`. ✔ boots.
2. `opserv.ts` + tests.
3. `api.ts` (auth, routing, pickers) + tests.
4. `members.ts` (sync/give/remove) + tests.
5. `events.ts` (reconcile, startup sync, `operations/changed`) + tests.
6. `op-posts.ts` + tick + tests.
7. `commands.ts`.
8. `rapid-response.ts`, `streamer.ts`.
9. Docker, compose, legacy import script, README.
