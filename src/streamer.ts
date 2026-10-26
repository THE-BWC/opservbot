import { ActivityType, type Presence } from 'discord.js';
import { config } from './config.ts';
import { opserv } from './opserv.ts';

/** BWC members get the streamer role while they're live (legacy presenceUpdate). */

let bwc: { roleId: string | null; at: number } = { roleId: null, at: 0 };

async function bwcRoleId() {
	if (Date.now() - bwc.at > 5 * 60_000) {
		const roles = await opserv.keyRoles();
		bwc = { roleId: roles.find((r) => r.name === 'BWC')?.roleId ?? null, at: Date.now() };
	}
	return bwc.roleId;
}

export async function onPresence(p: Presence) {
	const gm = p.member;
	if (!gm || gm.user.bot || p.guild?.id !== config.DISCORD_GUILD_ID) return;
	const live = p.activities.some((a) => a.type === ActivityType.Streaming);
	const has = gm.roles.cache.has(config.STREAMER_ROLE_ID);
	if (live === has) return;
	if (live) {
		const bwcRole = await bwcRoleId();
		if (bwcRole && gm.roles.cache.has(bwcRole))
			await gm.roles.add(config.STREAMER_ROLE_ID, 'Streaming');
	} else {
		await gm.roles.remove(config.STREAMER_ROLE_ID, 'Stopped streaming');
	}
}
