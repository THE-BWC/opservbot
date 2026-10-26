import { z } from 'zod';
import { config } from './config.ts';

/**
 * Client for OpServ's read API. The schemas mirror `../OpServ-V10/docs/bot-api.md` ("Read API");
 * every response is parsed, so a contract drift fails loudly here instead of deep in Discord code.
 */

const time = z.iso.datetime({ offset: true });
const snowflake = z.string().regex(/^\d{17,20}$/);

export const schemas = {
	member: z.object({
		memberId: z.number().int(),
		username: z.string(),
		discordId: snowflake.nullable(),
		status: z.enum([
			'active',
			'applicant',
			'ambassador',
			'discharged',
			'sentinel',
			'banned',
			'placeholder'
		])
	}),
	discordLinks: z.array(
		z.object({
			memberId: z.number().int(),
			username: z.string(),
			discordId: snowflake,
			discordUsername: z.string().nullable()
		})
	),
	upcoming: z.array(
		z.object({
			id: z.number().int(),
			name: z.string(),
			typeName: z.string(),
			startsAt: time,
			endsAt: time,
			leaderId: z.number().int(),
			leaderUsername: z.string(),
			gameId: z.number().int(),
			gameTag: z.string(),
			gameName: z.string(),
			isOpsec: z.boolean(),
			updatedAt: time.nullable()
		})
	),
	operation: z.object({
		id: z.number().int(),
		name: z.string(),
		isCompleted: z.boolean(),
		isOpsec: z.boolean(),
		startsAt: time,
		endsAt: time,
		leaderId: z.number().int(),
		gameId: z.number().int(),
		gameTag: z.string(),
		gameName: z.string(),
		description: z.string(),
		discordVoiceChannelId: snowflake.nullable(),
		discordEventLocation: z.string().nullable(),
		updatedAt: time.nullable()
	}),
	games: z.array(
		z.object({
			id: z.number().int(),
			name: z.string(),
			tag: z.string(),
			opsecDiscordRoleId: snowflake.nullable()
		})
	),
	// Verify and Unsigned were dropped (owner, 2026-10-26). Rows the bot doesn't use are ignored, so this
	// parses both before and after OpServ stops sending them.
	keyRoles: z
		.array(z.object({ name: z.string(), roleId: snowflake.nullable() }))
		.transform((rows) =>
			rows.filter((r): r is { name: 'BWC' | 'Guest'; roleId: string | null } =>
				['BWC', 'Guest'].includes(r.name)
			)
		)
};

export type Member = z.infer<typeof schemas.member>;
export type UpcomingOp = z.infer<typeof schemas.upcoming>[number];
export type Operation = z.infer<typeof schemas.operation>;
export type Game = z.infer<typeof schemas.games>[number];
export type KeyRoles = z.infer<typeof schemas.keyRoles>;

export class OpservError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
	const res = await fetch(`${config.OPSERV_READ_API_URL}/${path}`, {
		headers: { authorization: `Bearer ${config.BOT_READ_API_TOKEN}` },
		signal: AbortSignal.timeout(10_000)
	});
	const body = await res.json().catch(() => null);
	if (!res.ok) {
		throw new OpservError(
			res.status,
			`OpServ ${path}: ${res.status} ${body?.message ?? ''}`.trim()
		);
	}
	return schema.parse(body);
}

/** null when OpServ answers 404 (no such member / op deleted). */
async function getOrNull<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
	try {
		return await get(path, schema);
	} catch (err) {
		if (err instanceof OpservError && err.status === 404) return null;
		throw err;
	}
}

export const opserv = {
	member: (id: number) => getOrNull(`members/${id}/discord`, schemas.member),
	discordLinks: () => get('discord-links', schemas.discordLinks),
	upcoming: (opsec: 'exclude' | 'include') =>
		get(`operations/upcoming?opsec=${opsec}`, schemas.upcoming),
	operation: (id: number) => getOrNull(`operations/${id}`, schemas.operation),
	games: () => get('games', schemas.games),
	keyRoles: () => get('key-roles', schemas.keyRoles)
};
