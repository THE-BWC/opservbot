import { EmbedBuilder, type Guild } from 'discord.js';
import { config } from './config.ts';
import { db, getSetting, setSetting } from './db.ts';
import { opserv, type UpcomingOp } from './opserv.ts';

/** Daily op list and 30-minute notices (SPEC "Background"). OPSEC ops only ever go to their game's channel. */

const RED = 0xc80000;
const PER_EMBED = 15;
const NOTIFY_BEFORE_MS = 30 * 60_000;

export function gameChannels(): Map<number, string> {
	const rows = db.prepare('SELECT game_id, channel_id FROM game_channel').all();
	return new Map(rows.map((r) => [r.game_id as number, r.channel_id as string]));
}

/** Where an op is posted: its game's channel, else the announcement channel unless it's OPSEC. */
export function targetChannel(
	op: UpcomingOp,
	channels: Map<number, string>,
	announcement: string | undefined
): string | undefined {
	return channels.get(op.gameId) ?? (op.isOpsec ? undefined : announcement);
}

export function groupByChannel(
	ops: UpcomingOp[],
	channels: Map<number, string>,
	announcement: string | undefined
) {
	const groups = new Map<string, UpcomingOp[]>();
	const skipped: number[] = [];
	for (const op of ops) {
		const target = targetChannel(op, channels, announcement);
		if (!target) skipped.push(op.id);
		else groups.set(target, [...(groups.get(target) ?? []), op]);
	}
	return { groups, skipped };
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function opField(op: UpcomingOp) {
	return {
		name: `[${op.gameTag}] ${op.gameName}`,
		value: [
			`**Op Name:** ${op.name}`,
			`**Op Type:** ${op.typeName}`,
			`**Op Leader:** ${op.leaderUsername}`,
			`**Start Time:** <t:${unix(op.startsAt)}:F> (<t:${unix(op.startsAt)}:R>)`,
			`Go to [OpServ](${config.OPSERV_PUBLIC_URL}/operations/${op.id}) for more info!`
		].join('\n')
	};
}

export function listEmbeds(ops: UpcomingOp[]): EmbedBuilder[] {
	const embeds = [];
	for (let i = 0; i < ops.length; i += PER_EMBED) {
		embeds.push(
			new EmbedBuilder()
				.setTitle('Upcoming Operations')
				.setColor(RED)
				.addFields(ops.slice(i, i + PER_EMBED).map(opField))
		);
	}
	return embeds;
}

async function send(guild: Guild, channelId: string, embeds: EmbedBuilder[]) {
	const channel = await guild.channels.fetch(channelId).catch(() => null);
	if (!channel?.isSendable()) {
		console.warn(`[POSTS] channel ${channelId} missing or not sendable`);
		return;
	}
	for (const embed of embeds) await channel.send({ embeds: [embed] });
}

export async function postOpList(guild: Guild) {
	const ops = await opserv.upcoming('include');
	const { groups, skipped } = groupByChannel(
		ops,
		gameChannels(),
		getSetting('announcement_channel')
	);
	if (skipped.length) console.warn(`[POSTS] ops with no channel to go to: ${skipped.join(', ')}`);
	for (const [channelId, list] of groups) await send(guild, channelId, listEmbeds(list));
}

/** New York date if it's 07:00 or later there and today's list hasn't gone out yet. */
export function opListDue(now: Date, lastDate: string | undefined): string | undefined {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: 'America/New_York',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(now);
	const part = (type: string) => parts.find((p) => p.type === type)!.value;
	const date = `${part('year')}-${part('month')}-${part('day')}`;
	return Number(part('hour')) >= 7 && date !== lastDate ? date : undefined;
}

export async function postOpListIfDue(guild: Guild, now = new Date()) {
	const date = opListDue(now, getSetting('oplist_last_date'));
	if (!date) return;
	setSetting('oplist_last_date', date); // first, so a failure doesn't repost every minute
	await postOpList(guild);
}

export function dueForNotice(ops: UpcomingOp[], now: Date, notified: (op: UpcomingOp) => boolean) {
	return ops.filter((op) => {
		const until = Date.parse(op.startsAt) - now.getTime();
		return until > 0 && until <= NOTIFY_BEFORE_MS && !notified(op);
	});
}

const notifiedStmt = {
	has: db.prepare('SELECT 1 FROM notified WHERE operation_id = ? AND starts_at = ?'),
	add: db.prepare('INSERT OR IGNORE INTO notified (operation_id, starts_at) VALUES (?, ?)'),
	prune: db.prepare('DELETE FROM notified WHERE starts_at < ?')
};

export async function notify(guild: Guild, now = new Date()) {
	const ops = await opserv.upcoming('include');
	const due = dueForNotice(ops, now, (op) => !!notifiedStmt.has.get(op.id, op.startsAt));
	const channels = gameChannels();
	const announcement = getSetting('announcement_channel');
	for (const op of due) {
		notifiedStmt.add.run(op.id, op.startsAt);
		const target = targetChannel(op, channels, announcement);
		if (!target) continue;
		const minutes = Math.ceil((Date.parse(op.startsAt) - now.getTime()) / 60_000);
		await send(guild, target, [
			new EmbedBuilder()
				.setTitle(`Operation Starting in ${minutes} Minutes!`)
				.setColor(RED)
				.addFields(opField(op))
		]);
	}
	notifiedStmt.prune.run(new Date(now.getTime() - 86_400_000).toISOString());
}
