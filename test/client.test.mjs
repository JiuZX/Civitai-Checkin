import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify as stringifyDevalue } from 'devalue';
import superjson from 'superjson';
import { CivitaiClient, CivitaiError, dayRange, utcDay } from '../src/client.mjs';

const apiKey = 'test-secret-not-a-real-key';
const response = (data, status = 200) => Response.json(data, { status });
const trpc = (value) => response({ result: { data: superjson.serialize(value) } });
const clientWith = (fetchImpl, options = {}) => new CivitaiClient({
  apiKey, fetchImpl, requestIntervalMs: 0, readRetries: 0,
  sleepFn: async () => {}, ...options,
});

test('randomizes request intervals within 500-1500 ms for both reads and writes', async () => {
  let nowMs = 0;
  const waits = [];
  const requests = [];
  const randomValues = [0, 0.5, 1 - Number.EPSILON, 0.25];
  const client = clientWith(async (url, init) => {
    requests.push([init.method, nowMs]);
    return init.method === 'POST' ? trpc('created') : response({ id: 42, username: 'tester' });
  }, {
    requestIntervalMs: undefined,
    randomFn: () => randomValues.shift(),
    nowFn: () => nowMs,
    sleepFn: async (duration) => {
      waits.push(duration);
      nowMs += duration;
    },
  });
  await client.me();
  await client.me();
  await client.mutate('reaction.toggle', { entityType: 'image', entityId: 101, reaction: 'Like' });
  await client.me();
  nowMs += 3000;
  await client.me();
  assert.deepEqual(waits, [500, 1000, 1500]);
  assert.deepEqual(requests, [['GET', 0], ['GET', 500], ['POST', 1500], ['GET', 3000], ['GET', 6000]]);
  assert.deepEqual(randomValues, []);
});

