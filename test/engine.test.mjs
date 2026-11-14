import assert from 'node:assert/strict';
import test from 'node:test';
import { CivitaiError } from '../src/client.mjs';
import { formatRunLog } from '../src/cli.mjs';
import { TASKS, buildPlan, runTasks, scanAccount, summarizeLedger } from '../src/engine.mjs';

const day = '2026-11-14';
const now = () => new Date(`${day}T12:00:00Z`);
const options = { now, sleepFn: async () => {} };

function rewardRow(type, targetId, amount, extra = {}) {
  return {
    date: now(), type: 5, amount, fromAccountId: 0, toAccountId: 42,
    fromAccountType: 'yellow', toAccountType: 'blue',
    description: `Buzz Reward: ${TASKS.find((task) => task.type === type).description}`,
    details: { type: type === 'encouragement' ? 'encouragement:image' : type, forId: targetId, byUserId: 42 },
    externalTransactionId: `${type}:${targetId}-42-42`, ...extra,
  };
}

function fakeClient() {
  const client = {
    writes: [], rows: [], following: new Set(), reactions: {}, balance: 0,
    definitions: TASKS.map(({ type }, index) => ({
      type, accountType: 'blue', onDemand: true, awardAmount: [25, 2, 10][index],
      cap: [25, 100, 30][index], awarded: 0, awardedCount: 0,
    })),
    async me() { return { id: 42, username: 'tester', status: 'active' }; },
    async query(procedure, input) {
      if (procedure === 'buzz.getUserMultipliers') return { rewardsMultiplier: 1, rewardsIneligible: false };
      if (procedure === 'user.userRewardDetails') return structuredClone(this.definitions);
      if (procedure === 'buzz.getBuzzAccount') return { blue: this.balance, yellow: 12345 };
      if (procedure === 'user.getCreator') return { id: 100 + Number(input.username.slice(6)), username: input.username };
      throw new Error(`Unexpected procedure ${procedure}`);
    },
    async transactionsOfDay() { return structuredClone(this.rows); },
    async followingIds() { return new Set(this.following); },
    async imageReactions(ids) {
      return Object.fromEntries(ids.filter((id) => this.reactions[id]).map((id) => [id, this.reactions[id]]));
    },
    async listImages() {
      return { items: Array.from({ length: 60 }, (_, index) => ({ id: index + 1, username: `owner-${index % 6}` })), metadata: {} };
    },
    async mutate(procedure, input) {
      if (this.beforeWrite) await this.beforeWrite(procedure, input);
      this.writes.push({ procedure, input });
      const type = procedure === 'reaction.toggle' ? 'encouragement'
        : procedure === 'user.toggleFollow' ? 'firstDailyFollow' : 'dailyBoost';
      const targetId = type === 'dailyBoost' ? 20261114 : input.entityId ?? input.targetUserId;
      if (type === 'encouragement' && this.reactions[targetId]?.includes('Like')) {
        this.reactions[targetId] = this.reactions[targetId].filter((reaction) => reaction !== 'Like');
        if (!this.reactions[targetId].length) delete this.reactions[targetId];
        return 'removed';
      }
      if (type === 'firstDailyFollow' && this.following.has(targetId)) {
        this.following.delete(targetId);
        return { following: false };
      }
      const definition = this.definitions.find((item) => item.type === type);
      const amount = Math.min(definition.awardAmount, definition.cap - definition.awarded);
      if (type === 'encouragement') this.reactions[targetId] = ['Like'];
      if (type === 'firstDailyFollow') this.following.add(targetId);
      if (this.loseResponse) throw new CivitaiError('socket lost', { code: 'NETWORK_ERROR', uncertain: true });
      if (!this.noPayout) {
        this.rows.push(rewardRow(type, targetId, amount));
        definition.awarded += amount;
        definition.awardedCount += 1;
        this.balance += amount;
      }
      return type === 'dailyBoost' ? undefined : type === 'encouragement' ? 'created' : { following: true };
    },
  };
  return client;
}

test('planning reads current quotas and ledger before any mutation', async () => {
  const client = fakeClient();
  const snapshot = await scanAccount(client, { day });
  const plan = buildPlan(snapshot);
  assert.equal(plan.reduce((sum, item) => sum + item.remaining, 0), 155);
  assert.deepEqual(plan.map(({ type }) => type), TASKS.map(({ type }) => type));
  assert.deepEqual(client.writes, []);
  assert.equal(snapshot.blueBalance, 0);
});

