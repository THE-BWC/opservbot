import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	PermissionFlagsBits,
	type ButtonInteraction,
	type Guild
} from 'discord.js';
import { fail, ok, type Reply } from './api.ts';
import { getSetting } from './db.ts';
import { opserv, type KeyRoles, type Member } from './opserv.ts';

/** `members/sync`, `roles/give`, `roles/remove` (SPEC "members/sync by status"). */

const REFUSED: Partial<Record<Member['status'], string>> = {
	banned: 'Member is banned from BWC. If this is in error contact S-1.',
	sentinel: 'Hol up... Member is marked as departed. Please contact S-1 Immediately!',
	ambassador: 'Member is an Ambassador, please contact S-1 to receive Ambassador tags',
	discharged: 'Member is discharged. Cannot give role',
	placeholder: 'Member is a placeholder account'
};

/** No longer members: a refused sync still takes BWC and the tag away (owner, 2026-10-26). */
const STRIPPED: Member['status'][] = ['banned', 'sentinel', 'discharged'];

const TAG = '[BWC] ';

export type Current = { roleIds: Set<string>; nickname: string | null; isOwner: boolean };
export type Plan = {
	add: string[];
	remove: string[];
	nickname?: string | null;
	removedBwc: boolean;
	/** Answer 409 with this, after applying the rest. */
	refuse?: string;
};

/** What a sync should do to a Discord member, from OpServ's view of them. Throws if a key role is unset. */
export function planSync(member: Member, keyRoles: KeyRoles, current: Current): Plan {
	const role = (name: KeyRoles[number]['name']) => {
		const id = keyRoles.find((r) => r.name === name)?.roleId;
		if (!id) throw new Error(`Key role ${name} not set in OpServ`);
		return id;
	};
	const nick = current.nickname;
	const untagged =
		!current.isOwner && nick?.startsWith(TAG) ? nick.slice(TAG.length) || null : undefined;

	const refuse = REFUSED[member.status];
	if (refuse && !STRIPPED.includes(member.status)) {
		return { add: [], remove: [], removedBwc: false, refuse };
	}
	const bwc = role('BWC');
	if (refuse) {
		const removedBwc = current.roleIds.has(bwc);
		return { add: [], remove: removedBwc ? [bwc] : [], nickname: untagged, removedBwc, refuse };
	}

	const guest = role('Guest');
	if (member.status === 'active') {
		const want = (TAG + member.username).slice(0, 32);
		return {
			add: [bwc].filter((r) => !current.roleIds.has(r)),
			remove: [guest].filter((r) => current.roleIds.has(r)),
			nickname: current.isOwner || nick?.includes('[BWC]') ? undefined : want,
			removedBwc: false
		};
	}
	// applicant: not a member yet (owner, SPEC-discord D6 §2)
	return {
		add: [guest].filter((r) => !current.roleIds.has(r)),
		remove: [bwc].filter((r) => current.roleIds.has(r)),
		nickname: untagged,
		removedBwc: current.roleIds.has(bwc)
	};
}

export async function syncMember(guild: Guild, member: Member, discordId: string): Promise<Reply> {
	const gm = await guild.members.fetch(discordId).catch(() => null);
	if (!gm) {
		// Banning someone who already left still keeps them from rejoining.
		if (member.status === 'banned') {
			await botLog(
				guild,
				`<@${discordId}> (${member.username}) is banned in OpServ and not in the server.`,
				[banButton(member.memberId, discordId)]
			);
		}
		return fail(404, `${member.username} is not in the Discord server`);
	}

	const plan = planSync(member, await opserv.keyRoles(), {
		roleIds: new Set(gm.roles.cache.keys()),
		nickname: gm.nickname,
		isOwner: gm.id === guild.ownerId
	});
	if (plan.add.length) await gm.roles.add(plan.add, 'OpServ sync');
	if (plan.remove.length) await gm.roles.remove(plan.remove, 'OpServ sync');
	if (plan.nickname !== undefined) await gm.setNickname(plan.nickname, 'OpServ sync');
	const who = `<@${discordId}> (${member.username})`;
	if (member.status === 'banned') {
		// A Discord ban is hard to undo, so a person confirms it (owner, 2026-10-26).
		const text = plan.removedBwc
			? `Removed BWC from ${who}: OpServ says banned.`
			: `${who} is banned in OpServ.`;
		await botLog(guild, text, [banButton(member.memberId, discordId)]);
	} else if (plan.removedBwc) {
		await botLog(guild, `Removed BWC from ${who}: OpServ says ${member.status}.`);
	}
	if (plan.refuse) return fail(409, plan.refuse + (plan.removedBwc ? ' BWC role removed.' : ''));
	return ok(`Synced ${member.username}`);
}

