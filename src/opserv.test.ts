import { afterEach, expect, test, vi } from 'vitest';
import { opserv, OpservError } from './opserv.ts';

function stubFetch(status: number, body: unknown) {
	const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

afterEach(() => vi.unstubAllGlobals());

const op = {
	id: 7,
	name: 'Op',
	isCompleted: false,
	isOpsec: false,
	startsAt: '2026-11-01T19:00:00.000Z',
	endsAt: '2026-11-01T21:00:00.000Z',
	leaderId: 1,
	gameId: 2,
	gameTag: 'SC',
	gameName: 'Star Citizen',
	description: '<p>Hi</p>',
	discordVoiceChannelId: null,
	discordEventLocation: null,
	updatedAt: null
};

test('sends the bearer token and parses the response', async () => {
	const fetch = stubFetch(200, op);
	expect(await opserv.operation(7)).toEqual(op);
	expect(fetch).toHaveBeenCalledWith(
		'http://opserv.test/api/bot/v1/operations/7',
		expect.objectContaining({ headers: { authorization: 'Bearer read-token' } })
	);
});

test('404 is null', async () => {
	stubFetch(404, { message: 'Not found' });
	expect(await opserv.operation(7)).toBeNull();
});

test('other errors throw with the status and message', async () => {
	stubFetch(401, { message: 'Unauthorized' });
	await expect(opserv.games()).rejects.toThrow(
		new OpservError(401, 'OpServ games: 401 Unauthorized')
	);
});

test('a response off the contract throws', async () => {
	stubFetch(200, { ...op, discordVoiceChannelId: '123' });
	await expect(opserv.operation(7)).rejects.toThrow();
});

test('key roles: rows other than BWC and Guest are ignored', async () => {
	stubFetch(200, [
		{ name: 'BWC', roleId: '123456789012345678' },
		{ name: 'Guest', roleId: null },
		{ name: 'Verify', roleId: '123456789012345679' }
	]);
	expect(await opserv.keyRoles()).toEqual([
		{ name: 'BWC', roleId: '123456789012345678' },
		{ name: 'Guest', roleId: null }
	]);
});
