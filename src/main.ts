import {
	ActivityType,
	Client,
	Events,
	GatewayIntentBits,
	MessageFlags,
	Partials,
	type Guild,
	type Interaction
} from 'discord.js';
import { createApi } from './api.ts';
import { adminCommands } from './commands.ts';
import { config } from './config.ts';
import { operationsChanged, syncAll } from './events.ts';
import { BAN_PREFIX, changeRole, membersSync, onBanButton } from './members.ts';
import { notify, postOpListIfDue } from './op-posts.ts';
import * as rr from './rapid-response.ts';
import { onPresence } from './streamer.ts';

const commands = new Map([...adminCommands, rr.rrCommand].map((c) => [c.data.name, c]));

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.GuildPresences
	],
	// The Rapid Response panel is old, so its reactions arrive uncached.
	partials: [Partials.Message, Partials.Reaction, Partials.User],
	presence: { activities: [{ name: 'OpServ', type: ActivityType.Watching }] }
});

const logErr = (what: string) => (err: unknown) => console.error(`[${what}]`, err);

client.once(Events.ClientReady, async () => {
	console.log(`[DISCORD] logged in as ${client.user?.tag}`);
	const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
	await guild.commands.set([...commands.values()].map((c) => c.data.toJSON()));

	createApi({
		healthy: () => client.isReady(),
		operationsChanged: (b) => operationsChanged(guild, b),
		membersSync: (b) => membersSync(guild, b),
		rolesGive: (b) => changeRole(guild, b, 'give'),
		rolesRemove: (b) => changeRole(guild, b, 'remove'),
		roles: async () => ({ status: 200, body: await roles(guild) }),
		voiceChannels: async () => ({ status: 200, body: await voiceChannels(guild) })
	}).listen(config.PORT, () => console.log(`[API] listening on ${config.PORT}`));

	await syncAll(guild).catch(logErr('EVENTS'));
	const tick = () => {
		notify(guild).catch(logErr('NOTIFY'));
		postOpListIfDue(guild).catch(logErr('OPLIST'));
		rr.archiveIdleThreads(guild).catch(logErr('RR'));
	};
	tick();
	setInterval(tick, 60_000);
});

async function roles(guild: Guild) {
	const all = await guild.roles.fetch();
	return all
		.filter((r) => r.id !== guild.id)
		.sort((a, b) => b.position - a.position)
		.map((r) => ({ id: r.id, name: r.name }));
}

async function voiceChannels(guild: Guild) {
	const all = await guild.channels.fetch();
	return all
		.filter((c) => c !== null && c.isVoiceBased())
		.map((c) => ({ id: c!.id, name: c!.name }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

async function onInteraction(i: Interaction) {
	if (!i.inCachedGuild()) return;
	if (i.isAutocomplete()) return commands.get(i.commandName)?.autocomplete?.(i);
	if (i.isButton()) return i.customId.startsWith(BAN_PREFIX) ? onBanButton(i) : rr.onButton(i);
	if (i.isModalSubmit()) return rr.onModal(i);
	if (!i.isChatInputCommand()) return;
	try {
		await commands.get(i.commandName)?.execute(i);
	} catch (err) {
		logErr(`/${i.commandName}`)(err);
		const content = 'There was an error while executing this command!';
		if (i.deferred || i.replied) await i.followUp({ content, flags: MessageFlags.Ephemeral });
		else await i.reply({ content, flags: MessageFlags.Ephemeral });
	}
}

client.on(Events.InteractionCreate, (i) => void onInteraction(i).catch(logErr('INTERACTION')));
client.on(Events.MessageCreate, (m) => rr.onMessage(m));
client.on(
	Events.MessageReactionAdd,
	(r, u) => void rr.onReaction(r, u.id, true).catch(logErr('RR'))
);
client.on(
	Events.MessageReactionRemove,
	(r, u) => void rr.onReaction(r, u.id, false).catch(logErr('RR'))
);
client.on(Events.ThreadUpdate, (a, b) => void rr.onThreadUpdate(a, b).catch(logErr('RR')));
client.on(Events.ThreadDelete, (t) => void rr.close(t).catch(logErr('RR')));
client.on(Events.PresenceUpdate, (_, p) => void onPresence(p).catch(logErr('STREAMER')));
client.on(Events.Error, logErr('DISCORD'));

await client.login(config.DISCORD_TOKEN);
