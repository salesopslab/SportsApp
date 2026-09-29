// Unit tests for insightsService: X, Threads, Gemini, Perplexity, OpenAI
// response parsing against mocked official-API responses.
// Usage: node test/insights.test.mjs
import assert from "node:assert/strict";

const seen = [];
let mode = "ok";
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  seen.push({ url: u, opts });
  if (mode === "down") return new Response("nope", { status: 503 });
  if (u.startsWith("https://api.x.com/2/tweets/search/recent")) {
    return json({
      data: [
        { id: "111", text: "Daniels was limited again today, per coach.", author_id: "u1", created_at: "2026-09-29T15:00:00.000Z", public_metrics: { like_count: 40, retweet_count: 5, reply_count: 3 } },
        { id: "222", text: "Older post", author_id: "u2", created_at: "2026-09-28T15:00:00.000Z" },
      ],
      includes: { users: [{ id: "u1", username: "BeatWriter", name: "Beat Writer", verified: true }, { id: "u2", username: "fan123", name: "Fan" }] },
    });
  }
  if (u.startsWith("https://graph.threads.net/v1.0/keyword_search")) {
    return json({ data: [{ id: "t1", text: "Commanders injury update", permalink: "https://www.threads.com/@team/post/abc", timestamp: "2026-09-29T15:30:00+0000", username: "team" }] });
  }
  if (u.includes("generativelanguage.googleapis.com")) {
    return json({
      candidates: [
        {
          content: { parts: [{ text: "Daniels is questionable (elbow)." }] },
          groundingMetadata: { webSearchQueries: ["Jayden Daniels injury"], groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/x", title: "espn.com" } }] },
        },
      ],
    });
  }
  if (u === "https://api.perplexity.ai/v1/agent") {
    return json({
      status: "completed",
      output: [
        { type: "search_results", results: [{ url: "https://www.nfl.com/injuries", title: "NFL injuries", date: "2026-09-29" }] },
        { type: "message", content: [{ type: "output_text", text: "Lean: Colts +3, low confidence." }] },
      ],
    });
  }
  if (u === "https://api.openai.com/v1/responses") {
    return json({
      output: [
        { type: "web_search_call", status: "completed" },
        { type: "message", content: [{ type: "output_text", text: "Line moved from -2.5 to -3.", annotations: [{ type: "url_citation", url: "https://www.actionnetwork.com/x", title: "Line move" }] }] },
      ],
    });
  }
  return new Response("unexpected " + u, { status: 404 });
};

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("  ✓", name);
  } catch (e) {
    failures++;
    console.log("  ✗", name, "\n   ", e.message);
  }
}

const cache = (await import("../src/services/cache.js")).default;
const svc = await import("../src/services/insightsService.js");

await test("nothing configured → tools report unavailable, no upstream calls", async () => {
  for (const k of ["X_BEARER_TOKEN", "THREADS_ACCESS_TOKEN", "GEMINI_API_KEY", "PERPLEXITY_API_KEY", "OPENAI_API_KEY"]) delete process.env[k];
  seen.length = 0;
  assert.deepEqual(svc.configuredSocialProviders(), []);
  assert.deepEqual(svc.configuredAiProviders(), []);
  assert.equal((await svc.searchSocialPosts("x")).status, "unavailable");
  assert.equal((await svc.askOtherAis("x")).status, "unavailable");
  assert.equal(seen.length, 0);
});

process.env.X_BEARER_TOKEN = "xb";
process.env.THREADS_ACCESS_TOKEN = "th";
process.env.GEMINI_API_KEY = "g";
process.env.PERPLEXITY_API_KEY = "p";
process.env.OPENAI_API_KEY = "o";

await test("X query adds filters and a bounded, sanitized account list", async () => {
  const q = svc.buildXQuery("Jayden Daniels practice", ["@BeatWriter", "bad handle!", "Commanders"]);
  assert.equal(q, "Jayden Daniels practice (from:BeatWriter OR from:Commanders) -is:retweet -is:reply lang:en");
});

await test("social search merges X + Threads, newest first, with post URLs and auth", async () => {
  cache.flushAll();
  seen.length = 0;
  const r = await svc.searchSocialPosts("Jayden Daniels", { accounts: ["BeatWriter"] });
  assert.equal(r.status, "ok");
  assert.equal(r.providers.x.status, "ok");
  assert.equal(r.providers.threads.status, "ok");
  assert.equal(r.posts[0].platform, "Threads");
  const x = r.posts.find((p) => p.author === "@BeatWriter");
  assert.equal(x.url, "https://x.com/BeatWriter/status/111");
  assert.equal(x.verified, true);
  assert.equal(x.engagement.likes, 40);
  const xCall = seen.find((c) => c.url.includes("api.x.com"));
  assert.equal(xCall.opts.headers.Authorization, "Bearer xb");
  assert.match(decodeURIComponent(xCall.url), /from:BeatWriter/);
});

await test("social results are cached (second identical search makes no calls)", async () => {
  seen.length = 0;
  await svc.searchSocialPosts("Jayden Daniels", { accounts: ["BeatWriter"] });
  assert.equal(seen.length, 0);
});

await test("other AIs: Gemini (Google Search), Perplexity and OpenAI answers + citations", async () => {
  cache.flushAll();
  seen.length = 0;
  const r = await svc.askOtherAis("Colts at Commanders lean?");
  assert.equal(r.status, "ok");
  const by = Object.fromEntries(r.opinions.map((o) => [o.provider.split(" ")[0], o]));
  assert.match(by.Google.text, /questionable/);
  assert.equal(by.Google.citations[0].title, "espn.com");
  assert.match(by.Perplexity.text, /Colts \+3/);
  assert.equal(by.Perplexity.citations[0].url, "https://www.nfl.com/injuries");
  assert.match(by.OpenAI.text, /-2.5 to -3/);
  assert.equal(by.OpenAI.citations[0].url, "https://www.actionnetwork.com/x");
  const gem = seen.find((c) => c.url.includes("generativelanguage"));
  assert.deepEqual(JSON.parse(gem.opts.body).tools, [{ google_search: {} }]);
  assert.equal(gem.opts.headers["x-goog-api-key"], "g");
  assert.deepEqual(JSON.parse(seen.find((c) => c.url.includes("perplexity")).opts.body).tools, [{ type: "web_search" }]);
});

await test("provider outage → per-provider 'unavailable', never a fake answer", async () => {
  cache.flushAll();
  mode = "down";
  const s = await svc.searchSocialPosts("Daniels");
  const a = await svc.askOtherAis("Daniels?");
  mode = "ok";
  assert.equal(s.status, "unavailable");
  assert.equal(s.posts.length, 0);
  assert.match(s.providers.x.error, /503/);
  assert.equal(a.status, "unavailable");
  assert.ok(a.opinions.every((o) => o.status === "unavailable" && !o.text));
});

console.log(failures ? `\n${failures} test(s) failed` : "\nAll insights tests passed");
process.exit(failures ? 1 : 0);
