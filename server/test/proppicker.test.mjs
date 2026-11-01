// Prop Hunter: picks DraftKings props with real edge, skips injured players,
// grades from ESPN box scores (win/loss/push, void on DNP), and runs inside
// the daily picker run. The DB part needs TEST_DATABASE_URL.
import assert from "node:assert/strict";

process.env.ODDS_API_BASE = "https://provider.test/v4";
process.env.ODDS_API_KEY = "test";
const HAS_DB = !!process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = HAS_DB ? process.env.TEST_DATABASE_URL : "";
process.env.DATABASE_SSL = "false";

const now = Date.now();
const iso = (h) => new Date(now + h * 3600e3).toISOString();
const HOME = "Los Angeles Lakers", AWAY = "Boston Celtics";
const ou = (p, pt, o, u) => [{ name: "Over", description: p, price: o, point: pt }, { name: "Under", description: p, price: u, point: pt }];
const bk = (key, title, markets) => ({ key, title, markets });
// LeBron Over 24.5 at +110 vs fair ~51.5% -> ~+8% EV. Davis Over 11.5 at +120
// vs fair ~52% -> bigger EV, but he's listed Out. Tatum: only 1 other book.
const PROPS_RAW = (id, kick) => ({ id, home_team: HOME, away_team: AWAY, commence_time: kick, bookmakers: [
  bk("draftkings", "DraftKings", [
    { key: "player_points", outcomes: [...ou("LeBron James", 24.5, 110, -140), ...ou("Jayson Tatum", 27.5, 130, -160)] },
    { key: "player_rebounds", outcomes: ou("Anthony Davis", 11.5, 120, -150) },
  ]),
  bk("fanduel", "FanDuel", [
    { key: "player_points", outcomes: [...ou("LeBron James", 24.5, -120, -110), ...ou("Jayson Tatum", 27.5, -110, -110)] },
    { key: "player_rebounds", outcomes: ou("Anthony Davis", 11.5, -115, -105) },
  ]),
  bk("betmgm", "BetMGM", [
    { key: "player_points", outcomes: ou("LeBron James", 24.5, -125, -105) },
    { key: "player_rebounds", outcomes: ou("Anthony Davis", 11.5, -110, -110) },
  ]),
] });
const INJURIES = { homeTeam: { players: [{ name: "Anthony Davis", gameDesignation: "Out" }] }, awayTeam: { players: [] } };

const scoreboard = (completed) => ({ events: [{ id: "401", status: { type: { completed, state: completed ? "post" : "in" } }, competitions: [{ competitors: [
  { homeAway: "home", team: { displayName: HOME } }, { homeAway: "away", team: { displayName: AWAY } },
] }] }] });
const NBA_KEYS = ["minutes", "points", "fieldGoalsMade-fieldGoalsAttempted", "threePointFieldGoalsMade-threePointFieldGoalsAttempted", "freeThrowsMade-freeThrowsAttempted", "rebounds", "assists"];
const summary = (lebronPts) => ({ boxscore: { players: [{ team: { displayName: HOME }, statistics: [{ keys: NBA_KEYS, athletes: [
  { athlete: { displayName: "LeBron James" }, stats: ["36", String(lebronPts), "10-20", "3-7", "4-5", "8", "9"] },
  { athlete: { displayName: "Anthony Davis" }, didNotPlay: true, reason: "Ankle", stats: [] },
] }] }] } });
const NFL_SUMMARY = { boxscore: { players: [{ team: { displayName: "Dallas Cowboys" }, statistics: [
  { name: "passing", keys: ["completions/passingAttempts", "passingYards", "yardsPerPassAttempt", "passingTouchdowns"], athletes: [{ athlete: { displayName: "Dak Prescott" }, stats: ["22/31", "1,012", "8.1", "2"] }] },
  { name: "rushing", keys: ["rushingAttempts", "rushingYards"], athletes: [{ athlete: { displayName: "Dak Prescott" }, stats: ["3", "11"] }] },
  { name: "receiving", keys: ["receptions", "receivingYards"], athletes: [{ athlete: { displayName: "CeeDee Lamb" }, stats: ["7", "88"] }] },
  { name: "kickReturns", keys: ["kickReturns"], athletes: [{ athlete: { displayName: "KaVontae Turpin" }, stats: ["2"] }] },
] }] } };

