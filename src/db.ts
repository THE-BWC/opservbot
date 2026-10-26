import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

/** The bot's own state (SPEC "Data"). Small, one writer, so synchronous SQLite is plenty. */

if (config.DB_PATH !== ':memory:') mkdirSync(dirname(config.DB_PATH), { recursive: true });
export const db = new DatabaseSync(config.DB_PATH);

db.exec(`
	PRAGMA journal_mode = WAL;
	CREATE TABLE IF NOT EXISTS event (
		operation_id INTEGER PRIMARY KEY,
		event_id TEXT NOT NULL,
		op_updated_at TEXT
	);
	CREATE TABLE IF NOT EXISTS game_channel (
		game_id INTEGER PRIMARY KEY,
		channel_id TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS setting (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS notified (
		operation_id INTEGER NOT NULL,
		starts_at TEXT NOT NULL,
		PRIMARY KEY (operation_id, starts_at)
	);
	CREATE TABLE IF NOT EXISTS rr_thread (
		thread_id TEXT PRIMARY KEY,
		last_activity INTEGER NOT NULL
	);
`);

export type Setting = 'announcement_channel' | 'log_channel' | 'oplist_last_date';

export function getSetting(key: Setting): string | undefined {
	const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key);
	return row?.value as string | undefined;
}

export function setSetting(key: Setting, value: string) {
	db.prepare(
		'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
	).run(key, value);
}
