import NodeCache from "node-cache";

// Odds/stats/weather providers bill per request or have rate limits.
// A short TTL cache means 50 users looking at the same game only cost you 1 upstream call.
const ttl = Number(process.env.CACHE_TTL_SECONDS || 90);
const cache = new NodeCache({ stdTTL: ttl, checkperiod: 30 });

// ttlSeconds is optional — pass it to override the default TTL for just this
// key (e.g. a longer-lived cache for calls that are expensive/quota-limited
// but don't need to be second-fresh, like odds lines vs. live scores).
export async function cached(key, fetcher, ttlSeconds) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const value = await fetcher();
  if (ttlSeconds !== undefined) {
    cache.set(key, value, ttlSeconds);
  } else {
    cache.set(key, value);
  }
  return value;
}

export default cache;
