import * as Sentry from '@sentry/node';
import type { ErrorEvent, Event } from '@sentry/node';
import { config } from './config.ts';

/**
 * Error reporting. Errors only, as OpServ-V10 (`sentryOptions` there): no tracing, no personal data.
 * Operation data is OPSEC-sensitive, and discord.js errors carry the request they failed on (an embed
 * with an OPSEC op in it), so nothing but an error's message and stack ever leaves the process:
 * logs print the stack only, console breadcrumbs are dropped, and `scrubEvent` cuts the rest.
 * Discord interaction and webhook URLs carry a token, which is masked everywhere.
 */

const TOKEN_URL = /\/(interactions|webhooks)\/(\d+)\/[\w.-]+/g;
const scrub = (text: string | undefined) => text?.replace(TOKEN_URL, '/$1/$2/<token>');

/** Contexts the SDK fills in itself; anything else (e.g. an error's own fields) is dropped. */
const SAFE_CONTEXTS = new Set([
	'app',
	'cloud_resource',
	'culture',
	'device',
	'os',
	'runtime',
	'trace'
]);

export function sentryOptions(dsn: string, environment: string, release?: string) {
	return {
		dsn,
		environment,
		release,
		// SDK 11 collects all of this unless told not to.
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: false,
			httpBodies: [],
			urlQueryParams: false,
			databaseQueryData: false,
			stackFrameVariables: false
		},
		tracesSampleRate: 0,
		beforeBreadcrumb: (b: Sentry.Breadcrumb) => (b.category === 'console' ? null : b),
		beforeSend: (event: ErrorEvent) => scrubEvent(event)
	} satisfies Sentry.NodeOptions;
}

export function scrubEvent<T extends Event>(event: T): T {
	if (event.request) {
		event.request.url = scrub(event.request.url);
		delete event.request.cookies;
		delete event.request.headers;
		delete event.request.query_string;
		delete event.request.data;
	}
	event.message = scrub(event.message);
	for (const ex of event.exception?.values ?? []) ex.value = scrub(ex.value);
	for (const b of event.breadcrumbs ?? []) {
		b.message = scrub(b.message);
		if (b.data && typeof b.data.url === 'string') b.data.url = scrub(b.data.url);
	}
	for (const key of Object.keys(event.contexts ?? {})) {
		if (!SAFE_CONTEXTS.has(key)) delete event.contexts![key];
	}
	delete event.extra;
	delete event.user;
	return event;
}

if (config.SENTRY_DSN) {
	Sentry.init(sentryOptions(config.SENTRY_DSN, config.SENTRY_ENVIRONMENT, config.SENTRY_RELEASE));
}

// ponytail: in-memory throttle, so a restart re-reports; fine for one process.
const THROTTLE_MS = 3_600_000;
const lastSent = new Map<string, number>();

/** True the first time `key` is seen, then again only after an hour (OpServ down = 3 jobs failing every minute). */
export function shouldSend(key: string, now = Date.now()) {
	if (now - (lastSent.get(key) ?? 0) < THROTTLE_MS) return false;
	lastSent.set(key, now);
	return true;
}

const describe = (err: unknown) =>
	err instanceof Error ? (err.stack ?? err.message) : String(err);

/** An unexpected failure: stack to the log (never the error's fields), and once an hour to Sentry. */
export function report(where: string, err: unknown) {
	console.error(`[${where}] ${describe(err)}`);
	const message = err instanceof Error ? err.message : String(err);
	if (shouldSend(`${where}:${message}`)) {
		Sentry.captureException(err, { tags: { where } });
	}
}

/** A misconfiguration someone should fix (ids only in `message`). */
export function warn(where: string, message: string) {
	console.warn(`[${where}] ${message}`);
	if (shouldSend(`${where}:${message}`))
		Sentry.captureMessage(message, { level: 'warning', tags: { where } });
}

/** Wraps a scheduled job in a Sentry Crons check-in, so a missed or failed run alerts. */
export const monitored = <T>(slug: string, schedule: string, run: () => Promise<T>) =>
	Sentry.withMonitor(slug, run, {
		schedule: { type: 'crontab', value: schedule },
		timezone: 'America/New_York',
		checkinMargin: 10,
		maxRuntime: 10
	});