test('executes all three tasks, removes new interactions and skips completed tasks on rerun', async () => {
  const client = fakeClient();
  client.balance = 500;
  const report = await runTasks(client, options);
  assert.equal(report.status, 'completed');
  assert.equal(report.verifiedGain, 155);
  assert.equal(report.unverifiedOperations, 0);
  assert.equal(client.writes.length, 107);
  assert.equal(client.following.size, 0);
  assert.equal(Object.keys(client.reactions).length, 0);
  assert.deepEqual(report.tasks.map(({ removedOperations }) => removedOperations), [0, 50, 3]);
  assert.equal(report.blueBalance, 655);
  assert.deepEqual(report.tasks.map(({ status, successfulOperations, verifiedGain, verifiedToday, cap }) => ({
    status, successfulOperations, verifiedGain, verifiedToday, cap,
  })), [
    { status: 'completed', successfulOperations: 1, verifiedGain: 25, verifiedToday: 25, cap: 25 },
    { status: 'completed', successfulOperations: 50, verifiedGain: 100, verifiedToday: 100, cap: 100 },
    { status: 'completed', successfulOperations: 3, verifiedGain: 30, verifiedToday: 30, cap: 30 },
  ]);
  const log = formatRunLog(report);
  assert.match(log, /\[Daily Boost\] COMPLETED \| successful operations 1\/1 \| verified gain 25 \| today 25\/25/);
  assert.match(log, /\[Image reactions\] COMPLETED \| successful operations 50\/50 \| verified gain 100 \| today 100\/100/);
  assert.match(log, /\[First follows\] COMPLETED \| successful operations 3\/3 \| verified gain 30 \| today 30\/30/);
  assert.match(log, /\[Image reactions\].*removed 50/);
  assert.match(log, /\[First follows\].*removed 3/);
  assert.match(log, /Current Blue Buzz: 655/);
  const rerun = await runTasks(client, options);
  assert.equal(rerun.verifiedGain, 0);
  assert.equal(client.writes.length, 107);
  assert.ok(rerun.tasks.every((task) => task.status === 'completed' && task.successfulOperations === 0 && task.verifiedGain === 0));
  assert.equal(rerun.blueBalance, 655);
});

test('a fresh runner reads daily server progress and only adds 10 reactions and 1 follow', async () => {
  const client = fakeClient();
  const imageIds = Array.from({ length: 40 }, (_, index) => index + 1);
  client.reactions = Object.fromEntries(imageIds.map((id) => [id, ['Like']]));
  client.following = new Set([100, 101]);
  client.rows = [
    rewardRow('dailyBoost', 20261114, 25),
    ...imageIds.map((id) => rewardRow('encouragement', id, 2)),
    rewardRow('firstDailyFollow', 100, 10), rewardRow('firstDailyFollow', 101, 10),
  ];
  client.definitions.forEach((definition, index) => {
    definition.awarded = [25, 80, 20][index];
    definition.awardedCount = [1, 40, 2][index];
  });
  client.balance = 500;
  const plan = buildPlan(await scanAccount(client, { day }));
  assert.deepEqual(plan.map(({ plannedOperations }) => plannedOperations), [0, 10, 1]);
  const report = await runTasks(client, options);
  assert.equal(report.status, 'completed');
  assert.equal(report.verifiedGain, 30);
  assert.equal(report.blueBalance, 530);
  assert.equal(client.writes.length, 22);
  assert.deepEqual(client.following, new Set([100, 101]));
  assert.deepEqual(Object.keys(client.reactions).map(Number), imageIds);
  assert.equal(client.writes.some(({ procedure }) => procedure === 'buzz.claimDailyBoostReward'), false);
  assert.deepEqual(report.tasks.map(({ successfulOperations }) => successfulOperations), [0, 10, 1]);
});

test('existing numeric follows and any existing image reaction are preserved', async () => {
  const client = fakeClient();
  client.following.add(100);
  client.reactions[1] = ['Heart'];
  client.reactions[2] = ['Like', 'Heart'];
  await runTasks(client, options);
  assert.ok(client.following.has(100));
  assert.deepEqual(client.reactions[1], ['Heart']);
  assert.deepEqual(client.reactions[2], ['Like', 'Heart']);
  assert.equal(client.writes.some(({ procedure, input }) => procedure === 'user.toggleFollow' && input.targetUserId === 100), false);
  assert.equal(client.writes.some(({ procedure, input }) => procedure === 'reaction.toggle' && (input.entityId - 1) % 6 === 0), false);
  assert.equal(client.writes.some(({ procedure, input }) => procedure === 'reaction.toggle' && input.entityId === 2), false);
});

