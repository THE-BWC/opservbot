import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createApi, fail, ok, type Handlers } from './api.ts';
import { OpservError } from './opserv.ts';

const AUTH = { authorization: 'Bearer bot-token-bot-token-bot-token-bot-token' };
const h = {
	healthy: () => true,
	operationsChanged: vi.fn(async () => ok('Event created')),
	membersSync: vi.fn(async () => fail(409, 'Member is banned')),
	rolesGive: vi.fn(async () => {
		throw new OpservError(500, 'OpServ down');
	}),
	rolesRemove: vi.fn(async () => ok()),
	roles: vi.fn(async () => ({ status: 200, body: [{ id: '1', name: 'BWC' }] })),
	voiceChannels: vi.fn(async () => ok())
} satisfies Handlers;

const server = createApi(h, { error: () => {} } as unknown as Console);
let base = '';
beforeAll(async () => {
	await new Promise<void>((r) => server.listen(0, r));
	base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function call(path: string, init: RequestInit = {}) {
	const res = await fetch(base + path, init);
	return { status: res.status, body: await res.json() };
}
const post = (path: string, body: unknown, headers: Record<string, string> = AUTH) =>
	call(path, { method: 'POST', headers, body: JSON.stringify(body) });

test('healthz needs no token', async () => {
	expect(await call('/healthz')).toEqual({ status: 200, body: { message: 'ok' } });
});

test('missing or wrong token is 401', async () => {
	expect((await call('/opserv/v1/roles')).status).toBe(401);
	expect(
		(await call('/opserv/v1/roles', { headers: { authorization: 'Bearer nope' } })).status
	).toBe(401);
});

test('unknown path 404, wrong method 405', async () => {
	expect((await call('/opserv/v1/nope', { headers: AUTH })).status).toBe(404);
	expect((await post('/opserv/v1/roles', {})).status).toBe(405);
});

test('bad body is 400 and never reaches the handler', async () => {
	const r = await post('/opserv/v1/operations/changed', { operationId: 1, change: 'moved' });
	expect(r.status).toBe(400);
	expect(h.operationsChanged).not.toHaveBeenCalled();
	expect((await post('/opserv/v1/members/sync', 'not json')).status).toBe(400);
});

test('passes the parsed body and the handler reply through', async () => {
	const r = await post('/opserv/v1/operations/changed', { operationId: 1, change: 'created' });
	expect(r).toEqual({ status: 200, body: { message: 'Event created' } });
	expect(h.operationsChanged).toHaveBeenCalledWith({ operationId: 1, change: 'created' });
	expect(
		await post('/opserv/v1/members/sync', { memberId: 1, discordId: '123456789012345678' })
	).toEqual({ status: 409, body: { message: 'Member is banned' } });
	expect(await call('/opserv/v1/roles', { headers: AUTH })).toEqual({
		status: 200,
		body: [{ id: '1', name: 'BWC' }]
	});
});

test('OpServ failure during a handler is 502 with the message', async () => {
	const body = { memberId: 1, discordId: '123456789012345678', roleId: '123456789012345679' };
	expect(await post('/opserv/v1/roles/give', body)).toEqual({
		status: 502,
		body: { message: 'OpServ down' }
	});
});
