import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	LabelBuilder,
	MessageFlags,
	MessageType,
	ModalBuilder,
	PermissionFlagsBits,
	SlashCommandBuilder,
	TextInputBuilder,
	TextInputStyle,
	type AnyThreadChannel,
	type ButtonInteraction,
	type Guild,
	type Message,
	type MessageReaction,
	type ModalSubmitInteraction,
	type PartialMessageReaction
} from 'discord.js';
import type { Command } from './commands.ts';
import { db } from './db.ts';

/**
 * Rapid Response (SPEC "Rapid Response"): a panel of 5 buttons → modal → a thread pinging that
 * type's responders. Reactions on the panel toggle the responder roles. Threads idle for 3 h are
 * archived. Custom ids match the legacy bot's, so the panel already posted keeps working.
 */

// ponytail: guild ids hard-coded as in legacy; move to env if a dev guild ever needs them.
const CHANNEL_ID = '1040786857824358471';
const TYPES = [
	{
		id: 'rr-medical',
		label: 'Medical',
		emoji: '1041065437405925489',
		reaction: 'emergencystar',
		role: '1041066364179316806'
	},
	{
		id: 'rr-logistics',
		label: 'Logistics',
		emoji: '1041065417147420742',
		reaction: 'logistics',
		role: '1041066445272010763'
	},
	{
		id: 'rr-prison',
		label: 'Prison',
		emoji: '1041065403545301072',
		reaction: 'prison',
		role: '1041066517325959288'
	},
	{
		id: 'rr-combat',
		label: 'Combat',
		emoji: '1041065389452435456',
		reaction: 'combat',
		role: '1041066631725600798'
	},
	{
		id: 'rr-econ',
		label: 'Economy',
		emoji: '1041065454338318416',
		reaction: 'economy',
		role: '1041066768321482892'
	}
];
const COOLDOWN_MS = 3 * 3_600_000;
const IDLE_MS = 3 * 3_600_000;

// ponytail: in memory, so a restart clears cooldowns; persist if people start abusing that.
const cooldowns = new Map<string, number>();

const typeOf = (customId: string) => TYPES.find((t) => t.id === customId);

export const rrCommand: Command = {
	data: new SlashCommandBuilder()
		.setName('rapidresponse')
		.setDescription('Posts the Rapid Response panel')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
	async execute(i) {
		const channel = await i.guild.channels.fetch(CHANNEL_ID);
		if (!channel?.isSendable())
			return i.reply({
				content: 'Rapid Response channel not found.',
				flags: MessageFlags.Ephemeral
			});
		const embed = new EmbedBuilder()
			.setTitle('Rapid Response')
			.setColor(0xc80000)
			.setDescription(
				'- All BWC members with OPsec clearance may request for combat, medical, or logistical assistance in the Rapid Response channel by filling out the requisite form. Any abuse or excessive spam of the channel will waive your request and may result in disciplinary action. The Rapid Response channel is a privilege, not a right.\n\n' +
					'- When making an assistance request, you must be in a BWC-SC voice channel in order to coordinate with the responders. Failure to do so waives your request, as safeguarding our first responders comes first.'
			)
			.setTimestamp();
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			TYPES.map((t) =>
				new ButtonBuilder()
					.setCustomId(t.id)
					.setLabel(`${t.label}!`)
					.setEmoji(t.emoji)
					.setStyle(ButtonStyle.Primary)
			)
		);
		const message = await channel.send({ embeds: [embed], components: [row] });
		await i.reply({ content: 'Sent!', flags: MessageFlags.Ephemeral });
		for (const t of TYPES) {
			const emoji = i.guild.emojis.cache.find((e) => e.name === t.reaction);
			if (emoji) await message.react(emoji);
		}
	}
};

export async function onButton(i: ButtonInteraction<'cached'>) {
	const type = typeOf(i.customId);
	if (!type) return;
	const until = cooldowns.get(`${type.id}:${i.user.id}`) ?? 0;
	if (until > Date.now()) {
		return i.reply({
			content: `You can request ${type.label} again <t:${Math.ceil(until / 1000)}:R>.`,
			flags: MessageFlags.Ephemeral
		});
	}
	const input = (id: string, label: string, style: TextInputStyle) =>
		new LabelBuilder()
			.setLabel(label)
			.setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(style));
	await i.showModal(
		new ModalBuilder()
			.setCustomId(type.id)
			.setTitle('Rapid Response Request')
			.addLabelComponents(
				input('rr-input-location', 'Your Location', TextInputStyle.Short),
				input('rr-input-description', 'Quick Description', TextInputStyle.Paragraph),
				input('rr-input-vc', 'What Voice Channel you in?', TextInputStyle.Short)
			)
	);
}

