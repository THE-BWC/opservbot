import { expect, test } from 'vitest';
import { dueForNotice, groupByChannel, listEmbeds, opListDue } from './op-posts.ts';
import type { UpcomingOp } from './opserv.ts';

const op = (
	id: number,
	gameId: number,
	isOpsec: boolean,
	startsAt = '2026-11-01T19:00:00.000Z'
): UpcomingOp => ({
	id,
	name: `Op ${id}`,
	typeName: 'Training',
	startsAt,
	endsAt: '2026-11-01T23:00:00.000Z',
	leaderId: 1,
	leaderUsername: 'Lead',
	gameId,
	gameTag: 'SC',
	gameName: 'Star Citizen',
	isOpsec,
	updatedAt: null
});

test('OPSEC ops go only to their game channel, never the announcement channel', () => {
	const channels = new Map([[1, 'game1']]);
	const ops = [op(1, 1, true), op(2, 1, false), op(3, 2, false), op(4, 2, true)];
	const { groups, skipped } = groupByChannel(ops, channels, 'announce');
	expect(Object.fromEntries([...groups].map(([c, l]) => [c, l.map((o) => o.id)]))).toEqual({
		game1: [1, 2],
		announce: [3]
	});
	expect(skipped).toEqual([4]);
});

test('no announcement channel: games without a channel are skipped', () => {
	expect(groupByChannel([op(3, 2, false)], new Map(), undefined).skipped).toEqual([3]);
});

test('lists split into embeds of 15 with an OpServ link', () => {
	const embeds = listEmbeds(Array.from({ length: 31 }, (_, i) => op(i, 1, false)));
	expect(embeds.map((e) => e.data.fields?.length)).toEqual([15, 15, 1]);
	expect(embeds[0].data.fields?.[0].value).toContain('https://opserv.test/operations/0');
});

test('op list is due once per New York day from 07:00', () => {
	// Nov 1 2026 is after DST ends, so New York is UTC-5: 11:30Z = 06:30, 12:00Z = 07:00.
	expect(opListDue(new Date('2026-11-01T11:30:00Z'), undefined)).toBeUndefined();
	expect(opListDue(new Date('2026-11-01T12:00:00Z'), undefined)).toBe('2026-11-01');
	expect(opListDue(new Date('2026-11-01T12:00:00Z'), '2026-11-01')).toBeUndefined();
	expect(opListDue(new Date('2026-11-02T03:00:00Z'), '2026-11-01')).toBeUndefined(); // 22:00 Nov 1 NY
});

test('notices: within 30 minutes, not started, not yet sent', () => {
	const now = new Date('2026-11-01T18:40:00Z');
	const ops = [
		op(1, 1, false, '2026-11-01T19:00:00.000Z'), // in 20 min
		op(2, 1, false, '2026-11-01T19:30:00.000Z'), // in 50 min
		op(3, 1, false, '2026-11-01T18:30:00.000Z'), // started
		op(4, 1, false, '2026-11-01T19:10:00.000Z') // in 30 min, already sent
	];
	expect(dueForNotice(ops, now, (o) => o.id === 4).map((o) => o.id)).toEqual([1]);
});
