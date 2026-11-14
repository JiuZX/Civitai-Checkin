import { setTimeout as sleep } from 'node:timers/promises';
import { CivitaiError, dayRange, utcDay } from './client.mjs';

export const TASKS = [
  { type: 'dailyBoost', maxOperations: 1, description: 'For claiming daily boost rewards' },
  { type: 'encouragement', maxOperations: 50, description: 'For encouraging others to post content' },
  { type: 'firstDailyFollow', maxOperations: 3, description: 'For first 3 people that you follow each day' },
];

const emptyTotals = () => Object.fromEntries(TASKS.map(({ type }) => [type, 0]));
const isPositiveId = (value) => Number.isSafeInteger(value) && value > 0;

export function summarizeLedger(rows, accountId, day) {
  const { start, end } = dayRange(day);
  const totals = emptyTotals();
  const credits = {};
  const seen = new Map();
  for (const row of rows) {
    const date = row?.date instanceof Date ? row.date : new Date(row?.date);
    if (!Number.isFinite(date.getTime()) || date < start || date > end
      || !Number.isSafeInteger(row?.amount)
      || !Number.isSafeInteger(row?.fromAccountId) || !Number.isSafeInteger(row?.toAccountId)
      || typeof row?.fromAccountType !== 'string' || typeof row?.toAccountType !== 'string') {
      throw new CivitaiError('Incomplete transaction fields; no writes are safe', { code: 'INCOMPLETE_LEDGER' });
    }
    const identity = row.transactionId ?? row.externalTransactionId;
    if (identity) {
      const signature = JSON.stringify(row);
      if (seen.has(identity)) {
        if (seen.get(identity) !== signature) throw new Error('Conflicting transaction identities');
        continue;
      }
      seen.set(identity, signature);
    }
    if (row.amount <= 0 || row.toAccountId !== accountId || row.fromAccountId !== 0
      || row.toAccountType !== 'blue' || ![5, 'Reward', 'reward'].includes(row.type)) continue;
    const detailType = row.details?.type;
    const task = TASKS.find(({ type, description }) => detailType === type
      || (type === 'encouragement' && typeof detailType === 'string' && detailType.startsWith('encouragement:'))
      || (!detailType && row.description === `Buzz Reward: ${description}`));
    if (!task) continue;
    totals[task.type] += row.amount;
    const targetId = Number(row.details?.forId);
    if (isPositiveId(targetId) && (task.type !== 'encouragement' || detailType === 'encouragement:image')) {
      const key = `${task.type}:${targetId}`;
      credits[key] = (credits[key] ?? 0) + row.amount;
    }
  }
  return { totals, credits };
}

function parseRewards(definitions, multipliers) {
  if (!Array.isArray(definitions) || typeof multipliers?.rewardsIneligible !== 'boolean'
    || !Number.isFinite(multipliers.rewardsMultiplier) || multipliers.rewardsMultiplier < 0) {
    throw new CivitaiError('Reward configuration is unavailable; refusing fallback quotas', { code: 'SCHEMA_CHANGED' });
  }
  const rewards = {};
  for (const { type } of TASKS) {
    const matches = definitions.filter((definition) => definition?.type === type);
    if (matches.length > 1) throw new Error('Duplicate reward definitions');
    const definition = matches[0];
    if (!definition || multipliers.rewardsIneligible || multipliers.rewardsMultiplier === 0) {
      rewards[type] = { available: false, reason: definition ? 'INELIGIBLE' : 'DISABLED_OR_NOT_ADVERTISED' };
      continue;
    }
    const { awardAmount, cap, awarded, accountType, onDemand, interval } = definition;
    if (![awardAmount, cap, awarded].every((value) => Number.isSafeInteger(value) && value >= 0)
      || accountType !== 'blue' || onDemand !== true || (interval !== undefined && interval !== 'day')) {
      throw new CivitaiError(`Unknown reward contract for ${type}`, { code: 'SCHEMA_CHANGED' });
    }
    rewards[type] = { available: awardAmount > 0 && cap > 0, awardAmount, cap, awarded };
  }
  return rewards;
}

