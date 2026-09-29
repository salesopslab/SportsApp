import { cachedWithMeta } from "./cache.js";

// ---------------------------------------------------------------------------
// External insights for the AI chat: social posts and other AI platforms.
//
// Everything here goes through each platform's OFFICIAL, paid-or-approved API.
// We deliberately do not scrape Google, X, Meta or other AI sites: that breaks
// their terms, gets blocked within days, and exposes a paid product to legal
// risk. Each provider is optional — if its key isn't set, its tool simply
// isn't offered to the model.
//
//   X (Twitter)  — API v2 recent search (pay-per-use, ~$0.005 per post read)
//   Threads      — Meta's Threads keyword_search (needs threads_keyword_search
//                  app review; 500 queries / rolling 7 days)
//   Google       — Gemini API with "Grounding with Google Search"
//   Perplexity   — Agent API with web_search
//   OpenAI       — Responses API with web_search
//
// Results are cached so many users asking about the same game share one
// upstream call.
// ---------------------------------------------------------------------------

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);

const SOCIAL_CACHE_TTL = () => Number(env("SOCIAL_CACHE_TTL_SECONDS", 300));
const AI_CACHE_TTL = () => Number(env("AI_OPINION_CACHE_TTL_SECONDS", 900));
const TIMEOUT_MS = () => Number(env("INSIGHTS_TIMEOUT_MS", 25000));

export function configuredSocialProviders() {
  const out = [];
  if (env("X_BEARER_TOKEN")) out.push("x");
  if (env("THREADS_ACCESS_TOKEN")) out.push("threads");
  return out;
}

export function configuredAiProviders() {
  const out = [];
  if (env("GEMINI_API_KEY")) out.push("gemini");
  if (env("PERPLEXITY_API_KEY")) out.push("perplexity");
  if (env("OPENAI_API_KEY")) out.push("openai");
  return out;
}

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS());
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg = body?.detail || body?.title || body?.error?.message || body?.error || text.slice(0, 200);
      const err = new Error(`HTTP ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
      err.status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

// Strip anything that isn't a plausible handle (the model may pass "@name").
function cleanHandle(h) {
  const m = String(h || "").replace(/^@/, "").match(/^[A-Za-z0-9_.]{1,30}$/);
  return m ? m[0] : null;
}

// ---- X ---------------------------------------------------------------------

export function buildXQuery(query, accounts = []) {
  const handles = [...new Set([...(accounts || []), ...env("X_TRUSTED_ACCOUNTS", "").split(",")].map(cleanHandle).filter(Boolean))];
  // X caps a recent-search query at 512 chars; keep the account filter bounded.
  const fromClause = handles.length ? ` (${handles.slice(0, 12).map((h) => `from:${h}`).join(" OR ")})` : "";
  const base = String(query || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return `${base}${fromClause} -is:retweet -is:reply lang:en`.trim();
}

async function searchX(query, { accounts, limit }) {
  const q = buildXQuery(query, accounts);
  const params = new URLSearchParams({
    query: q,
    max_results: String(Math.min(Math.max(limit || 10, 10), 25)),
    sort_order: "recency",
    "tweet.fields": "created_at,public_metrics,author_id",
    expansions: "author_id",
    "user.fields": "username,name,verified",
  });
  const base = env("X_API_BASE", "https://api.x.com/2");
  const body = await fetchJson(`${base}/tweets/search/recent?${params}`, {
    headers: { Authorization: `Bearer ${env("X_BEARER_TOKEN")}` },
  });
  const users = Object.fromEntries((body?.includes?.users || []).map((u) => [u.id, u]));
  return (body?.data || []).map((t) => {
    const u = users[t.author_id] || {};
    return {
      platform: "X",
      author: u.username ? `@${u.username}` : null,
      author_name: u.name || null,
      verified: !!u.verified,
      text: t.text,
      posted_at: t.created_at || null,
      url: u.username ? `https://x.com/${u.username}/status/${t.id}` : `https://x.com/i/web/status/${t.id}`,
      engagement: t.public_metrics
        ? { likes: t.public_metrics.like_count, reposts: t.public_metrics.retweet_count, replies: t.public_metrics.reply_count }
        : null,
    };
  });
}

// ---- Threads ---------------------------------------------------------------

async function searchThreads(query, { limit }) {
  const params = new URLSearchParams({
    q: String(query || "").slice(0, 200),
    search_type: "RECENT",
    fields: "id,text,permalink,timestamp,username",
    limit: String(Math.min(limit || 10, 25)),
    access_token: env("THREADS_ACCESS_TOKEN"),
  });
  const base = env("THREADS_API_BASE", "https://graph.threads.net/v1.0");
  const body = await fetchJson(`${base}/keyword_search?${params}`);
  return (body?.data || []).map((p) => ({
    platform: "Threads",
    author: p.username ? `@${p.username}` : null,
    verified: false,
    text: p.text || "",
    posted_at: p.timestamp || null,
    url: p.permalink || null,
    engagement: null,
  }));
}

/**
 * Recent public posts about a query from X and/or Threads.
 * Returns { status, retrieved_at, providers: {x: {...}, threads: {...}}, posts: [...] }.
 */
