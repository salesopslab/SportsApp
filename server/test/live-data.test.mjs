// Integration test: runs the REAL dossier + chat routes against mocked
// upstreams (ESPN, SportsDataIO, The Odds API, Anthropic) for Colts @ Commanders.
// Usage: node test/live-data.test.mjs
import assert from "node:assert/strict";
import express from "express";

process.env.ODDS_API_BASE = "https://api.the-odds-api.com/v4";
process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.DATABASE_URL;

const NOW = Date.now();
const iso = (minsAgo) => new Date(NOW - minsAgo * 60000).toISOString();
const GAME_ID = "colts-at-commanders";

let scenario = "normal";
const calls = [];
const anthropicRequests = [];

function espnInjuries() {
  const colts = Array.from({ length: 11 }, (_, i) => ({
    id: `c${i}`,
    status: i % 3 === 0 ? "Out" : "Questionable",
    date: iso(120 + i),
    shortComment: i % 2 ? "Player was a limited participant in Thursday's practice." : "Player did not practice Thursday.",
    athlete: { displayName: `Colt Player ${i + 1}`, position: { abbreviation: "WR" } },
    type: { description: "questionable" },
    details: { type: "Hamstring", side: "Left", detail: "Not Specified" },
  }));
  const commanders = [
    {
      id: "w1",
      status: "Questionable",
      date: iso(45),
      shortComment: "Daniels (elbow) was a limited participant in Thursday's practice.",
      athlete: { displayName: "Jayden Daniels", position: { abbreviation: "QB" } },
      type: { description: "questionable" },
      details: { type: "Elbow", side: "Left", detail: "Not Specified", returnDate: "2026-10-04" },
    },
    {
      id: "w2",
      status: "Out",
      date: iso(60),
      shortComment: "Did not practice.",
      athlete: { displayName: "Terry McLaurin", position: { abbreviation: "WR" } },
      details: { type: "Quad" },
    },
  ];
  const groups = [{ id: "11", displayName: "Indianapolis Colts", injuries: colts }];
  if (scenario !== "commanders-missing") groups.push({ id: "28", displayName: "Washington Commanders", injuries: commanders });
  return { timestamp: iso(30), status: "success", injuries: groups };
}

const oddsGame = {
  id: GAME_ID,
  sport_key: "americanfootball_nfl",
  commence_time: new Date(NOW + 4 * 86400000).toISOString(),
  home_team: "Washington Commanders",
  away_team: "Indianapolis Colts",
  bookmakers: [
    {
      title: "DraftKings",
      markets: [
        { key: "h2h", outcomes: [{ name: "Washington Commanders", price: -150 }, { name: "Indianapolis Colts", price: 130 }] },
        { key: "spreads", outcomes: [{ name: "Washington Commanders", price: -110, point: -3 }, { name: "Indianapolis Colts", price: -110, point: 3 }] },
        { key: "totals", outcomes: [{ name: "Over", price: -110, point: 44.5 }, { name: "Under", price: -110, point: 44.5 }] },
      ],
    },
  ],
};

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push(u);
  if (u.includes("site.api.espn.com") && u.endsWith("/injuries")) {
    if (scenario === "all-down") return new Response("blocked", { status: 403 });
    return jsonRes(espnInjuries());
  }
  if (u.includes("site.api.espn.com")) return jsonRes({ events: [] }); // H2H schedules
  if (u.includes("sportsdata.io") && u.includes("InjuredPlayers")) {
    if (scenario === "all-down") return new Response("down", { status: 500 });
    // SportsData.io trial data: names scrambled, except one that conflicts.
    return jsonRes([
      { Name: "Scrambled Name", Team: "IND", Position: "WR", InjuryStatus: "Out", BodyPart: "Knee" },
      { Name: "Jayden Daniels", Team: "WAS", Position: "QB", InjuryStatus: "Doubtful", BodyPart: "Elbow" },
    ]);
  }
  if (u.includes("sportsdata.io")) return jsonRes([]);
  if (u.includes("the-odds-api.com") && u.includes("/odds")) return jsonRes([oddsGame]);
  if (u.includes("the-odds-api.com") && u.includes("/scores")) return jsonRes([]);
  if (u.includes("api.anthropic.com")) {
    const body = JSON.parse(opts.body);
    anthropicRequests.push(body);
    const last = body.messages[body.messages.length - 1];
    const hasToolResult = Array.isArray(last.content) && last.content.some((c) => c.type === "tool_result");
    if (!hasToolResult) {
      return jsonRes({
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Checking the latest report." },
          { type: "tool_use", id: "tu1", name: "get_injury_report", input: { team: "home" } },
        ],
      });
    }
    return jsonRes({
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "Searching news." },
        { type: "server_tool_use", id: "st1", name: "web_search", input: { query: "Jayden Daniels elbow status" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "st1",
          content: [{ type: "web_search_result", url: "https://www.commanders.com/news/injury-report", title: "Commanders injury report", page_age: "2 hours ago" }],
        },
        {
          type: "text",
          text: "Jayden Daniels is Questionable (left elbow) and was limited in Thursday's practice, per ESPN's report updated 45 min ago.",
          citations: [{ type: "web_search_result_location", url: "https://www.commanders.com/news/injury-report", title: "Commanders injury report" }],
        },
      ],
    });
  }
  throw new Error(`Unmocked fetch: ${u}`);
};

