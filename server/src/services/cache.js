import NodeCache from "node-cache";

// Odds/stats/weather providers bill per request or have rate limits.
// A short TTL cache means 50 users looking at the same game only cost you 1 upstream call.
const ttl = Number(process.env.CACHE_TTL_SECONDS || 90);
const cache = new NodeCache({ stdTTL: ttl, checkperiod: 30 });

export async function cached(key, fetcher) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const value = await fetcher();
  cache.set(key, value);
  return value;
}

export default cache;
