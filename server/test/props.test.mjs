// Props Edge: DraftKings prop normalization + edge math, credit budget,
// caching, slate filtering, and the AI picks route (mocked provider + model).
// Usage: node test/props.test.mjs
import assert from "node:assert/strict";
import express from "express";

process.env.DATABASE_URL = "";
process.env.ODDS_API_BASE = "https://odds.test/v4";
process.env.ODDS_API_KEY = "test";
process.env.PROPS_DAILY_CREDIT_CAP = "12";
process.env.PROPS_MIN_REMAINING = "1000";
process.env.WEB_SEARCH_ENABLED = "false";

const svc = await import("../src/services/propsService.js");
const routeMod = await import("../src/routes/props.js");
const { signToken } = await import("../src/services/authService.js");

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.stack}`); }
};

// ---- Fixtures --------------------------------------------------------------
const now = Date.now();
const inHours = (h) => new Date(now + h * 3.6e6).toISOString();
const GAME = { id: "evt1", sport_key: "basketball_nba", commence_time: inHours(3), home_team: "Los Angeles Lakers", away_team: "Boston Celtics" };
const ou = (player, point, over, under) => [
  { name: "Over", description: player, price: over, point },
  { name: "Under", description: player, price: under, point },
];
const book = (key, title, markets) => ({ key, title, last_update: new Date().toISOString(), markets });
const PROPS_RAW = {
  ...GAME,
  bookmakers: [
    book("draftkings", "DraftKings", [
      { key: "player_points", outcomes: [...ou("LeBron James", 24.5, 110, -140), ...ou("Jayson Tatum", 27.5, -110, -110)] },
      { key: "player_rebounds", outcomes: ou("Anthony Davis", 11.5, -115, -105) },
    ]),
    book("fanduel", "FanDuel", [
      { key: "player_points", outcomes: [...ou("LeBron James", 24.5, -120, -110), ...ou("Jayson Tatum", 27.5, -110, -110)] },
      { key: "player_rebounds", outcomes: ou("Anthony Davis", 12.5, -110, -110) },
    ]),
    book("betmgm", "BetMGM", [
      { key: "player_points", outcomes: [...ou("LeBron James", 24.5, -125, -105), ...ou("Jayson Tatum", 28.5, -110, -110)] },
    ]),
  ],
};

let propsCalls = 0;
let remainingHeader = 5000;
const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
const providerFetch = async (url) => {
  const u = String(url);
  if (u.includes("/events/")) {
    propsCalls++;
    assert.ok(u.includes("bookmakers=draftkings"), "draftkings requested");
    assert.ok(!u.includes("regions="), "bookmakers param replaces regions");
    return { ok: true, status: 200, headers: headers({ "x-requests-remaining": String(remainingHeader), "x-requests-last": "5" }), json: async () => PROPS_RAW };
  }
  if (u.includes("/odds")) {
    return { ok: true, status: 200, headers: headers({}), json: async () => [
      { ...GAME, bookmakers: [] },
      { id: "evt2", sport_key: "basketball_nba", commence_time: inHours(30), home_team: "Miami Heat", away_team: "New York Knicks", bookmakers: [] },
      { id: "evt3", sport_key: "basketball_nba", commence_time: inHours(-1), home_team: "Denver Nuggets", away_team: "Utah Jazz", bookmakers: [] },
    ] };
  }
  if (u.includes("espn") || u.includes("sportsdata")) return { ok: false, status: 503, headers: headers({}), text: async () => "down", json: async () => ({}) };
  throw new Error(`unexpected fetch ${u}`);
};
const realFetch = globalThis.fetch;
globalThis.fetch = providerFetch;
svc.__setFetch(providerFetch);

// ---- Math -------------------------------------------------------------------
await test("EV math: fair 50% at +110 = +5%, at -110 = -4.5%", () => {
  assert.equal(svc.expectedValue(0.5, 110), 5);
  assert.equal(svc.expectedValue(0.5, -110), -4.5);
});

await test("normalize: DraftKings-only players, no-vig fair from same-line books, best side", () => {
  const d = svc.normalizeProps(PROPS_RAW, "nba");
  assert.equal(d.hasDraftKings, true);
  assert.equal(d.props.length, 3);
  const lebron = d.props.find((p) => p.player === "LeBron James");
  // FanDuel -120/-110 and BetMGM -125/-105 at 24.5 -> fair Over ~51.5%; DK pays +110
  assert.equal(lebron.fairBooks, 2);
  assert.ok(lebron.fair.over > 51 && lebron.fair.over < 52, `fair over ${lebron.fair.over}`);
  assert.equal(lebron.best.side, "Over");
  assert.ok(lebron.ev.over > 7, `ev over ${lebron.ev.over}`);
  assert.equal(d.props[0].player, "LeBron James", "sorted by best EV");
  // Tatum: only FanDuel posts 27.5 (BetMGM is 28.5) -> 1 fair book; median line 28
  const tatum = d.props.find((p) => p.player === "Jayson Tatum");
  assert.equal(tatum.fairBooks, 1);
  assert.equal(tatum.consensusLine, 28);
  assert.equal(tatum.lineGap, 0.5);
  // Davis: other book uses a different line -> no fair price, but line gap +1
  const ad = d.props.find((p) => p.player === "Anthony Davis");
  assert.equal(ad.fair, null);
  assert.equal(ad.lineGap, 1);
});

await test("normalize: Anytime TD compares DraftKings' price to other books", () => {
  const raw = { id: "x", bookmakers: [
    book("draftkings", "DraftKings", [{ key: "player_anytime_td", outcomes: [{ name: "Yes", description: "Josh Allen", price: 150 }] }]),
    book("fanduel", "FanDuel", [{ key: "player_anytime_td", outcomes: [{ name: "Yes", description: "Josh Allen", price: 120 }] }]),
  ] };
  const d = svc.normalizeProps(raw, "nfl");
  assert.equal(d.props[0].kind, "yes");
  assert.equal(d.props[0].yes, 150);
  assert.ok(d.props[0].priceGap > 0, "DK pays more than market");
});

await test("cache TTL tightens as tipoff nears", () => {
  assert.equal(svc.freshForSeconds(inHours(10), now), 4 * 3600);
  assert.equal(svc.freshForSeconds(inHours(4), now), 2 * 3600);
  assert.equal(svc.freshForSeconds(inHours(1), now), 3600);
});

// ---- Fetch, cache, budget ------------------------------------------------------
await test("first view pulls props; second view is served from cache (no credits)", async () => {
  svc.__reset(); propsCalls = 0;
  const a = await svc.getGameProps("nba", "evt1", { commenceTime: GAME.commence_time });
  assert.equal(a.fromCache, false);
  assert.equal(a.data.props.length, 3);
  const b = await svc.getGameProps("nba", "evt1", { commenceTime: GAME.commence_time });
  assert.equal(b.fromCache, true);
  assert.equal(propsCalls, 1);
  assert.equal((await svc.budgetStatus()).spentToday, 5);
});

await test("concurrent first views share one provider call", async () => {
  svc.__reset(); propsCalls = 0;
  await Promise.all([1, 2, 3].map(() => svc.getGameProps("nba", "evt1", { commenceTime: GAME.commence_time })));
  assert.equal(propsCalls, 1);
});

await test("daily credit cap pauses new pulls (cap 12, each pull 5)", async () => {
  svc.__reset(); propsCalls = 0;
  await svc.getGameProps("nba", "a1", { commenceTime: inHours(3) });
  await svc.getGameProps("nba", "a2", { commenceTime: inHours(3) });
  const c = await svc.getGameProps("nba", "a3", { commenceTime: inHours(3) });
  assert.equal(propsCalls, 2);
  assert.equal(c.paused, true);
  assert.match(c.pausedReason, /budget/);
});

await test("low account credits pause props to protect the Games board", async () => {
  svc.__reset(); propsCalls = 0; remainingHeader = 1002;
  await svc.getGameProps("nba", "b1", { commenceTime: inHours(3) });
  const c = await svc.getGameProps("nba", "b2", { commenceTime: inHours(3) });
  assert.equal(propsCalls, 1);
  assert.equal(c.paused, true);
  assert.match(c.pausedReason, /running low/);
  remainingHeader = 5000;
});

await test("a started game with no pregame pull spends nothing", async () => {
  svc.__reset(); propsCalls = 0;
  const r = await svc.getGameProps("nba", "evt3", { commenceTime: inHours(-1) });
  assert.equal(propsCalls, 0);
  assert.equal(r.data, null);
  assert.match(r.pausedReason, /started/);
});

await test("slate: only the user's local today, sorted, flags started games", async () => {
  svc.__reset();
  const s = await svc.getSlate("nba", { day: "today", tz: "UTC", now });
  const ids = s.games.map((g) => g.id);
  // evt1 (+3h) is today unless that crosses midnight UTC; evt2 (+30h) never is.
  assert.ok(!ids.includes("evt2"));
  for (const g of s.games) assert.equal(g.started, Date.parse(g.commenceTime) <= now);
});

await test("unsupported sport is rejected", async () => {
  await assert.rejects(() => svc.getSlate("mlb"), /aren't available/);
});

// ---- AI picks -----------------------------------------------------------------
await test("attachPickData keeps only real DraftKings props and uses our numbers", () => {
  const d = svc.normalizeProps(PROPS_RAW, "nba");
  const picks = routeMod.attachPickData([
    { player: "lebron james", market: "player_points", side: "over", confidence: "Strong", reason: "r", risk: "k" },
    { player: "Made Up Guy", market: "player_points", side: "Over" },
    { player: "Jayson Tatum", market: "player_points", side: "Sideways" },
    { player: "LeBron James", market: "player_points", side: "Over" },
    { player: "Anthony Davis", market: "player_rebounds", side: "Under", confidence: "Huge" },
  ], d.props);
  assert.equal(picks.length, 2);
  assert.equal(picks[0].player, "LeBron James");
  assert.equal(picks[0].price, 110);
  assert.equal(picks[0].line, 24.5);
  assert.equal(picks[0].confidence, "Strong");
  assert.equal(picks[1].confidence, "Lean");
});

await test("route: board is public; AI picks need login, are validated and cached", async () => {
  svc.__reset(); propsCalls = 0;
  let modelCalls = 0;
  routeMod.__setModelCaller(async () => {
    modelCalls++;
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ summary: "Pace-up spot.", picks: [{ player: "LeBron James", market: "player_points", side: "Over", confidence: "Solid", reason: "DK +110 vs fair -114.", risk: "Minutes." }, { player: "Nobody", market: "player_points", side: "Over" }] }) }] };
  });
  const app = express();
  app.use(express.json());
  app.use("/api/props", routeMod.default);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, opts) => (String(url).startsWith(base) ? realFetch(url, opts) : providerFetch(url, opts));
  try {
    const g = await (await realFetch(`${base}/api/props/game/nba/evt1`)).json();
    assert.equal(g.data.props.length, 3);
    const fake = await realFetch(`${base}/api/props/game/nba/not-a-game`);
    assert.equal(fake.status, 404, "unknown event ids never spend credits");
    assert.equal(propsCalls, 1);

    const anon = await realFetch(`${base}/api/props/edge/nba/evt1`, { method: "POST" });
    assert.equal(anon.status, 402);

    const auth = { Authorization: `Bearer ${signToken({ id: 1, email: "t@test.com" })}` };
    const r1 = await (await realFetch(`${base}/api/props/edge/nba/evt1`, { method: "POST", headers: auth })).json();
    assert.equal(r1.picks.length, 1);
    assert.equal(r1.picks[0].price, 110);
    assert.equal(r1.summary, "Pace-up spot.");
    const r2 = await (await realFetch(`${base}/api/props/edge/nba/evt1`, { method: "POST", headers: auth })).json();
    assert.equal(r2.fromCache, true);
    assert.equal(modelCalls, 1, "picks shared for one props pull");
  } finally {
    server.close();
    globalThis.fetch = providerFetch;
  }
});

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll props tests passed");
process.exit(0);