export async function searchSocialPosts(query, { platforms, accounts, limit = 10 } = {}) {
  const available = configuredSocialProviders();
  const want = (platforms?.length ? platforms : available).filter((p) => available.includes(p));
  if (!want.length) {
    return { status: "unavailable", note: "No social platform API is configured on this server.", posts: [], providers: {} };
  }
  const providers = {};
  const posts = [];
  let newest = null;
  await Promise.all(
    want.map(async (p) => {
      const key = `social:${p}:${String(query).toLowerCase()}:${(accounts || []).join(",").toLowerCase()}:${limit}`;
      try {
        const { value, retrievedAt } = await cachedWithMeta(
          key,
          () => (p === "x" ? searchX(query, { accounts, limit }) : searchThreads(query, { limit })),
          SOCIAL_CACHE_TTL()
        );
        providers[p] = { status: "ok", count: value.length, retrieved_at: retrievedAt };
        if (!newest || retrievedAt > newest) newest = retrievedAt;
        posts.push(...value);
      } catch (err) {
        providers[p] = { status: "unavailable", error: err.message };
      }
    })
  );
  posts.sort((a, b) => String(b.posted_at || "").localeCompare(String(a.posted_at || "")));
  const anyOk = Object.values(providers).some((v) => v.status === "ok");
  return { status: anyOk ? "ok" : "unavailable", retrieved_at: newest, providers, posts: posts.slice(0, 20) };
}

// ---- Other AI platforms ------------------------------------------------------

// Pull {url, title} citations out of any provider response shape.
export function collectCitations(node, out = [], depth = 0) {
  if (!node || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectCitations(n, out, depth + 1);
    return out;
  }
  if (typeof node !== "object") return out;
  const url = node.url || node.uri;
  if (typeof url === "string" && /^https?:\/\//.test(url)) {
    out.push({ url, title: node.title || null, date: node.date || node.last_updated || null });
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "url" || k === "uri") continue;
    if (v && typeof v === "object") collectCitations(v, out, depth + 1);
  }
  return out;
}

function dedupeCitations(list) {
  const seen = new Set();
  return list.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))).slice(0, 8);
}

function aiPrompt(question, nowIso) {
  return `Today is ${nowIso}. You are giving a second opinion to a sports-betting research assistant.

Question: ${question}

Search the web for the most current information. Reply in under 180 words:
- Key facts (injuries/practice status, lineup news, line moves, weather, matchup trends), each with its source and date.
- Your lean, if any, with a one-line reason, and your confidence (Low/Medium/High).
Say plainly if something could not be verified. Do not guarantee outcomes. Ignore rumors about players' personal lives.`;
}

async function askGemini(prompt) {
  const model = env("GEMINI_MODEL", "gemini-3.8-flash");
  const base = env("GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta");
  const body = await fetchJson(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env("GEMINI_API_KEY") },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
  });
  const cand = body?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("").trim();
  const citations = (cand?.groundingMetadata?.groundingChunks || [])
    .map((c) => c.web)
    .filter((w) => w?.uri)
    .map((w) => ({ url: w.uri, title: w.title || null, date: null }));
  return { provider: "Google Gemini (Google Search grounding)", model, text, citations, searched_queries: cand?.groundingMetadata?.webSearchQueries || [] };
}

async function askPerplexity(prompt) {
  const model = env("PERPLEXITY_MODEL", "perplexity/sonar");
  const base = env("PERPLEXITY_API_BASE", "https://api.perplexity.ai/v1");
  const body = await fetchJson(`${base}/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("PERPLEXITY_API_KEY")}` },
    body: JSON.stringify({ model, input: prompt, tools: [{ type: "web_search" }] }),
  });
  let text = typeof body?.output_text === "string" ? body.output_text : "";
  if (!text) {
    for (const item of body?.output || []) {
      for (const c of item?.content || []) if (typeof c?.text === "string") text += c.text;
    }
  }
  return { provider: "Perplexity", model, text: text.trim(), citations: collectCitations(body?.output) };
}

async function askOpenAI(prompt) {
  const model = env("OPENAI_MODEL", "gpt-6-astra");
  const base = env("OPENAI_API_BASE", "https://api.openai.com/v1");
  const body = await fetchJson(`${base}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    body: JSON.stringify({ model, input: prompt, tools: [{ type: "web_search" }] }),
  });
  let text = typeof body?.output_text === "string" ? body.output_text : "";
  const citations = [];
  for (const item of body?.output || []) {
    if (item?.type !== "message") continue;
    for (const c of item.content || []) {
      if (!body?.output_text && typeof c?.text === "string") text += c.text;
      for (const a of c.annotations || []) if (a?.url) citations.push({ url: a.url, title: a.title || null, date: null });
    }
  }
  return { provider: "OpenAI", model, text: text.trim(), citations };
}

const AI_FNS = { gemini: askGemini, perplexity: askPerplexity, openai: askOpenAI };

/**
 * Ask every configured AI platform the same question, in parallel.
 * Returns { status, retrieved_at, opinions: [{provider, status, text, citations}] }.
 */
export async function askOtherAis(question, { providers, nowIso = new Date().toISOString() } = {}) {
  const available = configuredAiProviders();
  const want = (providers?.length ? providers : available).filter((p) => available.includes(p));
  if (!want.length) {
    return { status: "unavailable", note: "No other AI platform API is configured on this server.", opinions: [] };
  }
  const prompt = aiPrompt(question, nowIso.slice(0, 10));
  let newest = null;
  const opinions = await Promise.all(
    want.map(async (p) => {
      try {
        const { value, retrievedAt } = await cachedWithMeta(`ai:${p}:${String(question).toLowerCase()}`, () => AI_FNS[p](prompt), AI_CACHE_TTL());
        if (!newest || retrievedAt > newest) newest = retrievedAt;
        if (!value.text) return { provider: value.provider, status: "unavailable", error: "Empty answer" };
        return { ...value, status: "ok", citations: dedupeCitations(value.citations || []), retrieved_at: retrievedAt };
      } catch (err) {
        return { provider: p, status: "unavailable", error: err.message };
      }
    })
  );
  const anyOk = opinions.some((o) => o.status === "ok");
  return { status: anyOk ? "ok" : "unavailable", retrieved_at: newest, opinions };
}
