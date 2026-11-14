import { setTimeout as sleep } from 'node:timers/promises';
import { parse as parseDevalue } from 'devalue';
import superjson from 'superjson';

const BASE_URL = 'https://civitai.com';
const MUTATIONS = new Set([
  'buzz.claimDailyBoostReward',
  'reaction.toggle',
  'user.toggleFollow',
]);
const RETRYABLE_READ_STATUS = new Set([429, 500, 502, 503, 504]);

export class CivitaiError extends Error {
  constructor(message, { status = 0, code = 'API_ERROR', uncertain = false } = {}) {
    super(message);
    this.name = 'CivitaiError';
    this.status = status;
    this.code = code;
    this.uncertain = uncertain;
  }
}

export function utcDay(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

export function dayRange(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid UTC day');
  const start = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || utcDay(start) !== day) {
    throw new Error('Invalid UTC day');
  }
  return { start, end: new Date(start.getTime() + 86400000 - 1) };
}

function decodeResult(body) {
  const envelope = Array.isArray(body) && body.length === 1 ? body[0] : body;
  if (!envelope || typeof envelope !== 'object') {
    throw new CivitaiError('Invalid tRPC envelope', { code: 'SCHEMA_CHANGED' });
  }
  if (envelope.error) {
    const serialized = typeof envelope.error === 'string' ? parseDevalue(envelope.error) : envelope.error;
    const error = serialized.json ? superjson.deserialize(serialized) : serialized;
    throw new CivitaiError(String(error.message ?? 'tRPC request failed'), {
      status: error.data?.httpStatus ?? 0,
      code: error.data?.code ?? 'TRPC_ERROR',
    });
  }
  if (!envelope.result || !Object.hasOwn(envelope.result, 'data')) {
    throw new CivitaiError('Missing tRPC result', { code: 'SCHEMA_CHANGED' });
  }
  const data = envelope.result.data;
  if (typeof data === 'string') return parseDevalue(data);
  if (data && typeof data === 'object' && Object.hasOwn(data, 'json')) {
    return superjson.deserialize(data);
  }
  throw new CivitaiError('Unknown tRPC serialization', { code: 'SCHEMA_CHANGED' });
}

export class CivitaiClient {
  #apiKey;
  #fetch;
  #sleep;
  #now;
  #random;
  #lastRequestAt = null;