export async function onModal(i: ModalSubmitInteraction<'cached'>) {
	const type = typeOf(i.customId);
	if (!type || i.channel?.type !== ChannelType.GuildText) return;
	cooldowns.set(`${type.id}:${i.user.id}`, Date.now() + COOLDOWN_MS);

	const field = (id: string) => i.fields.getTextInputValue(id);
	const responders = i.guild.roles.cache.find((r) => r.name === `SC RR ${type.label}`);
	const thread = await i.channel.threads.create({
		name: `${i.user.username}'s ${type.label} Rapid Response`,
		autoArchiveDuration: 1440,
		type: ChannelType.PublicThread,
		reason: 'Rapid Response'
	});
	await thread.send({
		content: responders ? `${responders}` : undefined,
		embeds: [
			new EmbedBuilder()
				.setTitle('Rapid Response Requested!')
				.setColor(0xc80000)
				.setDescription(
					`**Member:** ${i.user}\n**Location:** ${field('rr-input-location')}\n` +
						`**Description:** ${field('rr-input-description')}\n**Voice Channel:** ${field('rr-input-vc')}`
				)
				.setTimestamp()
		],
		allowedMentions: { users: [i.user.id], roles: responders ? [responders.id] : [] }
	});
	await thread.members.add(i.user.id);
	track(thread.id);
	await i.reply({
		content: `Your Rapid Response has been created in ${thread}`,
		flags: MessageFlags.Ephemeral
	});
}

export async function onReaction(
	r: MessageReaction | PartialMessageReaction,
	userId: string,
	add: boolean
) {
	if (r.message.channelId !== CHANNEL_ID || !r.message.guild) return;
	const type = TYPES.find((t) => t.reaction === r.emoji.name);
	if (!type) return;
	const gm = await r.message.guild.members.fetch(userId);
	if (gm.user.bot) return;
	if (add) await gm.roles.add(type.role, 'Rapid Response reaction');
	else await gm.roles.remove(type.role, 'Rapid Response reaction');
}

const stmt = {
	put: db.prepare('INSERT OR REPLACE INTO rr_thread (thread_id, last_activity) VALUES (?, ?)'),
	bump: db.prepare('UPDATE rr_thread SET last_activity = ? WHERE thread_id = ?'),
	del: db.prepare('DELETE FROM rr_thread WHERE thread_id = ?'),
	idle: db.prepare('SELECT thread_id FROM rr_thread WHERE last_activity < ?')
};

const track = (threadId: string) => stmt.put.run(threadId, Date.now());

export function onMessage(m: Message) {
	if (!m.author.bot) stmt.bump.run(Date.now(), m.channelId);
}

/** A mod unlocking a closed request reopens it; locking or deleting one closes it. */
export async function onThreadUpdate(before: AnyThreadChannel, after: AnyThreadChannel) {
	if (after.parentId !== CHANNEL_ID) return;
	if (before.locked && !after.locked) track(after.id);
	if (!before.locked && after.locked) await close(after);
}

export async function close(thread: AnyThreadChannel) {
	stmt.del.run(thread.id);
	// Keep the channel tidy: drop the "X started a thread" notice.
	const parent = thread.parent?.isTextBased() ? thread.parent : null;
	const messages = await parent?.messages.fetch({ limit: 100 }).catch(() => null);
	const notice = messages?.find(
		(m) => m.type === MessageType.ThreadCreated && m.reference?.channelId === thread.id
	);
	await notice?.delete().catch(() => {});
}

export async function archiveIdleThreads(guild: Guild, now = Date.now()) {
	for (const { thread_id } of stmt.idle.all(now - IDLE_MS) as { thread_id: string }[]) {
		const thread = await guild.channels.fetch(thread_id).catch(() => null);
		if (!thread?.isThread()) {
			stmt.del.run(thread_id);
			continue;
		}
		await thread.send('This thread has been archived and locked due to inactivity.');
		await thread.setLocked(true);
		await thread.setArchived(true);
		await close(thread);
	}
}
