import type { Guild } from 'discord.js';
import { expect, test } from 'vitest';
import { decide, eventOptions } from './events.ts';
import type { Operation } from './opserv.ts';

const now = new Date('2026-11-01T12:00:00Z');
const op: Operation = {
	id: 7,
	name: 'Cargo run',
	isCompleted: false,
	isOpsec: false,
	startsAt: '2026-11-01T19:00:00.000Z',
	endsAt: '2026-11-01T21:00:00.000Z',
	leaderId: 1,
	gameId: 2,
	gameTag: 'SC',
	gameName: 'Star Citizen',
	description: '<p>Bring <b>snacks</b></p>',
	discordVoiceChannelId: null,
	discordEventLocation: null,
	updatedAt: '2026-10-30T10:00:00.000Z'
};
const stored = { event_id: 'e1', op_updated_at: op.updatedAt };

test.each([
	['deleted op with event', null, stored, 'delete'],
	['deleted op without event', null, undefined, 'none'],
	['completed', { ...op, isCompleted: true }, stored, 'delete'],
	['switched to OPSEC', { ...op, isOpsec: true }, stored, 'delete'],
	['OPSEC, never posted', { ...op, isOpsec: true }, undefined, 'none'],
	['ended', { ...op, endsAt: '2026-11-01T11:00:00.000Z' }, stored, 'delete'],
	['running: leave it', { ...op, startsAt: '2026-11-01T11:00:00.000Z' }, stored, 'none'],
	['running, never posted', { ...op, startsAt: '2026-11-01T11:00:00.000Z' }, undefined, 'none'],
	['new', op, undefined, 'create'],
	['unchanged', op, stored, 'none'],
	['changed', { ...op, updatedAt: '2026-10-31T10:00:00.000Z' }, stored, 'edit'],
	[
		'imported from legacy (no updatedAt stored)',
		op,
		{ event_id: 'e1', op_updated_at: null },
		'edit'
	]
] as const)('%s → %s', (_, o, s, want) => {
	expect(decide(o, s, now)).toBe(want);
});

const guild = (channels: Record<string, { isVoiceBased: () => boolean }>) =>
	({ channels: { cache: new Map(Object.entries(channels)) } }) as unknown as Guild;

test('external event with plain-text description and fallback location', () => {
	expect(eventOptions(op, guild({}))).toMatchObject({
		name: '[SC] - Cargo run',
		description: 'Bring snacks',
		entityType: 3,
		entityMetadata: { location: 'TBD' }
	});
});

test('voice event when the channel exists, external when it does not', () => {
	const withVoice = { ...op, discordVoiceChannelId: '123456789012345678' };
	const vc = { isVoiceBased: () => true };
	expect(eventOptions(withVoice, guild({ '123456789012345678': vc }))).toMatchObject({
		entityType: 2,
		channel: vc
	});
	expect(eventOptions(withVoice, guild({}))).toMatchObject({ entityType: 3 });
});
