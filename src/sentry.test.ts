import * as Sentry from '@sentry/node';
import { DiscordAPIError } from 'discord.js';
import { format } from 'node:util';
import { afterAll, expect, test, vi } from 'vitest';
import { report, scrubEvent, sentryOptions, shouldSend } from './sentry.ts';

const SECRET = 'Operation Nightfall at Yela';
const TOKEN = 'aW50ZXJhY3Rpb246MTIzNDU2Nzg5MDEyMzQ1Njc4.secret-token';

test('scrubEvent masks Discord tokens and drops request data, extras, users and error fields', () => {
	const event = scrubEvent({
		message: `POST /api/v10/interactions/123456789012345678/${TOKEN}/callback failed`,
		exception: { values: [{ value: `at /webhooks/111111111111111111/${TOKEN}/messages` }] },
		request: { url: 'http://x', data: SECRET, headers: { authorization: 'Bearer x' } },
		breadcrumbs: [{ data: { url: `https://discord.com/api/v10/webhooks/1/${TOKEN}` } }],
		contexts: { os: { name: 'linux' }, DiscordAPIError: { requestBody: SECRET } },
		extra: { body: SECRET },
		user: { id: '1' }
	});
	const sent = JSON.stringify(event);
	expect(sent).not.toContain(TOKEN);
	expect(sent).not.toContain(SECRET);
	expect(event.message).toBe(
		'POST /api/v10/interactions/123456789012345678/<token>/callback failed'
	);
	expect(event.contexts).toEqual({ os: { name: 'linux' } });
});

test('throttle: once, then again only after an hour', () => {
	expect(shouldSend('k', 0 + 3_600_000)).toBe(true);
	expect(shouldSend('k', 1_000 + 3_600_000)).toBe(false);
	expect(shouldSend('k', 7_200_001)).toBe(true);
});

// End to end through the real SDK: a failed post of an OPSEC embed never leaves the process.
// The spy goes in before init, so Sentry's console breadcrumbs wrap it (as they wrap the real console).
const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
const envelopes: unknown[] = [];
Sentry.init({
	...sentryOptions('https://public@o0.ingest.sentry.io/1', 'test'),
	transport: () => ({
		send: async (envelope) => (envelopes.push(envelope), {}),
		flush: async () => true
	})
});
afterAll(() => {
	logged.mockRestore();
	return Sentry.close();
});

test('a Discord error carrying an OPSEC embed reaches neither Sentry nor the log', async () => {
	const err = new DiscordAPIError(
		{ code: 50035, message: 'Invalid Form Body' },
		50035,
		400,
		'POST',
		`https://discord.com/api/v10/webhooks/123456789012345678/${TOKEN}`,
		{ body: { content: SECRET, embeds: [{ fields: [{ name: 'Op', value: SECRET }] }] } }
	);
	console.error('[POSTS]', err); // what a careless log line would do: becomes a console breadcrumb
	report('POSTS', err);
	await Sentry.flush(2000);

	const sent = JSON.stringify(envelopes);
	expect(sent).toContain('Invalid Form Body'); // the error did arrive
	expect(sent).not.toContain(SECRET);
	expect(sent).not.toContain(TOKEN);
	// What the container log shows (console formats with util.format): report() prints the stack only.
	expect(format(...logged.mock.calls.at(-1)!)).not.toContain(SECRET);
	// Sanity: the careless line above does leak, so the assertions above can fail.
	expect(format(...logged.mock.calls.at(-2)!)).toContain(SECRET);
});
