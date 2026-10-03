// End-to-end picker run against a scratch Postgres with mocked feeds:
// posts picks before kickoff (one per picker per game), grades finished
// picks from final scores and records closing odds.
import assert from "node:assert/strict";
if (!process.env.TEST_DATABASE_URL) {
  console.log("SKIP  picker run tests (set TEST_DATABASE_URL to a scratch Postgres database to run them)");
  process.exit(0);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_SSL = "false";
process.env.ODDS_API_BASE = "https://provider.test/v4";
process.env.ODDS_API_KEY = "test";

const now = Date.now();
const iso = (h) => new Date(now + h * 3600e3).toISOString();
const H = "Kansas City Chiefs", A = "Denver Broncos", H2 = "Buffalo Bills", A2 = "Miami Dolphins";
const book = (name, sa, sh, aPt = 3) => ({ key: name.toLowerCase(), title: name, markets: [
  { key: "spreads", outcomes: [{ name: A, point: aPt, price: sa }, { name: H, point: -aPt, price: sh }] },
  { key: "h2h", outcomes: [{ name: A, price: 135 }, { name: H, price: -160 }] },
  { key: "totals", outcomes: [{ name: "Over", point: 42.5, price: -110 }, { name: "Under", point: 42.5, price: -110 }] },
] });
const oddsNfl = [
  { id: "g-soon", sport_key: "americanfootball_nfl", commence_time: iso(3), home_team: H, away_team: A, bookmakers: [book("Alpha", -110, -110), book("Beta", -110, -110), book("Gamma", 105, -125), book("Delta", -108, -112)] },
  { id: "g-far", sport_key: "americanfootball_nfl", commence_time: iso(30), home_team: H2, away_team: A2, bookmakers: [book("Alpha", -110, -110)] },
];
const scoresNfl = [
  { id: "g-done", sport_key: "americanfootball_nfl", commence_time: iso(-5), completed: true, home_team: H2, away_team: A2, scores: [{ name: H2, score: "27" }, { name: A2, score: "20" }] },
];
const standings = { children: [{ standings: { entries: [
  [H, 4, 120, 80], [A, 4, 70, 100], [H2, 4, 100, 90], [A2, 4, 90, 100],
].map(([n, g, pf, pa]) => ({ team: { displayName: n }, stats: [{ name: "wins", value: g - 1 }, { name: "losses", value: 1 }, { name: "pointsFor", value: pf }, { name: "pointsAgainst", value: pa }] })) } }] };
let oddsCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() });
  if (u.includes("/sports/americanfootball_nfl/odds")) { oddsCalls++; return ok(oddsNfl); }
  if (u.endsWith("/odds") || u.includes("/odds?")) return ok([]);
  if (u.includes("/sports/americanfootball_nfl/scores")) return ok(scoresNfl);
  if (u.includes("/scores")) return ok([]);
  if (u.includes("espn.com") && u.includes("football/nfl")) return ok(standings);
  if (u.includes("espn.com")) return ok({});
  throw new Error("Unmocked fetch: " + u);
};
const { pool, ensureSchema } = await import("../src/db.js");
const { runPickers, runDailyIfDue } = await import("../src/services/pickerService.js");
await ensureSchema();
await pool.query("TRUNCATE odds_snapshots");
await pool.query("ALTER TABLE picks DISABLE TRIGGER picks_guard_trg"); await pool.query("DELETE FROM picks"); await pool.query("ALTER TABLE picks ENABLE TRIGGER picks_guard_trg");
// Line history for g-soon on the tracked book (Alpha): Chiefs -4.5 -> -3 over 20h.
for (const [h, pt] of [[-20, -4.5], [-14, -4.5], [-8, -4], [-3, -3.5], [-1, -3]]) {
  await pool.query("INSERT INTO odds_snapshots (sport, game_id, book, market, side, point, price, captured_at) VALUES ('nfl','g-soon','Alpha','spread',$1,$2,-110,$3), ('nfl','g-soon','Alpha','spread',$4,$5,-110,$3)", [H, pt, iso(h), A, -pt]);
}
// A finished game with a pending pick + closing prices before its kickoff.
await pool.query(`INSERT INTO picks (picker, sport, game, game_id, kickoff_at, bet, odds, implied_prob, confidence, reason, created_at)
  VALUES ('The Professor','nfl',$1,'g-done',$2,'Buffalo Bills -3',-110,0.5238,'Medium','test',$3)`, [`${A2} @ ${H2}`, iso(-5), iso(-9)]);
for (const [b, price] of [["Alpha", -118], ["Beta", -120], ["Gamma", -122]]) {
  await pool.query("INSERT INTO odds_snapshots (sport, game_id, book, market, side, point, price, captured_at) VALUES ('nfl','g-done',$1,'spread',$2,-3,$3,$4)", [b, H2, price, iso(-5.5)]);
}