test('refuses unavailable quota and never substitutes historical constants', async () => {
  const client = fakeClient();
  client.definitions[1].awarded = -1;
  await assert.rejects(runTasks(client, options), /Unknown reward contract/);
  assert.equal(client.writes.length, 0);
});

test('runtime-disabled rewards do not execute; changed caps are authoritative', async () => {
  const client = fakeClient();
  client.definitions = client.definitions.filter(({ type }) => type !== 'firstDailyFollow');
  client.definitions.find(({ type }) => type === 'encouragement').cap = 5;
  const report = await runTasks(client, options);
  assert.equal(report.verifiedGain, 30);
  assert.equal(client.writes.filter(({ procedure }) => procedure === 'reaction.toggle').length, 6);
  assert.equal(client.following.size, 0);
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.tasks.map(({ status }) => status), ['completed', 'completed', 'unavailable']);
  assert.match(formatRunLog(report), /\[First follows\] UNAVAILABLE/);
});

test('lost response is not retried; the next run respects current server progress and reactions', async () => {
  const client = fakeClient();
  client.definitions = client.definitions.filter(({ type }) => type === 'encouragement');
  client.loseResponse = true;
  const first = await runTasks(client, options);
  assert.equal(first.status, 'uncertain');
  assert.equal(client.writes.length, 1);
  client.loseResponse = false;
  client.rows.push(rewardRow('encouragement', 1, 2));
  client.definitions[0].awarded = 2;
  client.balance = 2;
  const second = await runTasks(client, options);
  assert.equal(second.verifiedGain, 98);
  assert.equal(client.writes.length, 99);
  assert.equal(client.writes.filter(({ input }) => input.entityId === 1).length, 1);
});

test('successful operations without reward credits are reported as unverified, not 155', async () => {
  const client = fakeClient();
  client.definitions = client.definitions.filter(({ type }) => type === 'dailyBoost');
  client.noPayout = true;
  const first = await runTasks(client, options);
  assert.equal(first.status, 'partial');
  assert.equal(first.verifiedGain, 0);
  assert.equal(first.unverifiedOperations, 1);
  assert.equal(first.tasks[0].status, 'unverified');
  assert.equal(first.tasks[0].successfulOperations, 1);
  assert.equal(first.tasks[0].verifiedGain, 0);
  assert.match(formatRunLog(first), /\[Daily Boost\] UNVERIFIED/);
  assert.match(formatRunLog(first), /Current Blue Buzz: 0/);
  client.rows.push(rewardRow('dailyBoost', 20261114, 25));
  client.definitions[0].awarded = 25;
  client.balance = 25;
  await runTasks(client, options);
  assert.equal(client.writes.length, 1);
});

test('only reward credits from the bank to this Blue account count', () => {
  const valid = rewardRow('dailyBoost', 20261114, 25);
  const rows = [
    valid, valid,
    rewardRow('encouragement', 1, 200, { toAccountType: 'yellow' }),
    rewardRow('encouragement', 2, 200, { type: 0 }),
    rewardRow('encouragement', 3, 200, { fromAccountId: 99 }),
    rewardRow('encouragement', 4, 200, { toAccountId: 99 }),
    rewardRow('encouragement', 5, -2),
    rewardRow('encouragement', 6, 200, { description: 'Other reward', details: {} }),
  ];
  assert.deepEqual(summarizeLedger(rows, 42, day).totals, { dailyBoost: 25, encouragement: 0, firstDailyFollow: 0 });
  assert.throws(() => summarizeLedger([{ ...valid, toAccountType: undefined }], 42, day), /Incomplete transaction/);
});

test('a UTC rollover during candidate selection aborts before mutations', async () => {
  const client = fakeClient();
  let current = now();
  const original = client.listImages;
  client.listImages = async () => {
    current = new Date('2026-11-15T00:00:00Z');
    return original();
  };
  const report = await runTasks(client, { ...options, now: () => current });
  assert.equal(report.status, 'blocked');
  assert.equal(client.writes.length, 0);
  assert.equal(report.blueBalance, null);
  assert.match(formatRunLog(report), /Current Blue Buzz: UNKNOWN/);
});

test('in-memory pending awards reserve budget before the ledger catches up', async () => {
  const client = fakeClient();
  const snapshot = await scanAccount(client, { day });
  const actions = [{ key: 'encouragement:1', task: 'encouragement', expected: 2, status: 'pending' }];
  const plan = buildPlan(snapshot, actions).find(({ type }) => type === 'encouragement');
  assert.equal(plan.remaining, 98);
  assert.equal(plan.plannedOperations, 49);
});

