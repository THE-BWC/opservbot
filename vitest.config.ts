import { defineConfig } from 'vitest/config';

// Dummy env so modules that import config load; nothing here reaches Discord or OpServ.
export default defineConfig({
	test: {
		env: {
			DISCORD_TOKEN: 'test',
			DISCORD_GUILD_ID: '100000000000000000',
			OPSERV_READ_API_URL: 'http://opserv.test/api/bot/v1',
			BOT_READ_API_TOKEN: 'read-token',
			DISCORD_BOT_API_TOKEN: 'bot-token-bot-token-bot-token-bot-token',
			OPSERV_PUBLIC_URL: 'https://opserv.test',
			DB_PATH: ':memory:',
			STREAMER_ROLE_ID: '100000000000000001'
		}
	}
});