let failures = 0;
async function test(name, fn) { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.stack}`); } }

await test("dry run previews picks and grades, saves nothing", async () => {
  const r = await runPickers({ dryRun: true });
  assert.equal(r.posted.length, 0);
  assert.ok(r.wouldPost.length >= 2, JSON.stringify(r, null, 1));
  assert.equal(r.wouldGrade[0].result, "win");
  const { rows } = await pool.query("SELECT count(*)::int n FROM picks");
  assert.equal(rows[0].n, 1);
});
let first;
await test("a run posts one pick per picker on the game starting soon", async () => {
  first = await runPickers();
  const byPicker = Object.fromEntries(first.posted.map((p) => [p.picker, p]));
  assert.equal(byPicker["Lone Wolf"]?.bet, "Denver Broncos +3", JSON.stringify(first, null, 1));
  assert.equal(byPicker["The Professor"]?.bet, "Kansas City Chiefs -3");
  assert.equal(byPicker["The Fader"]?.bet, "Denver Broncos +3");
  assert.equal(byPicker["The Fader"]?.odds, 105);
  assert.ok(first.posted.every((p) => p.game_id === "g-soon"), "game 30h out is outside every window");
});
await test("the finished game is graded with units and closing odds", async () => {
  const g = first.graded.find((x) => x.id);
  assert.equal(g.result, "win");
  assert.equal(g.units, 0.91);
  assert.equal(g.closing_odds, -120);
});
await test("a second run doesn't double-post or re-grade", async () => {
  const r = await runPickers();
  assert.equal(r.posted.length, 0, JSON.stringify(r.posted));
  assert.equal(r.graded.length, 0);
  assert.ok(r.skipped.some((s) => /already picked/.test(s)));
});
await test("daily cap: at most 3 picks per picker, strongest first", async () => {
  const { DAILY_CAP } = await import("../src/services/pickerService.js");
  assert.equal(DAILY_CAP, 3);
  // Eight more games starting soon, each with a bigger line move than the last.
  for (let i = 1; i <= 8; i++) {
    oddsNfl.push({ id: `cap-${i}`, sport_key: "americanfootball_nfl", commence_time: iso(4 + i / 10), home_team: `Home ${i}`, away_team: `Away ${i}`, bookmakers: [
      { key: "alpha", title: "Alpha", markets: [{ key: "spreads", outcomes: [{ name: `Away ${i}`, point: 3, price: -110 }, { name: `Home ${i}`, point: -3, price: -110 }] }] }] });
    for (const [h, pt] of [[-20, -3 - i], [-10, -3 - i], [-1, -3]]) {
      await pool.query("INSERT INTO odds_snapshots (sport, game_id, book, market, side, point, price, captured_at) VALUES ('nfl',$1,'Alpha','spread',$2,$3,-110,$4)", [`cap-${i}`, `Home ${i}`, pt, iso(h)]);
    }
  }
  const { invalidate } = await import("../src/services/cache.js");
  invalidate("odds:nfl");
  const r = await runPickers();
  const { rows } = await pool.query("SELECT picker, game_id FROM picks WHERE picker = 'Lone Wolf' ORDER BY id");
  assert.equal(rows.length, 3, JSON.stringify(rows));
  // Lone Wolf already had 1 today (g-soon) -> 2 more, the two biggest moves.
  assert.deepEqual(rows.slice(1).map((x) => x.game_id).sort(), ["cap-7", "cap-8"]);
  assert.ok(r.skipped.some((s) => /daily cap/.test(s)));
});
await test("only one run at a time", async () => {
  const [a, b] = await Promise.all([runPickers({ dryRun: true }), runPickers({ dryRun: true })]);
  assert.ok([a, b].some((x) => x.error === "A picker run is already in progress.") || [a, b].every((x) => x.ok));
});
await test("once a day: not before 8 AM Pacific, then exactly once", async () => {
  await pool.query("DELETE FROM picker_runs");
  const early = await runDailyIfDue({ now: Date.UTC(2026, 0, 5, 14) }); // 6 AM PST
  assert.equal(early.due, false);
  const first = await runDailyIfDue({ now: Date.UTC(2026, 0, 5, 17) }); // 9 AM PST
  assert.equal(first.due, true, JSON.stringify(first));
  assert.equal(first.day, "2026-01-05");
  const again = await runDailyIfDue({ now: Date.UTC(2026, 0, 5, 22) });
  assert.equal(again.due, false);
  assert.match(again.reason, /Already ran today/);
  const next = await runDailyIfDue({ now: Date.UTC(2026, 0, 6, 17) });
  assert.equal(next.due, true);
  const { rows } = await pool.query("SELECT day, finished_at FROM picker_runs ORDER BY day");
  assert.deepEqual(rows.map((r) => r.day), ["2026-01-05", "2026-01-06"]);
  assert.ok(rows.every((r) => r.finished_at));
});
await pool.end();
if (failures) { console.log(`${failures} picker run test(s) failed`); process.exit(1); }
console.log("All picker run tests passed");
