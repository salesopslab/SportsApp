import NodeCache from "node-cache";

// Odds/stats/weather providers bill per request or have rate limits.
// A short TTL cache means 50 users looking at the same game only cost you 1 upstream call.
const ttl = Number(process.env.CACHE_TTL_SECONDS || 90);
const cache = new NodeCache({ stdTTL: ttl, checkperiod: 30 });

// Every entry is stored alongside the moment it was fetched from upstream, so
// callers that care about freshness (injuries, odds, the AI chat's
// data-quality checks) can report "Updated 8 min ago" honestly instead of
// implying cached data is live.
function wrap(value) {
  return { __cached: true, value, retrievedAt: new Date().toISOString() };
}

// ttlSeconds is optional — pass it to override the default TTL for just this
// key (e.g. a longer-lived cache for calls that are expensive/quota-limited
// but don't need to be second-fresh, like odds lines vs. live scores).
export async function cached(key, fetcher, ttlSeconds) {
  return (await cachedWithMeta(key, fetcher, ttlSeconds)).value;
}

// Same as cached(), but also returns when the value was actually retrieved
// from upstream: { value, retrievedAt, fromCache }.
export async function cachedWithMeta(key, fetcher, ttlSeconds) {
  const hit = cache.get(key);
  if (hit !== undefined && hit && hit.__cached) {
    return { value: hit.value, retrievedAt: hit.retrievedAt, fromCache: true };
  }

  const value = await fetcher();
  const entry = wrap(value);
  if (ttlSeconds !== undefined) {
    cache.set(key, entry, ttlSeconds);
  } else {
    cache.set(key, entry);
  }
  return { value, retrievedAt: entry.retrievedAt, fromCache: false };
}

// When was this key last fetched from upstream? null if not cached.
export function cachedAt(key) {
  const hit = cache.get(key);
  return hit && hit.__cached ? hit.retrievedAt : null;
}

// Drop a key so the next read goes upstream (used by forced refreshes).
export function invalidate(key) {
  cache.del(key);
}

export default cache;
