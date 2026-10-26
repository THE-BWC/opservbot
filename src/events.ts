import {
	DiscordAPIError,
	GuildScheduledEventEntityType,
	GuildScheduledEventPrivacyLevel,
	RESTJSONErrorCodes,
	type Guild,
	type GuildScheduledEventCreateOptions
} from 'discord.js';
import { convert } from 'html-to-text';
import { ok, type Reply } from './api.ts';
import { db } from './db.ts';
import { opserv, type Operation } from './opserv.ts';
import { report } from './sentry.ts';

/** One Discord scheduled event per upcoming non-OPSEC op (SPEC "Event reconcile"). */

type Stored = { event_id: string; op_updated_at: string | null };
export type Action = 'create' | 'edit' | 'delete' | 'none';

export function decide(op: Operation | null, stored: Stored | undefined, now = new Date()): Action {
	const gone = !op || op.isCompleted || op.isOpsec || new Date(op.endsAt) <= now;
	if (gone) return stored ? 'delete' : 'none';
	// A started event can't be moved, and one we never posted is too late to post.
	if (new Date(op.startsAt) <= now) return 'none';
	if (!stored) return 'create';
	return stored.op_updated_at === op.updatedAt ? 'none' : 'edit';
}

export function eventOptions(op: Operation, guild: Guild): GuildScheduledEventCreateOptions {
	const voice = op.discordVoiceChannelId
		? guild.channels.cache.get(op.discordVoiceChannelId)
		: null;
	const base = {
		name: `[${op.gameTag}] - ${op.name}`.slice(0, 100),
		description: convert(op.description, { wordwrap: false }).slice(0, 1000),
		scheduledStartTime: op.startsAt,
		scheduledEndTime: op.endsAt,
		privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly
	};
	return voice?.isVoiceBased()
		? { ...base, entityType: GuildScheduledEventEntityType.Voice, channel: voice }
		: {
				...base,
				entityType: GuildScheduledEventEntityType.External,
				entityMetadata: { location: op.discordEventLocation || 'TBD' }
			};
}

const isUnknownEvent = (err: unknown) =>
	err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownGuildScheduledEvent;

const stmt = {
	get: db.prepare('SELECT event_id, op_updated_at FROM event WHERE operation_id = ?'),
	all: db.prepare('SELECT operation_id FROM event'),
	put: db.prepare(
		`INSERT INTO event (operation_id, event_id, op_updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (operation_id) DO UPDATE SET event_id = excluded.event_id, op_updated_at = excluded.op_updated_at`
	),
	del: db.prepare('DELETE FROM event WHERE operation_id = ?')
};

/** Brings op `id`'s event in line with OpServ. `op` saves the read when the caller already has it. */
export async function reconcile(guild: Guild, id: number, op?: Operation | null): Promise<string> {
	op ??= await opserv.operation(id);
	const stored = stmt.get.get(id) as Stored | undefined;
	const action = decide(op, stored);

	if (action === 'delete' && stored) {
		await guild.scheduledEvents.delete(stored.event_id).catch((err) => {
			if (!isUnknownEvent(err)) throw err;
		});
		stmt.del.run(id);
		return 'Event removed';
	}
	if (!op || action === 'none') return 'No event change';

	if (action === 'edit' && stored) {
		try {
			await guild.scheduledEvents.edit(stored.event_id, eventOptions(op, guild));
			stmt.put.run(id, stored.event_id, op.updatedAt);
			return 'Event updated';
		} catch (err) {
			if (!isUnknownEvent(err)) throw err; // deleted by hand in Discord: post it again
		}
	}
	const event = await guild.scheduledEvents.create(eventOptions(op, guild));
	stmt.put.run(id, event.id, op.updatedAt);
	return 'Event created';
}

export async function operationsChanged(guild: Guild, b: { operationId: number }): Promise<Reply> {
	return ok(await reconcile(guild, b.operationId));
}

/** On startup: catch up on everything missed while the bot was down. */
export async function syncAll(guild: Guild) {
	const upcoming = await opserv.upcoming('exclude');
	const ids = new Set([
		...upcoming.map((op) => op.id),
		...(stmt.all.all() as { operation_id: number }[]).map((r) => r.operation_id)
	]);
	for (const id of ids) {
		const listed = upcoming.find((op) => op.id === id);
		const stored = stmt.get.get(id) as Stored | undefined;
		if (listed && stored && listed.updatedAt === stored.op_updated_at) continue;
		await reconcile(guild, id).catch((err) => report(`EVENTS op ${id}`, err));
	}
}