test('does not attribute simultaneous rewards from unrelated targets to this run', async () => {
  const client = fakeClient();
  client.definitions = client.definitions.filter(({ type }) => type === 'encouragement');
  client.beforeWrite = async () => {
    client.beforeWrite = null;
    client.rows.push(rewardRow('encouragement', 999999, 2));
  };
  const report = await runTasks(client, options);
  assert.equal(report.tasks.find(({ type }) => type === 'encouragement').verifiedToday, 100);
  assert.equal(report.verifiedGain, 98);
  assert.equal(report.tasks.find(({ type }) => type === 'encouragement').verifiedGain, 98);
});

test('verification failure after a mutation never logs a stale balance as current', async () => {
  const client = fakeClient();
  client.definitions = client.definitions.filter(({ type }) => type === 'dailyBoost');
  client.balance = 500;
  client.beforeWrite = async () => {
    client.transactionsOfDay = async () => { throw new CivitaiError('Ledger unavailable', { code: 'INCOMPLETE_LEDGER' }); };
  };
  const report = await runTasks(client, options);
  assert.equal(report.status, 'blocked');
  assert.equal(client.balance, 525);
  assert.equal(report.blueBalance, null);
  assert.equal(report.unverifiedOperations, 1);
  assert.equal(report.tasks[0].status, 'verification-failed');
  assert.equal(report.tasks[0].verifiedGain, null);
  const log = formatRunLog(report);
  assert.match(log, /\[Daily Boost\] VERIFICATION-FAILED/);
  assert.match(log, /Current Blue Buzz: UNKNOWN/);
  assert.doesNotMatch(log, /Current Blue Buzz: 500/);
});

test('only removes confirmed creations and does not retry failed removals', async () => {
  const client = fakeClient();
  client.definitions = client.definitions.filter(({ type }) => type === 'encouragement');
  client.definitions[0].cap = 2;
  let removals = 0;
  client.beforeWrite = async (procedure, input) => {
    if (client.reactions[input.entityId]?.includes('Like')) {
      removals += 1;
      throw new CivitaiError('Removal response lost', { code: 'NETWORK_ERROR', uncertain: true });
    }
  };
  const report = await runTasks(client, options);
  assert.equal(removals, 1);
  assert.deepEqual(client.reactions[1], ['Like']);
  assert.equal(report.tasks[1].successfulOperations, 1);
  assert.equal(report.tasks[1].removedOperations, 0);
  assert.equal(report.tasks[1].reason, 'REMOVAL_INCOMPLETE');
  assert.equal(report.status, 'partial');
  assert.ok(report.warnings.some(({ code }) => code === 'REMOVAL_FAILED'));
});

test('reads the current Blue balance again after withdrawing interactions', async () => {
  const client = fakeClient();
  client.definitions = client.definitions.filter(({ type }) => type === 'encouragement');
  client.definitions[0].cap = 2;
  client.balance = 500;
  client.beforeWrite = async (procedure, input) => {
    if (client.reactions[input.entityId]?.includes('Like')) client.balance = 499;
  };
  const report = await runTasks(client, options);
  assert.equal(report.blueBalance, 499);
  assert.equal(report.tasks[1].removedOperations, 1);
  assert.deepEqual(client.reactions, {});
});

test('does not toggle an interaction back on when it is already absent before removal', async () => {
  const client = fakeClient();
  client.definitions = client.definitions.filter(({ type }) => type === 'encouragement');
  client.definitions[0].cap = 2;
  const originalTransactions = client.transactionsOfDay;
  client.transactionsOfDay = async () => {
    if (client.writes.length) delete client.reactions[1];
    return originalTransactions.call(client);
  };
  const report = await runTasks(client, options);
  assert.equal(client.writes.length, 1);
  assert.deepEqual(client.reactions, {});
  assert.equal(report.tasks[1].removedOperations, 1);
});

test('removes a confirmed reaction even when its reward remains unverified', async () => {
  const client = fakeClient();
  client.definitions = client.definitions.filter(({ type }) => type === 'encouragement');
  client.definitions[0].cap = 2;
  client.noPayout = true;
  const report = await runTasks(client, options);
  assert.equal(client.writes.length, 2);
  assert.deepEqual(client.reactions, {});
  assert.equal(report.verifiedGain, 0);
  assert.equal(report.tasks[1].status, 'unverified');
  assert.equal(report.tasks[1].successfulOperations, 1);
  assert.equal(report.tasks[1].removedOperations, 1);
});