test('uses the fixed Civitai host, Bearer only and the three allowed mutations', async () => {
  let calls = 0;
  const client = clientWith(async (url, init) => {
    calls += 1;
    assert.equal(url.origin, 'https://civitai.com');
    assert.equal(init.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(Object.hasOwn(init.headers, 'Cookie'), false);
    assert.equal(init.redirect, 'error');
    return response({ id: 42, username: 'tester' });
  }, { host: 'https://example.com' });
  assert.equal((await client.me()).id, 42);
  assert.throws(() => client.mutate('buzz.tipUser'), /not allowed/);
  assert.equal(calls, 1);
});

test('serializes UTC dates and consumes every transaction cursor', async () => {
  const requests = [];
  const client = clientWith(async (url) => {
    const input = superjson.deserialize(JSON.parse(url.searchParams.get('input')));
    requests.push(input);
    assert.ok(input.start instanceof Date);
    assert.ok(input.end instanceof Date);
    assert.equal(input.start.toISOString(), '2026-11-14T00:00:00.000Z');
    assert.equal(input.end.toISOString(), '2026-11-14T23:59:59.999Z');
    assert.deepEqual(input.accountTypes, ['blue']);
    return requests.length === 1
      ? trpc({ transactions: [{ amount: 25 }], cursor: 'next-page' })
      : trpc({ transactions: [{ amount: 2 }], cursor: null });
  });
  assert.equal((await client.transactionsOfDay('2026-11-14')).length, 2);
  assert.equal(requests[1].cursor, 'next-page');
});

test('refuses truncated or looping ledgers', async () => {
  const looping = clientWith(async () => trpc({ transactions: [], cursor: 'same' }));
  await assert.rejects(looping.transactionsOfDay('2026-11-14'), /repeated/);
  const truncated = clientWith(async () => trpc({ transactions: [] }));
  await assert.rejects(truncated.transactionsOfDay('2026-11-14'), /Invalid transaction/);
  const capped = clientWith(async () => trpc({ transactions: [], cursor: 'next' }));
  await assert.rejects(capped.transactionsOfDay('2026-11-14', { maxPages: 1 }), /budget exceeded/);
});

test('accepts numeric following IDs and distinguishes an empty list from an error', async () => {
  assert.deepEqual(await clientWith(async () => trpc([101, 202])).followingIds(), new Set([101, 202]));
  assert.equal((await clientWith(async () => trpc([])).followingIds()).size, 0);
  await assert.rejects(clientWith(async () => trpc(['creator-name'])).followingIds(), /numeric following/);
});

test('decodes devalue responses and validates reaction maps', async () => {
  const client = clientWith(async () => response({
    result: { data: stringifyDevalue({ 101: ['Like'] }) },
  }));
  assert.deepEqual(await client.imageReactions([101]), { 101: ['Like'] });
  await assert.rejects(clientWith(async () => trpc(null)).imageReactions([101]), /Invalid existing/);
});

test('recognizes errors inside HTTP 200 and never prints the API key', async () => {
  const client = clientWith(async () => response({
    error: { json: { message: `Invalid key ${apiKey}`, data: { httpStatus: 401, code: 'UNAUTHORIZED' } } },
  }));
  await assert.rejects(client.query('user.getFollowingUsers'), (error) => {
    assert.ok(error instanceof CivitaiError);
    assert.equal(error.status, 401);
    assert.equal(error.message.includes(apiKey), false);
    return true;
  });
});

test('only retries reads, including read-side 429', async () => {
  let reads = 0;
  const waits = [];
  const client = clientWith(async () => {
    reads += 1;
    return reads === 1 ? response({ error: 'slow down' }, 429) : trpc([]);
  }, { readRetries: 1, sleepFn: async (duration) => { waits.push(duration); } });
  await client.followingIds();
  assert.equal(reads, 2);
  assert.equal(waits.length, 1);
  let writes = 0;
  const writer = clientWith(async () => {
    writes += 1;
    throw new Error('socket lost');
  }, { readRetries: 3 });
  await assert.rejects(writer.mutate('reaction.toggle', { entityId: 1 }), (error) => error.uncertain);
  assert.equal(writes, 1);
});

test('rejects HTML challenge pages without exposing their contents', async () => {
  const client = clientWith(async () => new Response('<html>Challenge</html>', {
    headers: { 'Content-Type': 'text/html' },
  }));
  await assert.rejects(client.me(), /non-JSON.*manual verification/);
});

test('UTC day boundaries are independent of local time and reject invalid dates', () => {
  assert.equal(utcDay(new Date('2026-11-14T07:59:59+08:00')), '2026-11-13');
  assert.equal(dayRange('2026-11-14').start.getUTCHours(), 0);
  assert.throws(() => dayRange('2026-02-31'), /Invalid UTC day/);
});

test('decodes devalue error payloads and accepts successful void daily claims', async () => {
  const failure = clientWith(async () => response({ error: stringifyDevalue({
    message: 'Insufficient scope', data: { httpStatus: 403, code: 'FORBIDDEN' },
  }) }, 403));
  await assert.rejects(failure.query('user.getFollowingUsers'), (error) => {
    assert.equal(error.code, 'FORBIDDEN');
    return error.status === 403;
  });
  const claims = clientWith(async () => trpc(undefined));
  assert.equal(await claims.mutate('buzz.claimDailyBoostReward'), undefined);
  const devalueClaim = clientWith(async () => response({ result: { data: stringifyDevalue(undefined) } }));
  assert.equal(await devalueClaim.mutate('buzz.claimDailyBoostReward'), undefined);
});

test('HTTP 5xx or malformed successful mutation responses are uncertain and never retried', async () => {
  for (const [status, payload] of [[502, '<html>upstream failed</html>'], [200, '{invalid']]) {
    let attempts = 0;
    const client = clientWith(async () => {
      attempts += 1;
      return new Response(payload, { status, headers: { 'Content-Type': status === 502 ? 'text/html' : 'application/json' } });
    }, { readRetries: 3 });
    await assert.rejects(client.mutate('user.toggleFollow', { targetUserId: 101 }), (error) => error.uncertain);
    assert.equal(attempts, 1);
  }
});

test('honors Retry-After HTTP dates and stops instead of retrying before a long server delay', async () => {
  const nowMs = Date.parse('2026-11-14T12:00:00Z');
  const waits = [];
  let attempts = 0;
  const dated = clientWith(async () => {
    attempts += 1;
    if (attempts === 1) return new Response('{}', { status: 429, headers: {
      'Content-Type': 'application/json', 'Retry-After': new Date(nowMs + 45000).toUTCString(),
    } });
    return trpc([]);
  }, { readRetries: 1, nowFn: () => nowMs, sleepFn: async (duration) => { waits.push(duration); } });
  await dated.followingIds();
  assert.deepEqual(waits, [45000]);
  const long = clientWith(async () => new Response('{}', {
    status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '300' },
  }), { readRetries: 1 });
  await assert.rejects(long.followingIds(), /retry later/);
});

test('fetches more than 200 ledger rows even when transaction IDs are absent', async () => {
  let pages = 0;
  const client = clientWith(async () => {
    pages += 1;
    return trpc({
      transactions: Array.from({ length: pages === 1 ? 200 : 51 }, (_, index) => ({ amount: index })),
      cursor: pages === 1 ? '2026-11-14 11:00:00|12345678-1234-1234-1234-123456789abc' : null,
    });
  });
  assert.equal((await client.transactionsOfDay('2026-11-14')).length, 251);
  assert.equal(pages, 2);
});