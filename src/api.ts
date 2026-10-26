import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import { config } from './config.ts';
import { OpservError } from './opserv.ts';
import { report } from './sentry.ts';

/**
 * The bot API OpServ calls (`../OpServ-V10/docs/bot-api.md`, "Bot API"). 2xx = done, anything else
 * = failed with `{ message }`, which OpServ shows the admin. OpServ waits 5 s and never retries.
 */

const snowflake = z.string().regex(/^\d{17,20}$/);
const memberRole = z.object({
	memberId: z.number().int(),
	discordId: snowflake,
	roleId: snowflake
});

export const bodies = {
	operationsChanged: z.object({
		operationId: z.number().int(),
		change: z.enum(['created', 'updated', 'deleted'])
	}),
	membersSync: z.object({ memberId: z.number().int(), discordId: snowflake }),
	memberRole
};

export type Reply = { status: number; body: unknown };
export const ok = (message?: string): Reply => ({ status: 200, body: message ? { message } : {} });
export const fail = (status: number, message: string): Reply => ({ status, body: { message } });

export type Handlers = {
	healthy: () => boolean;
	operationsChanged: (b: z.infer<typeof bodies.operationsChanged>) => Promise<Reply>;
	membersSync: (b: z.infer<typeof bodies.membersSync>) => Promise<Reply>;
	rolesGive: (b: z.infer<typeof memberRole>) => Promise<Reply>;
	rolesRemove: (b: z.infer<typeof memberRole>) => Promise<Reply>;
	roles: () => Promise<Reply>;
	voiceChannels: () => Promise<Reply>;
};

const PREFIX = '/opserv/v1/';
const digest = (s: string) => createHash('sha256').update(s).digest();
const TOKEN = digest(`Bearer ${config.DISCORD_BOT_API_TOKEN}`);

function authorized(req: IncomingMessage) {
	return timingSafeEqual(digest(req.headers.authorization ?? ''), TOKEN);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	let raw = '';
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > 65_536) throw new Error('too large');
	}
	return JSON.parse(raw);
}

export function createApi(h: Handlers, onError = report) {
	const routes: Record<string, { method: 'GET' | 'POST'; run: (body: unknown) => Promise<Reply> }> =
		{
			'operations/changed': {
				method: 'POST',
				run: (b) => h.operationsChanged(bodies.operationsChanged.parse(b))
			},
			'members/sync': { method: 'POST', run: (b) => h.membersSync(bodies.membersSync.parse(b)) },
			'roles/give': { method: 'POST', run: (b) => h.rolesGive(memberRole.parse(b)) },
			'roles/remove': { method: 'POST', run: (b) => h.rolesRemove(memberRole.parse(b)) },
			roles: { method: 'GET', run: () => h.roles() },
			'voice-channels': { method: 'GET', run: () => h.voiceChannels() }
		};

	async function handle(req: IncomingMessage): Promise<Reply> {
		const path = new URL(req.url ?? '/', 'http://bot').pathname;
		if (path === '/healthz') return h.healthy() ? ok('ok') : fail(503, 'Discord not ready');
		if (!path.startsWith(PREFIX)) return fail(404, 'Not found');
		if (!authorized(req)) return fail(401, 'Unauthorized');

		const route = routes[path.slice(PREFIX.length)];
		if (!route) return fail(404, 'Not found');
		if (req.method !== route.method) return fail(405, 'Method not allowed');

		let body: unknown;
		if (route.method === 'POST') {
			try {
				body = await readJson(req);
			} catch {
				return fail(400, 'Body must be JSON');
			}
		}
		try {
			return await route.run(body);
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, `Bad body: ${z.prettifyError(err)}`);
			onError(`API ${req.method} ${path}`, err);
			if (err instanceof OpservError) return fail(502, err.message);
			return fail(500, err instanceof Error ? err.message : 'Internal error');
		}
	}

	return createServer(async (req, res) => {
		const { status, body } = await handle(req);
		res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
	});
}