async function botLog(
	guild: Guild,
	text: string,
	components: ActionRowBuilder<ButtonBuilder>[] = []
) {
	const id = getSetting('log_channel');
	const channel = id ? await guild.channels.fetch(id).catch(() => null) : null;
	if (channel?.isSendable()) {
		await channel.send({ content: text, components, allowedMentions: { parse: [] } });
	} else console.warn(`[LOG] no bot log channel set: ${text}`);
}

export const BAN_PREFIX = 'ban:';

const banButton = (memberId: number, discordId: string) =>
	new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`${BAN_PREFIX}${memberId}:${discordId}`)
			.setLabel('Ban from Discord')
			.setStyle(ButtonStyle.Danger)
	);

/** Why a ban must not go ahead, from OpServ's view right now; undefined = go ahead. */
export function banBlocked(member: Member | null, discordId: string): string | undefined {
	if (!member) return 'Member no longer exists in OpServ.';
	if (member.status !== 'banned')
		return `Member is no longer banned in OpServ (now ${member.status}).`;
	if (member.discordId && member.discordId !== discordId) {
		return 'Member is now linked to a different Discord account.';
	}
}

/** The "Ban from Discord" button on a log post. Re-checks OpServ, so a stale button can't ban. */
export async function onBanButton(i: ButtonInteraction<'cached'>) {
	const ephemeral = (content: string) => i.reply({ content, flags: MessageFlags.Ephemeral });
	if (!i.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
		return ephemeral('You need the Ban Members permission.');
	}
	const [memberId, discordId] = i.customId.slice(BAN_PREFIX.length).split(':');
	const member = await opserv.member(Number(memberId));
	const blocked = banBlocked(member, discordId);
	if (blocked) return ephemeral(blocked);

	const reason = `Banned in OpServ (member ${memberId}, ${member!.username}), confirmed by ${i.user.username}`;
	try {
		await i.guild.bans.create(discordId, { reason });
	} catch (err) {
		return ephemeral(`Ban failed: ${err instanceof Error ? err.message : err}`);
	}
	await i.update({
		content: `${i.message.content}\nBanned from Discord by ${i.user}.`,
		components: [],
		allowedMentions: { parse: [] }
	});
}

export async function membersSync(guild: Guild, b: { memberId: number; discordId: string }) {
	const member = await opserv.member(b.memberId);
	if (!member) return fail(404, `Member ${b.memberId} not found in OpServ`);
	return syncMember(guild, member, b.discordId);
}

export async function changeRole(
	guild: Guild,
	b: { discordId: string; roleId: string },
	action: 'give' | 'remove'
): Promise<Reply> {
	if (!guild.roles.cache.has(b.roleId))
		return fail(404, `Role ${b.roleId} is not in the Discord server`);
	const gm = await guild.members.fetch(b.discordId).catch(() => null);
	if (!gm) {
		// Someone who left the server has nothing to remove (discharge, unlink): that's done, not failed.
		return action === 'remove'
			? ok('Not in the Discord server; nothing to remove')
			: fail(404, 'Not in the Discord server');
	}
	if (action === 'give') await gm.roles.add(b.roleId, 'OpServ');
	else await gm.roles.remove(b.roleId, 'OpServ');
	return ok(action === 'give' ? 'Role added' : 'Role removed');
}