export async function scanAccount(client, { day = utcDay(), account } = {}) {
  const profile = account ?? await client.me();
  if (profile.status !== 'active') throw new CivitaiError('Account is not active', { code: 'ACCOUNT_RESTRICTED' });
  const multipliers = await client.query('buzz.getUserMultipliers');
  const definitions = await client.query('user.userRewardDetails');
  const ledger = summarizeLedger(await client.transactionsOfDay(day), profile.id, day);
  const balances = await client.query('buzz.getBuzzAccount');
  if (!Number.isSafeInteger(balances?.blue) || balances.blue < 0) {
    throw new CivitaiError('Blue Buzz balance is unavailable', { code: 'SCHEMA_CHANGED' });
  }
  return {
    day, account: { id: profile.id, username: profile.username },
    blueBalance: balances.blue, rewards: parseRewards(definitions, multipliers), ledger,
  };
}

export function buildPlan(snapshot, actions = []) {
  return TASKS.map(({ type, maxOperations }) => {
    const reward = snapshot.rewards[type];
    const operations = actions.filter((action) => action.task === type);
    const uncredited = operations
      .filter((operation) => !['rejected', 'skipped'].includes(operation.status))
      .reduce((sum, operation) => sum + Math.max(0, operation.expected - (snapshot.ledger.credits[operation.key] ?? 0)), 0);
    const used = Math.max(reward.awarded ?? 0, snapshot.ledger.totals[type] + uncredited);
    const remaining = reward.available ? Math.max(0, reward.cap - used) : 0;
    const plannedOperations = reward.available
      ? Math.min(Math.max(0, maxOperations - operations.length), Math.ceil(remaining / reward.awardAmount))
      : 0;
    return {
      type, available: reward.available, reason: reward.reason ?? null,
      awardAmount: reward.awardAmount ?? 0, cap: reward.cap ?? 0,
      verifiedToday: snapshot.ledger.totals[type],
      remaining, plannedOperations,
    };
  });
}

function assertDay(day, now, writing = false) {
  if (utcDay(now) !== day || (writing && dayRange(day).end - now < 60000)) {
    throw new CivitaiError('UTC day changed or midnight is too close; rerun after UTC midnight', {
      code: 'UTC_DAY_BOUNDARY',
    });
  }
}

function nextImageCursor(page) {
  const cursor = page.metadata?.nextCursor;
  if (cursor !== undefined && cursor !== null && cursor !== '') return String(cursor);
  if (!page.metadata?.nextPage) return null;
  const next = new URL(page.metadata.nextPage);
  if (next.origin !== 'https://civitai.com' || next.pathname !== '/api/v1/images') {
    throw new CivitaiError('Untrusted image pagination URL', { code: 'SCHEMA_CHANGED' });
  }
  return next.searchParams.get('cursor');
}

async function candidates(client, snapshot, following) {
  const plan = buildPlan(snapshot);
  const needImages = plan.find(({ type }) => type === 'encouragement')?.plannedOperations ?? 0;
  const needUsers = plan.find(({ type }) => type === 'firstDailyFollow')?.plannedOperations ?? 0;
  const images = [];
  const users = [];
  const owners = new Map();
  const imageIds = new Set();
  const userIds = new Set();
  const cursors = new Set();
  let cursor;
  for (let pageIndex = 0; pageIndex < 5 && (images.length < needImages || users.length < needUsers); pageIndex += 1) {
    const page = await client.listImages({ limit: 100, cursor });
    const eligible = page.items.filter((image) => isPositiveId(image.id) && typeof image.username === 'string'
      && image.username.toLowerCase() !== snapshot.account.username.toLowerCase()
      && !imageIds.has(image.id)
      && !snapshot.ledger.credits[`encouragement:${image.id}`]);
    const reactions = eligible.length ? await client.imageReactions(eligible.map(({ id }) => id)) : {};
    for (const image of eligible) {
      if (!owners.has(image.username)) {
        const owner = await client.query('user.getCreator', { username: image.username });
        if (!isPositiveId(owner?.id) || typeof owner.username !== 'string') {
          throw new CivitaiError('Cannot resolve image owner', { code: 'SCHEMA_CHANGED' });
        }
        owners.set(image.username, owner);
      }
      const owner = owners.get(image.username);
      imageIds.add(image.id);
      if (owner.id === snapshot.account.id || following.has(owner.id)) continue;
      if (!(reactions[image.id]?.length) && images.length < needImages) images.push({ id: image.id, ownerId: owner.id });
      if (users.length < needUsers && !userIds.has(owner.id)
        && !snapshot.ledger.credits[`firstDailyFollow:${owner.id}`]) {
        users.push({ id: owner.id, username: owner.username });
        userIds.add(owner.id);
      }
      if (images.length >= needImages && users.length >= needUsers) break;
    }
    cursor = nextImageCursor(page);
    if (!cursor) break;
    if (cursors.has(cursor)) throw new CivitaiError('Image cursor repeated', { code: 'SCHEMA_CHANGED' });
    cursors.add(cursor);
  }
  return { images, users };
}