  constructor({
    apiKey,
    fetchImpl = globalThis.fetch,
    sleepFn = sleep,
    nowFn = Date.now,
    randomFn = Math.random,
    requestIntervalMs,
    timeoutMs = 30000,
    readRetries = 2,
    signal,
  } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /\s/.test(apiKey.trim())) {
      throw new Error('Set CIVITAI_API_KEY to a valid API key; cookies are not used');
    }
    this.#apiKey = apiKey.trim();
    this.#fetch = fetchImpl;
    this.#sleep = sleepFn;
    this.#now = nowFn;
    this.#random = randomFn;
    this.requestIntervalMs = requestIntervalMs;
    this.timeoutMs = timeoutMs;
    this.readRetries = readRetries;
    this.signal = signal;
  }

  async #request(path, { method = 'GET', body, trpc = false } = {}) {
    const write = method !== 'GET';
    const attempts = write ? 1 : this.readRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.signal?.throwIfAborted();
      if (this.#lastRequestAt !== null) {
        const intervalMs = this.requestIntervalMs ?? (500 + Math.floor(this.#random() * 1001));
        const remaining = intervalMs - (this.#now() - this.#lastRequestAt);
        if (remaining > 0) await this.#sleep(remaining, undefined, { signal: this.signal });
      }
      this.#lastRequestAt = this.#now();
      let response;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        response = await this.#fetch(new URL(path, BASE_URL), {
          method,
          redirect: 'error',
          cache: 'no-store',
          signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            Accept: 'application/json',
            'User-Agent': 'Civitai-Checkin/0.1',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        if (!write && attempt + 1 < attempts && !this.signal?.aborted) {
          await this.#sleep(1500 * (2 ** attempt), undefined, { signal: this.signal });
          continue;
        }
        throw new CivitaiError(`Network failure calling ${path.split('?')[0]}`, {
          code: 'NETWORK_ERROR', uncertain: write,
        });
      }

      if (!write && RETRYABLE_READ_STATUS.has(response.status) && attempt + 1 < attempts) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter !== null && retryAfter.trim() !== '' ? Number(retryAfter) : NaN;
        const requestedWait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - this.#now();
        const waitMs = Number.isFinite(requestedWait)
          ? Math.max(1000, requestedWait) : 1500 * (2 ** attempt);
        if (waitMs > 120000) {
          throw new CivitaiError('Retry-After exceeds this run budget; retry later', {
            status: response.status, code: 'RETRY_AFTER_BUDGET',
          });
        }
        await this.#sleep(waitMs, undefined, { signal: this.signal });
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(contentType)) {
        throw new CivitaiError(`HTTP ${response.status}: non-JSON response; stop for manual verification`, {
          status: response.status, code: 'BLOCKED_OR_INVALID_RESPONSE',
          uncertain: write && (response.ok || response.status >= 500),
        });
      }
      try {
        const data = await response.json();
        if (trpc) {
          const decoded = decodeResult(data);
          if (!response.ok) throw new CivitaiError(`HTTP ${response.status}`, { status: response.status });
          return decoded;
        }
        if (!response.ok) {
          throw new CivitaiError(`HTTP ${response.status}: ${String(data.error ?? 'request failed')}`, {
            status: response.status,
          });
        }
        return data;
      } catch (error) {
        const status = error instanceof CivitaiError ? error.status || response.status : response.status;
        const message = error instanceof CivitaiError ? error.message : 'Invalid API response';
        throw new CivitaiError(message.replaceAll(this.#apiKey, '[REDACTED]'), {
          status,
          code: error instanceof CivitaiError ? error.code : 'SCHEMA_CHANGED',
          uncertain: write && (response.ok || response.status >= 500),
        });
      }
    }
    throw new CivitaiError('Read retries exhausted');
  }

  query(procedure, input = {}) {
    if (!/^[\w]+\.[\w]+$/.test(procedure)) throw new Error('Invalid procedure');
    const search = new URLSearchParams({ input: JSON.stringify(superjson.serialize(input)) });
    return this.#request(`/api/trpc/${procedure}?${search}`, { trpc: true });
  }

  mutate(procedure, input = null) {
    if (!MUTATIONS.has(procedure)) throw new Error('Mutation is not allowed by this tool');
    return this.#request(`/api/trpc/${procedure}`, {
      method: 'POST', body: superjson.serialize(input), trpc: true,
    });
  }

  async me() {
    const profile = await this.#request('/api/v1/me');
    if (!Number.isSafeInteger(profile?.id) || profile.id <= 0 || typeof profile.username !== 'string') {
      throw new CivitaiError('Invalid account profile', { code: 'SCHEMA_CHANGED' });
    }
    return profile;
  }

  async transactionsOfDay(day, { maxPages = 50 } = {}) {
    const range = dayRange(day);
    const transactions = [];
    const seenCursors = new Set();
    let cursor;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.query('buzz.getUserTransactions', {
        ...range, accountTypes: ['blue'], limit: 200, ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result?.transactions) || !Object.hasOwn(result, 'cursor')) {
        throw new CivitaiError('Invalid transaction page; refusing to estimate quotas', { code: 'SCHEMA_CHANGED' });
      }
      transactions.push(...result.transactions);
      if (result.cursor === null) return transactions;
      if (typeof result.cursor !== 'string' || !result.cursor || seenCursors.has(result.cursor)) {
        throw new CivitaiError('Invalid or repeated transaction cursor', { code: 'INCOMPLETE_LEDGER' });
      }
      seenCursors.add(result.cursor);
      cursor = result.cursor;
    }
    throw new CivitaiError('Transaction pagination budget exceeded; no writes are safe', {
      code: 'INCOMPLETE_LEDGER',
    });
  }

  async followingIds() {
    const ids = await this.query('user.getFollowingUsers');
    if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
      throw new CivitaiError('Expected numeric following IDs; refusing to toggle follows', { code: 'SCHEMA_CHANGED' });
    }
    return new Set(ids);
  }

  async imageReactions(imageIds) {
    const result = await this.query('reaction.getMyImageReactions', { imageIds });
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || !Object.values(result).every((reactions) => Array.isArray(reactions)
        && reactions.every((reaction) => typeof reaction === 'string'))) {
      throw new CivitaiError('Invalid existing reactions; refusing to toggle images', { code: 'SCHEMA_CHANGED' });
    }
    return result;
  }

  async listImages({ limit = 100, cursor } = {}) {
    const search = new URLSearchParams({ limit: String(limit), sort: 'Newest', nsfw: 'false' });
    if (cursor) search.set('cursor', cursor);
    const result = await this.#request(`/api/v1/images?${search}`);
    if (!Array.isArray(result?.items)) {
      throw new CivitaiError('Invalid image list', { code: 'SCHEMA_CHANGED' });
    }
    return result;
  }
}