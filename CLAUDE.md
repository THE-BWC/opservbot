# OpServBot

BWC's Discord bot, rewritten from scratch to work against OpServ V10. Replaces `../Discord_OpServBot`
(legacy, kept for reference only — never edit it, never copy its code; port behaviour, not code).

## Source of truth

- **Contract:** `../OpServ-V10/docs/bot-api.md` (generated from V10's zod schemas). It wins over
  everything else, including this file. Never change it from here; contract changes are asked for
  in OpServ-V10 ("Ask first" in its `SPEC-discord.md`).
- **What the bot does:** `SPEC.md` in this repo (decisions, behaviour, open questions).
- **Why V10 wants it:** `../OpServ-V10/SPEC-discord.md` § "Bot changes (owner's side, D6)".

## Tech stack

- Node 26, TypeScript run natively (type stripping; no build step, no `tsc` emit), ESM, pnpm.
- discord.js 14, zod 4, html-to-text. Bot state in SQLite via built-in `node:sqlite`.
- HTTP server: `node:http` (no Express). Scheduling: one 1-minute tick (no cron lib).
- Tests: vitest. Config: env vars only (no `settings.json`).

## Commands

- pnpm isn't on PATH outside mise: use `npx -y pnpm@10.34.7 <cmd>`.
- Run: `pnpm start` (`node --env-file-if-exists=.env src/main.ts`)
- Test: `pnpm test`
- Lint: `pnpm lint` (prettier check + eslint)
- Type check: `pnpm check` (`tsc --noEmit`)
- Format: `pnpm format` (prettier)

## Conventions (match OpServ-V10)

- Tabs, single quotes, no trailing commas, print width 100.
- Imports use the `.ts` extension. Only erasable TS syntax (no `enum`, no namespaces, no
  parameter properties) — Node strips types, it doesn't compile them.
- Plain functions and modules; no classes-as-namespaces, no `client.xController` bag.
- Every read API response is parsed with its zod schema (in `src/opserv.ts`) before use.
- Every bot API body is parsed with zod; bad body → 400 `{ message }`.
- Failures are real status codes with `{ message }` — never 200 with "ERROR - …".
- Tests sit next to source: `members.ts` → `members.test.ts`. Test pure logic (decisions,
  formatting, auth); don't mock discord.js wholesale.

## Boundaries

- **Always:** check `DISCORD_BOT_API_TOKEN` in constant time on every bot API request; parse
  read API responses with zod; treat operation data as OPSEC-sensitive.
- **Errors:** report unexpected failures with `report(where, err)` from `src/sentry.ts` (logs the stack
  only, sends to Sentry, throttled); never `console.error(…, err)`: Node prints the error's fields, and
  a discord.js error carries the OPSEC embed it failed to post.
- **Never:** log OPSEC op details (names, descriptions) — log ids only; post an OPSEC op anywhere
  but its game's channel; create a Discord scheduled event for an OPSEC op; connect to
  OpServ's or XenForo's database; commit `.env` or the SQLite file.
- **Security (same as OpServ-V10):** exact versions only (`.npmrc`); nothing younger than 7 days
  (`pnpm-workspace.yaml`, `renovate.json`); no dependency install scripts; GitHub Actions pinned by
  commit SHA with `persist-credentials: false` and read-only tokens; the image is scanned (Trivy)
  before it's pushed, signed (Cosign) and ships no npm. `.github/workflows/security.yml` mirrors V10's.
- **Ask first:** adding a dependency; changing a slash command's name/options (users rely on
  them); anything that needs a contract change.