let espnState = { completed: true, pts: 27 };
let propsCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  if (u.includes("/events/g-nba/odds")) { propsCalls++; return ok(PROPS_RAW("g-nba", iso(3))); }
  if (u.includes("/sports/basketball_nba/odds")) return ok([{ id: "g-nba", sport_key: "basketball_nba", commence_time: iso(3), home_team: HOME, away_team: AWAY, bookmakers: [] }]);
  if (u.includes("/odds")) return ok([]);
  if (u.includes("/scores")) return ok([]);
  if (u.includes("espn.com") && u.includes("/scoreboard")) return ok(u.includes("basketball/nba") ? scoreboard(espnState.completed) : { events: [] });
  if (u.includes("espn.com") && u.includes("/summary")) return ok(summary(espnState.pts));
  if (u.includes("espn.com") && u.includes("/injuries")) return ok({ injuries: [{ displayName: HOME, injuries: [{ athlete: { displayName: "Anthony Davis" }, status: "Out" }] }] });
  if (u.includes("espn.com") || u.includes("sportsdata")) return ok({});
  throw new Error("Unmocked fetch: " + u);
};

const pp = await import("../src/services/propPickerService.js");
const { normalizeProps } = await import("../src/services/propsService.js");

let failures = 0;
async function test(name, fn) { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.stack}`); } }

const props = normalizeProps(PROPS_RAW("g-nba", iso(3)), "nba");

await test("picks the best-EV prop, skipping a player listed Out and thin markets", () => {
  const c = pp.propPick("nba", { id: "g-nba" }, props, INJURIES);
  assert.ok(c, "a pick");
  assert.equal(c.picker, "Prop Hunter");
  assert.equal(c.bet, "LeBron James Over 24.5 Points");
  assert.equal(c.odds, 110);
  assert.deepEqual(c.prop, { player: "LeBron James", market: "player_points", marketLabel: "Points", side: "Over", line: 24.5, book: "DraftKings" });
  assert.match(c.reason, /DraftKings has Over 24\.5 at \+110/);
  assert.match(c.reason, /2 other books/);
  assert.ok(["Low", "Medium", "High"].includes(c.confidence));
});

await test("without the injury, the bigger edge (Davis) wins", () => {
  const c = pp.propPick("nba", { id: "g-nba" }, props, null);
  assert.equal(c.prop.player, "Anthony Davis");
});

await test("no pick when nothing clears the edge bar", () => {
  const flat = normalizeProps({ id: "x", bookmakers: [
    bk("draftkings", "DraftKings", [{ key: "player_points", outcomes: ou("A B", 20.5, -110, -110) }]),
    bk("fanduel", "FanDuel", [{ key: "player_points", outcomes: ou("A B", 20.5, -110, -110) }]),
    bk("betmgm", "BetMGM", [{ key: "player_points", outcomes: ou("A B", 20.5, -110, -110) }]),
  ] }, "nba");
  assert.equal(pp.propPick("nba", {}, flat, null), null);
});

await test("grading: over/under/push", () => {
  const prop = { side: "Over", line: 24.5 };
  assert.equal(pp.gradeProp(prop, 27), "win");
  assert.equal(pp.gradeProp(prop, 20), "loss");
  assert.equal(pp.gradeProp({ side: "Under", line: 24.5 }, 20), "win");
  assert.equal(pp.gradeProp({ side: "Over", line: 25 }, 25), "push");
});

await test("NBA box score: points, threes (made of made-attempted), PRA, DNP", () => {
  const s = summary(27);
  assert.deepEqual(pp.statFromBox("nba", "player_points", "LeBron James", s), { status: "ok", value: 27 });
  assert.deepEqual(pp.statFromBox("nba", "player_threes", "LeBron James", s), { status: "ok", value: 3 });
  assert.deepEqual(pp.statFromBox("nba", "player_points_rebounds_assists", "LeBron James", s), { status: "ok", value: 44 });
  assert.deepEqual(pp.statFromBox("nba", "player_points", "Anthony Davis", s), { status: "dnp" });
  assert.deepEqual(pp.statFromBox("nba", "player_points", "Nobody Here", s), { status: "missing" });
});

await test("NFL box score: yards with commas, 0 when he played but had none, missing when absent", () => {
  assert.deepEqual(pp.statFromBox("nfl", "player_pass_yds", "Dak Prescott", NFL_SUMMARY), { status: "ok", value: 1012 });
  assert.deepEqual(pp.statFromBox("nfl", "player_rush_yds", "Dak Prescott", NFL_SUMMARY), { status: "ok", value: 11 });
  assert.deepEqual(pp.statFromBox("nfl", "player_receptions", "CeeDee Lamb", NFL_SUMMARY), { status: "ok", value: 7 });
  assert.deepEqual(pp.statFromBox("nfl", "player_receptions", "KaVontae Turpin", NFL_SUMMARY), { status: "ok", value: 0 });
  assert.deepEqual(pp.statFromBox("nfl", "player_reception_yds", "Ghost Player", NFL_SUMMARY), { status: "missing" });
});

await test("finds the ESPN game by teams and date", async () => {
  const ev = await pp.findEspnEvent("nba", HOME, AWAY, iso(-4));
  assert.equal(ev.id, "401");
  assert.equal(ev.completed, true);
});

await test("closing odds come from a later pregame pull at the same line", () => {
  const pick = { created_at: iso(-6), kickoff_at: iso(-1), prop: { player: "LeBron James", market: "player_points", side: "Over", line: 24.5 } };
  assert.equal(pp.propClosingOdds(pick, { fetchedAt: iso(-2), data: props }), 110);
  assert.equal(pp.propClosingOdds(pick, { fetchedAt: iso(-7), data: props }), null, "pull older than the pick");
  assert.equal(pp.propClosingOdds({ ...pick, prop: { ...pick.prop, line: 25.5 } }, { fetchedAt: iso(-2), data: props }), null, "line moved");
});

if (HAS_DB) {
  const { pool, ensureSchema } = await import("../src/db.js");
  const { runPickers } = await import("../src/services/pickerService.js");
  await ensureSchema();
  const wipe = async () => {
    await pool.query("ALTER TABLE picks DISABLE TRIGGER picks_guard_trg");
    await pool.query("DELETE FROM picks");
    await pool.query("ALTER TABLE picks ENABLE TRIGGER picks_guard_trg");
    await pool.query("DELETE FROM props_snapshots"); await pool.query("DELETE FROM props_credit_log");
  };
  await wipe();

  await test("daily run posts a Prop Hunter pick with its prop details", async () => {
    const r = await runPickers({ grade: false });
    const mine = r.posted.filter((p) => p.picker === "Prop Hunter");
    assert.equal(mine.length, 1, JSON.stringify(r, null, 1));
    assert.equal(mine[0].bet, "LeBron James Over 24.5 Points");
    assert.equal(mine[0].prop.side, "Over");
    assert.equal(propsCalls, 1);
    const again = await runPickers({ grade: false });
    assert.equal(again.posted.filter((p) => p.picker === "Prop Hunter").length, 0, "one pick per game");
    assert.equal(propsCalls, 1, "second run reuses the saved props pull");
  });

  await test("the prop column is immutable like the rest of a pick", async () => {
    const { rows } = await pool.query("SELECT id FROM picks WHERE picker='Prop Hunter' LIMIT 1");
    await assert.rejects(() => pool.query(`UPDATE picks SET prop = '{"player":"x"}' WHERE id = $1`, [rows[0].id]), /immutable/);
  });

  const insertPast = async (bet, prop) => {
    await pool.query(`INSERT INTO picks (picker, sport, game, game_id, kickoff_at, bet, odds, implied_prob, confidence, reason, created_at, prop)
      VALUES ('Prop Hunter','nba',$1,'g-past',$2,$3,110,0.4762,'Medium','test',$4,$5)`, [`${AWAY} @ ${HOME}`, iso(-5), bet, iso(-9), JSON.stringify(prop)]);
  };

  await test("after the game: grades from the box score; DNP is void; not-final waits", async () => {
    await wipe();
    await insertPast("LeBron James Over 24.5 Points", { player: "LeBron James", market: "player_points", marketLabel: "Points", side: "Over", line: 24.5 });
    await insertPast("Anthony Davis Over 11.5 Rebounds", { player: "Anthony Davis", market: "player_rebounds", marketLabel: "Rebounds", side: "Over", line: 11.5 });
    espnState = { completed: false, pts: 27 };
    let r = await runPickers({ post: false });
    assert.equal(r.graded.length, 0, "game not final on ESPN yet");
    espnState = { completed: true, pts: 27 };
    r = await runPickers({ post: false });
    const byBet = Object.fromEntries(r.graded.map((g) => [g.bet, g]));
    assert.equal(byBet["LeBron James Over 24.5 Points"].result, "win", JSON.stringify(r, null, 1));
    assert.equal(byBet["LeBron James Over 24.5 Points"].units, 1.1);
    assert.equal(byBet["Anthony Davis Over 11.5 Rebounds"].result, "void");
  });

  await wipe();
  await pool.end();
} else {
  console.log("SKIP  Prop Hunter database run (set TEST_DATABASE_URL)");
}

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll Prop Hunter tests passed");
process.exit(0);