const { default: dossierRouter } = await import("../src/routes/dossier.js");
const { default: chatRouter } = await import("../src/routes/chat.js");
const { default: gamesRouter } = await import("../src/routes/games.js");
const cache = (await import("../src/services/cache.js")).default;

// Bypass auth/tier middleware for the test: pretend an Edge Pro user.
function asEdgePro(router, method = "post") {
  for (const layer of router.stack) {
    if (layer.route && layer.route.methods[method]) {
      const handlers = layer.route.stack;
      handlers[0].handle = (req, _res, next) => { req.userRow = { tier: "edge_pro" }; req.tier = "edge_pro"; next(); };
      handlers[1].handle = (_req, _res, next) => next();
    }
  }
}
asEdgePro(chatRouter);

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/dossier", dossierRouter);
app.use("/api/chat", chatRouter);
app.use("/api/games", gamesRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

// Use undici-free local calls via the original global fetch? We replaced it,
// so route local calls through node:http instead.
import http from "node:http";
function local(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(base + path, { method, headers: { "content-type": "application/json" } }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

let dossier;
await test("dossier returns injuries.homeTeam AND injuries.awayTeam", async () => {
  const r = await local("GET", `/api/dossier/nfl/${GAME_ID}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  dossier = r.json;
  if (process.env.DUMP_DOSSIER) (await import("node:fs")).writeFileSync(process.env.DUMP_DOSSIER, JSON.stringify(dossier));
  const { homeTeam, awayTeam } = dossier.injuries;
  assert.equal(homeTeam.team, "Washington Commanders");
  assert.equal(awayTeam.team, "Indianapolis Colts");
  assert.equal(homeTeam.status, "ok");
  assert.equal(awayTeam.status, "ok");
  assert.equal(awayTeam.players.length, 11, "all 11 Colts injuries present (no truncation)");
  assert.equal(homeTeam.players.length, 2);
  assert.equal(dossier.sport, "nfl");
});

await test("Jayden Daniels shown with elbow injury, Questionable, Limited practice — not healthy", async () => {
  const jd = dossier.injuries.homeTeam.players.find((p) => p.name === "Jayden Daniels");
  assert.ok(jd, "Daniels present");
  assert.equal(jd.gameDesignation, "Questionable");
  assert.match(jd.injury, /Elbow/);
  assert.equal(jd.practiceStatus, "Limited");
  assert.equal(jd.position, "QB");
});

await test("freshness metadata present on each team report", async () => {
  for (const r of [dossier.injuries.homeTeam, dossier.injuries.awayTeam]) {
    for (const k of ["source", "source_url", "retrieved_at", "published_at", "last_updated"]) {
      assert.ok(r[k], `${r.team} missing ${k}`);
    }
    assert.equal(r.absenceMeansHealthy, false);
  }
  assert.equal(dossier.injuries.homeTeam.source_url, "https://www.espn.com/nfl/team/injuries/_/name/wsh");
  assert.ok(dossier.dataFreshness.odds.retrieved_at, "odds retrieved_at");
});

await test("conflicting sources are surfaced, not resolved silently", async () => {
  const c = dossier.injuries.homeTeam.conflicts;
  assert.equal(c.length, 1);
  assert.equal(c[0].player, "Jayden Daniels");
  assert.deepEqual(c[0].reports.map((x) => x.gameDesignation).sort(), ["Doubtful", "Questionable"]);
});

await test("chat: uses live tools + web search, returns sources and timestamps", async () => {
  const r = await local("POST", "/api/chat", { message: "Is Jayden Daniels playing Sunday?", context: dossier, sport: "nfl" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.reply, /Questionable/);
  assert.doesNotMatch(r.json.reply, /Searching news|Checking the latest/, "preamble stripped");
  const first = anthropicRequests[0];
  const toolNames = first.tools.map((t) => t.name);
  assert.ok(toolNames.includes("web_search"), "web_search offered");
  assert.ok(toolNames.includes("get_injury_report"), "injury tool offered");
  assert.match(first.system, /Missing data is UNKNOWN, never healthy/);
  assert.doesNotMatch(first.system, /Use ONLY facts present in MATCHUP_CONTEXT/);
  assert.match(first.system, /DATA_FRESHNESS/);
  const toolResult = JSON.parse(anthropicRequests[1].messages[2].content[0].content);
  assert.equal(toolResult.homeTeam.players.find((p) => p.name === "Jayden Daniels").game_designation, "Questionable");
  const labels = r.json.sources.map((s) => s.label);
  assert.ok(labels.some((l) => /ESPN injury report — Washington Commanders/.test(l)), labels.join(" | "));
  assert.ok(r.json.sources.some((s) => s.url === "https://www.commanders.com/news/injury-report" && s.cited));
  assert.ok(r.json.sources.find((s) => s.kind === "data").retrieved_at);
  assert.equal(r.json.usedWebSearch, true);
});

await test("chat: stale injury data in context is refreshed BEFORE answering a status question", async () => {
  const stale = JSON.parse(JSON.stringify(dossier));
  stale.injuries.homeTeam.retrieved_at = iso(240);
  stale.injuries.homeTeam.players = []; // e.g. old snapshot missing Daniels
  anthropicRequests.length = 0;
  const r = await local("POST", "/api/chat", { message: "Who is out for Washington?", context: stale, sport: "nfl" });
  assert.equal(r.status, 200);
  assert.ok(r.json.refreshed.includes("injuries"));
  const ctxInPrompt = anthropicRequests[0].system;
  assert.match(ctxInPrompt, /Jayden Daniels/, "fresh report (with Daniels) replaced the stale one in the prompt");
});

await test("team missing from feed → 'none listed', explicitly NOT healthy", async () => {
  scenario = "commanders-missing";
  cache.flushAll();
  const r = await local("GET", `/api/dossier/nfl/${GAME_ID}`);
  const h = r.json.injuries.homeTeam;
  assert.equal(h.status, "ok");
  assert.equal(h.players.length, 0);
  assert.match(h.note, /not confirmation/i);
  assert.equal(r.json.injuries.awayTeam.players.length, 11, "Colts still shown");
});

await test("all injury sources down → both teams 'unavailable', never an empty 'healthy' list", async () => {
  scenario = "all-down";
  cache.flushAll();
  const r = await local("GET", `/api/dossier/nfl/${GAME_ID}`);
  assert.equal(r.status, 200);
  for (const t of [r.json.injuries.homeTeam, r.json.injuries.awayTeam]) {
    assert.equal(t.status, "unavailable");
    assert.match(t.note, /unavailable/i);
  }
});

await test("games route exposes oddsRetrievedAt for the Live pill", async () => {
  scenario = "normal";
  const r = await local("GET", "/api/games/nfl");
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  assert.ok(r.json.oddsRetrievedAt, "oddsRetrievedAt set");
  assert.ok(Array.isArray(r.json.games));
});

await test("web search disabled at org level → chat degrades to data tools instead of failing", async () => {
  scenario = "normal";
  cache.flushAll();
  const origFetch = globalThis.fetch;
  let first = true;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.anthropic.com") && first) {
      first = false;
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "web_search tool is not enabled for this organization" } }), { status: 400 });
    }
    return origFetch(url, opts);
  };
  anthropicRequests.length = 0;
  const r = await local("POST", "/api/chat", { message: "Is Jayden Daniels playing Sunday?", context: dossier, sport: "nfl" });
  globalThis.fetch = origFetch;
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.webSearchAvailable, false);
  assert.ok(!anthropicRequests[0].tools.some((t) => t.name === "web_search"));
});

await test("chat can use X + other AIs when configured; replies label them as unverified/second opinions", async () => {
  scenario = "normal";
  cache.flushAll();
  Object.assign(process.env, { X_BEARER_TOKEN: "xb", PERPLEXITY_API_KEY: "pk" });
  const origFetch = globalThis.fetch;
  const reqs = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("api.x.com")) {
      return new Response(JSON.stringify({
        data: [{ id: "9", text: "Daniels limited again today", author_id: "a", created_at: new Date().toISOString() }],
        includes: { users: [{ id: "a", username: "CmdrsBeat", name: "Beat" }] },
      }), { status: 200 });
    }
    if (u.includes("api.perplexity.ai")) {
      return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "Questionable, trending toward playing." }] }] }), { status: 200 });
    }
    if (u.includes("api.anthropic.com")) {
      const body = JSON.parse(opts.body);
      reqs.push(body);
      if (reqs.length === 1) {
        return new Response(JSON.stringify({ stop_reason: "tool_use", content: [
          { type: "tool_use", id: "s1", name: "search_social_posts", input: { query: "Jayden Daniels practice" } },
          { type: "tool_use", id: "s2", name: "ask_other_ais", input: { question: "Is Jayden Daniels playing vs Colts?" } },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "Questionable (elbow) per ESPN; per @CmdrsBeat on X he was limited again today (unverified)." }] }), { status: 200 });
    }
    return origFetch(url, opts);
  };
  const r = await local("POST", "/api/chat", { message: "Is Jayden Daniels playing Sunday?", context: dossier, sport: "nfl" });
  globalThis.fetch = origFetch;
  delete process.env.X_BEARER_TOKEN;
  delete process.env.PERPLEXITY_API_KEY;
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const names = reqs[0].tools.map((t) => t.name);
  assert.ok(names.includes("search_social_posts") && names.includes("ask_other_ais"), names.join(","));
  assert.match(reqs[0].system, /UNVERIFIED/);
  assert.match(reqs[0].system, /personal lives/);
  const results = reqs[1].messages[2].content.map((c) => JSON.parse(c.content));
  assert.equal(results[0].posts[0].author, "@CmdrsBeat");
  assert.equal(results[1].opinions[0].status, "ok");
  const social = r.json.sources.find((s) => s.kind === "social");
  assert.equal(social.url, "https://x.com/CmdrsBeat/status/9");
  assert.equal(social.cited, true);
  assert.ok(r.json.sources.some((s) => s.kind === "ai" && s.label === "Perplexity"));
});

await test("no external keys → social/AI tools are not offered", async () => {
  anthropicRequests.length = 0;
  cache.flushAll();
  const r = await local("POST", "/api/chat", { message: "What's the total?", context: dossier, sport: "nfl" });
  assert.equal(r.status, 200);
  const names = anthropicRequests[0].tools.map((t) => t.name);
  assert.ok(!names.includes("search_social_posts") && !names.includes("ask_other_ais"));
});

server.close();
console.log(failures ? `\n${failures} test(s) failed` : "\nAll tests passed");
process.exit(failures ? 1 : 0);
