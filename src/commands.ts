import {
	ChannelType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
	type SlashCommandChannelOption,
	type AutocompleteInteraction,
	type ChatInputCommandInteraction,
	type RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js';
import { db, setSetting } from './db.ts';
import { syncMember } from './members.ts';
import { gameChannels, postOpList } from './op-posts.ts';
import { opserv } from './opserv.ts';

/** Admin slash commands (SPEC "Slash commands"). Discord enforces Administrator via default permissions. */

export type Command = {
	data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
	execute: (i: ChatInputCommandInteraction<'cached'>) => Promise<unknown>;
	autocomplete?: (i: AutocompleteInteraction<'cached'>) => Promise<unknown>;
};

const admin = (name: string, description: string) =>
	new SlashCommandBuilder()
		.setName(name)
		.setDescription(description)
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const textChannel = (o: SlashCommandChannelOption) =>
	o
		.setName('channel')
		.setDescription('Channel')
		.setRequired(true)
		.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

export const adminCommands: Command[] = [
	{
		data: admin('setgamechannel', "Sets a game's channel for OpServ op lists and notices")
			.addIntegerOption((o) =>
				o.setName('game').setDescription('OpServ game').setRequired(true).setAutocomplete(true)
			)
			.addChannelOption(textChannel),
		async autocomplete(i) {
			const q = i.options.getFocused().toLowerCase();
			const games = await opserv.games();
			await i.respond(
				games
					.filter((g) => `${g.tag} ${g.name}`.toLowerCase().includes(q))
					.slice(0, 25)
					.map((g) => ({ name: `[${g.tag}] ${g.name}`, value: g.id }))
			);
		},
		async execute(i) {
			const gameId = i.options.getInteger('game', true);
			const channel = i.options.getChannel('channel', true);
			const games = await opserv.games();
			if (!games.some((g) => g.id === gameId))
				return i.reply({ content: 'Unknown game.', ...ephemeral });
			db.prepare(
				`INSERT INTO game_channel (game_id, channel_id) VALUES (?, ?)
				 ON CONFLICT (game_id) DO UPDATE SET channel_id = excluded.channel_id`
			).run(gameId, channel.id);
			const lines = [...gameChannels()].map(([id, ch]) => {
				const g = games.find((g) => g.id === id);
				return `${g ? `[${g.tag}] ${g.name}` : `game ${id} (retired)`} → <#${ch}>`;
			});
			return i.reply({ content: lines.join('\n'), ...ephemeral });
		}
	},
	{
		data: admin(
			'setannouncementchannel',
			'Sets the channel for non-OPSEC op lists and notices'
		).addChannelOption(textChannel),
		async execute(i) {
			const channel = i.options.getChannel('channel', true);
			setSetting('announcement_channel', channel.id);
			return i.reply({ content: `Announcement channel set to ${channel}.`, ...ephemeral });
		}
	},
	{
		data: admin('setlogchannel', 'Sets the bot log channel').addChannelOption(textChannel),
		async execute(i) {
			const channel = i.options.getChannel('channel', true);
			setSetting('log_channel', channel.id);
			return i.reply({ content: `Log channel set to ${channel}.`, ...ephemeral });
		}
	},
	{
		data: admin('postoplist', 'Posts the upcoming op lists now'),
		async execute(i) {
			await i.deferReply(ephemeral);
			await postOpList(i.guild);
			return i.editReply('Op lists posted.');
		}
	},
	{
		data: admin('updatenicknames', 'Updates nicknames from OpServ')
			.addSubcommand((s) =>
				s.setName('all').setDescription('Reset every linked BWC member to [BWC] <OpServ name>')
			)
			.addSubcommand((s) =>
				s
					.setName('user')
					.setDescription('Sync one member (roles and nickname)')
					.addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
			),
		async execute(i) {
			await i.deferReply(ephemeral);
			const links = await opserv.discordLinks();

			if (i.options.getSubcommand() === 'user') {
				const user = i.options.getUser('user', true);
				const link = links.find((l) => l.discordId === user.id);
				const member = link && (await opserv.member(link.memberId));
				if (!member) return i.editReply(`${user} is not linked to OpServ.`);
				const reply = await syncMember(i.guild, member, user.id);
				return i.editReply((reply.body as { message: string }).message);
			}

			const bwc = (await opserv.keyRoles()).find((r) => r.name === 'BWC')?.roleId;
			if (!bwc) return i.editReply('Key role BWC not set in OpServ.');
			const members = await i.guild.members.fetch();
			let changed = 0;
			const failed: string[] = [];
			for (const link of links) {
				const gm = members.get(link.discordId);
				const want = `[BWC] ${link.username}`.slice(0, 32);
				if (!gm || gm.id === i.guild.ownerId || !gm.roles.cache.has(bwc) || gm.nickname === want)
					continue;
				try {
					await gm.setNickname(want, '/updatenicknames');
					changed++;
				} catch {
					failed.push(link.username);
				}
			}
			return i.editReply(
				`Updated ${changed} nicknames.` + (failed.length ? ` Failed: ${failed.join(', ')}` : '')
			);
		}
	}
];
