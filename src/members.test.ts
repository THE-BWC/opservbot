import { expect, test } from 'vitest';
import { banBlocked, planSync, type Current } from './members.ts';
import type { KeyRoles, Member } from './opserv.ts';

const keyRoles: KeyRoles = [
	{ name: 'BWC', roleId: 'bwc' },
	{ name: 'Guest', roleId: 'guest' }
];
const member = (status: Member['status']): Member => ({
	memberId: 1,
	username: 'Patrick',
	discordId: '123456789012345678',
	status
});
const cur = (roles: string[], nickname: string | null = null, isOwner = false): Current => ({
	roleIds: new Set(roles),
	nickname,
	isOwner
});

test('active: BWC on, other key roles off, tagged nickname', () => {
	expect(planSync(member('active'), keyRoles, cur(['guest', 'other']))).toEqual({
		add: ['bwc'],
		remove: ['guest'],
		nickname: '[BWC] Patrick',
		removedBwc: false
	});
});

test('active: keeps a nickname that already carries the tag', () => {
	const plan = planSync(member('active'), keyRoles, cur(['bwc'], '[BWC] Pat (S-1)'));
	expect(plan).toEqual({ add: [], remove: [], nickname: undefined, removedBwc: false });
});

test('active: retags an untagged nickname, capped at 32 chars', () => {
	const long = { ...member('active'), username: 'x'.repeat(40) };
	const plan = planSync(long, keyRoles, cur(['bwc'], 'Pat'));
	expect('nickname' in plan && plan.nickname).toBe('[BWC] ' + 'x'.repeat(26));
});

test('guild owner: roles still change, nickname never', () => {
	const plan = planSync(member('active'), keyRoles, cur([], null, true));
	expect(plan).toMatchObject({ add: ['bwc'], nickname: undefined });
});

test('applicant: Guest, BWC removed and flagged, tag stripped', () => {
	expect(planSync(member('applicant'), keyRoles, cur(['bwc'], '[BWC] Patrick'))).toEqual({
		add: ['guest'],
		remove: ['bwc'],
		nickname: 'Patrick',
		removedBwc: true
	});
});

test('applicant without BWC: nothing flagged, nickname untouched', () => {
	expect(planSync(member('applicant'), keyRoles, cur(['guest'], 'Pat'))).toEqual({
		add: [],
		remove: [],
		nickname: undefined,
		removedBwc: false
	});
});

test.each([
	['banned', 'Member is banned from BWC. If this is in error contact S-1.'],
	['sentinel', 'Hol up... Member is marked as departed. Please contact S-1 Immediately!'],
	['discharged', 'Member is discharged. Cannot give role']
] as const)('%s: refused, BWC and tag taken away', (status, refuse) => {
	expect(planSync(member(status), keyRoles, cur(['bwc', 'guest'], '[BWC] Patrick'))).toEqual({
		add: [],
		remove: ['bwc'],
		nickname: 'Patrick',
		removedBwc: true,
		refuse
	});
});

test('discharged without BWC: refused, nothing to change', () => {
	expect(planSync(member('discharged'), keyRoles, cur(['guest'], 'Pat'))).toEqual({
		add: [],
		remove: [],
		nickname: undefined,
		removedBwc: false,
		refuse: 'Member is discharged. Cannot give role'
	});
});

test.each([
	['ambassador', 'Member is an Ambassador, please contact S-1 to receive Ambassador tags'],
	['placeholder', 'Member is a placeholder account']
] as const)('%s: refused, roles left alone', (status, refuse) => {
	expect(planSync(member(status), keyRoles, cur(['bwc'], '[BWC] Patrick'))).toEqual({
		add: [],
		remove: [],
		removedBwc: false,
		refuse
	});
});

test('banned needs only the BWC key role set', () => {
	const onlyBwc = keyRoles.map((r) => (r.name === 'BWC' ? r : { ...r, roleId: null }));
	expect(planSync(member('banned'), onlyBwc, cur(['bwc'])).remove).toEqual(['bwc']);
});

test('an unset key role throws', () => {
	const missing = keyRoles.map((r) => (r.name === 'Guest' ? { ...r, roleId: null } : r));
	expect(() => planSync(member('active'), missing, cur([]))).toThrow(
		'Key role Guest not set in OpServ'
	);
});

test('ban button: goes ahead only while OpServ still says banned, for the same account', () => {
	const id = '123456789012345678';
	expect(banBlocked(member('banned'), id)).toBeUndefined();
	expect(banBlocked({ ...member('banned'), discordId: null }, id)).toBeUndefined(); // unlinked since
	expect(banBlocked(null, id)).toBe('Member no longer exists in OpServ.');
	expect(banBlocked(member('active'), id)).toBe(
		'Member is no longer banned in OpServ (now active).'
	);
	expect(banBlocked(member('banned'), '999999999999999999')).toBe(
		'Member is now linked to a different Discord account.'
	);
});
