import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/);

export const config = z
	.object({
		DISCORD_TOKEN: z.string().min(1),
		DISCORD_GUILD_ID: snowflake,
		OPSERV_READ_API_URL: z.url(),
		BOT_READ_API_TOKEN: z.string().min(1),
		DISCORD_BOT_API_TOKEN: z.string().min(32),
		OPSERV_PUBLIC_URL: z.url(),
		PORT: z.coerce.number().int().default(4500),
		DB_PATH: z.string().default('data/bot.db'),
		STREAMER_ROLE_ID: snowflake,
		// Empty = no error reports, as OpServ-V10.
		SENTRY_DSN: z.union([z.url(), z.literal('')]).default(''),
		SENTRY_ENVIRONMENT: z.string().default('production'),
		SENTRY_RELEASE: z
			.string()
			.optional()
			.transform((v) => v || undefined) // commit SHA, from CI
	})
	.parse(process.env);