export async function runTasks(client, {
  now = () => new Date(),
  sleepFn = sleep,
  signal,
} = {}) {
  const day = utcDay(now());
  let snapshot = await scanAccount(client, { day });
  assertDay(day, now());
  const initialCredits = { ...snapshot.ledger.credits };
  const actions = [];
  const report = {
    day, status: 'running', warnings: [], verifiedGain: 0, blueBalance: null, tasks: [],
  };
  let verified = false;
  const currentPlan = (type) => buildPlan(snapshot, actions).find((item) => item.type === type);
  const gained = (action) => Math.max(0, (snapshot.ledger.credits[action.key] ?? 0) - (initialCredits[action.key] ?? 0));
  const unverified = (action) => !['rejected', 'skipped'].includes(action.status)
    && action.expected > (snapshot.ledger.credits[action.key] ?? 0);
  const refresh = async () => {
    assertDay(day, now());
    snapshot = await scanAccount(client, { day, account: { ...snapshot.account, status: 'active' } });
    assertDay(day, now());
  };
  const perform = async (type, targetId, procedure, input) => {
    signal?.throwIfAborted();
    assertDay(day, now(), true);
    const plan = currentPlan(type);
    const key = `${type}:${targetId}`;
    if (!plan?.plannedOperations || actions.some((action) => action.key === key)) return;
    const operation = {
      key, task: type, targetId, procedure, input,
      expected: Math.min(plan.awardAmount, plan.remaining), status: 'pending', created: false, removed: false,
    };
    actions.push(operation);
    try {
      const result = await client.mutate(procedure, input);
      const applied = type === 'dailyBoost' ? result === undefined || result === null
        : type === 'encouragement' ? result === 'created' : result?.following === true;
      const conflict = type === 'encouragement' ? result === 'removed'
        : type === 'firstDailyFollow' && result?.following === false;
      const skipped = type === 'encouragement' && ['noop', 'ignored'].includes(result);
      operation.status = applied ? 'applied' : conflict ? 'conflict' : skipped ? 'skipped' : 'uncertain';
      operation.created = applied;
      if (!applied) throw new CivitaiError('Toggle was not confirmed as a creation; stopping', {
        code: conflict ? 'TOGGLE_CONFLICT' : skipped ? 'NO_REWARD_ACTION' : 'UNKNOWN_MUTATION_RESULT',
        uncertain: !skipped,
      });
    } catch (error) {
      if (operation.status === 'pending') {
        operation.status = error.uncertain || error.status >= 500 ? 'uncertain' : 'rejected';
      }
      throw error;
    }
    if (actions.length % 10 === 0) await refresh();
  };
  try {
    const following = await client.followingIds();
    const pool = await candidates(client, snapshot, following);
    assertDay(day, now());
    await refresh();
    await perform('dailyBoost', Number(day.replaceAll('-', '')), 'buzz.claimDailyBoostReward', null);
    for (const image of pool.images) {
      if (!currentPlan('encouragement').plannedOperations) break;
      if ((await client.followingIds()).has(image.ownerId)) continue;
      const reactions = await client.imageReactions([image.id]);
      if (reactions[image.id]?.length) continue;
      await perform('encouragement', image.id, 'reaction.toggle', {
        entityType: 'image', entityId: image.id, reaction: 'Like',
      });
    }
    await refresh();
    for (const user of pool.users) {
      if (!currentPlan('firstDailyFollow').plannedOperations) break;
      if ((await client.followingIds()).has(user.id)) continue;
      await perform('firstDailyFollow', user.id, 'user.toggleFollow', {
        targetUserId: user.id, username: user.username,
      });
    }
    report.status = 'completed';
  } catch (error) {
    report.status = error.uncertain ? 'uncertain' : 'blocked';
    report.warnings.push({ code: error.code ?? 'RUN_STOPPED', message: error instanceof CivitaiError ? error.message : 'Task run stopped' });
  } finally {
    if (utcDay(now()) === day && !signal?.aborted) {
      try {
        try {
          for (const delay of [0, 2000, 5000, 10000]) {
            if (delay) await sleepFn(delay, undefined, { signal });
            await refresh();
            if (!actions.some(unverified)) break;
          }
        } finally {
          for (const operation of actions.filter((action) => action.created && action.task !== 'dailyBoost')) {
            if (signal?.aborted) break;
            try {
              const isReaction = operation.task === 'encouragement';
              const present = isReaction
                ? (await client.imageReactions([operation.targetId]))[operation.targetId]?.includes('Like')
                : (await client.followingIds()).has(operation.targetId);
              if (present) {
                const result = await client.mutate(operation.procedure, operation.input);
                if (isReaction ? result !== 'removed' : result?.following !== false) {
                  throw new CivitaiError('Removal was not confirmed; no retry is safe', { code: 'REMOVAL_NOT_CONFIRMED' });
                }
              }
              operation.removed = true;
            } catch {
              report.warnings.push({ code: 'REMOVAL_FAILED', task: operation.task, targetId: operation.targetId });
              if (report.status === 'completed') report.status = 'partial';
            }
          }
        }
        if (actions.some((action) => action.created && action.task !== 'dailyBoost')) await refresh();
        for (const operation of actions) {
          if (gained(operation) > 0) operation.status = 'applied';
        }
        verified = true;
        report.blueBalance = snapshot.blueBalance;
        report.verifiedGain = actions.reduce((sum, action) => sum + gained(action), 0);
        if (report.status === 'completed' && (actions.some(unverified) || buildPlan(snapshot, actions)
          .some((plan) => !plan.available || plan.remaining > 0))) report.status = 'partial';
      } catch (error) {
        report.warnings.push({ code: error.code ?? 'VERIFICATION_FAILED' });
        if (report.status === 'completed') report.status = 'partial';
      }
    } else if (report.status === 'completed') {
      report.status = 'partial';
      report.warnings.push({ code: signal?.aborted ? 'INTERRUPTED' : 'UTC_DAY_BOUNDARY' });
    }
    report.tasks = buildPlan(snapshot, actions).map((plan) => {
      const operations = actions.filter((action) => action.task === plan.type);
      const unverifiedOperations = operations.filter(unverified).length;
      let status;
      let reason = null;
      if (!plan.available) { status = 'unavailable'; reason = plan.reason ?? 'REWARD_DISABLED'; }
      else if (!verified) { status = 'verification-failed'; reason = 'FINAL_VERIFICATION_UNAVAILABLE'; }
      else if (operations.some((operation) => ['rejected', 'conflict'].includes(operation.status))) {
        status = 'failed'; reason = 'OPERATION_FAILED_OR_CONFLICTED';
      } else if (plan.type !== 'dailyBoost' && operations.some((operation) => operation.status === 'applied' && !operation.removed)) {
        status = 'partial'; reason = 'REMOVAL_INCOMPLETE';
      } else if (unverifiedOperations) { status = 'unverified'; reason = 'REWARD_OR_OPERATION_UNVERIFIED'; }
      else if (plan.verifiedToday >= plan.cap) status = 'completed';
      else if (['blocked', 'uncertain'].includes(report.status)) { status = 'blocked'; reason = 'RUN_STOPPED'; }
      else { status = 'partial'; reason = 'TASK_QUOTA_NOT_REACHED'; }
      return {
        type: plan.type, status, reason, attemptedOperations: operations.length,
        successfulOperations: operations.filter((action) => action.status === 'applied').length,
        removedOperations: operations.filter((action) => action.removed).length,
        verifiedGain: verified ? operations.reduce((sum, action) => sum + gained(action), 0) : null,
        verifiedToday: verified ? plan.verifiedToday : null,
        cap: plan.available ? plan.cap : null, unverifiedOperations,
      };
    });
    report.unverifiedOperations = report.tasks.reduce((sum, task) => sum + task.unverifiedOperations, 0);
  }
  return report;
}