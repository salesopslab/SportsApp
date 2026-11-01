// Ledger AI: player props tracked from Props Edge (betSource "prop"), against a
// real Postgres. Usage: TEST_DATABASE_URL=postgres://... node test/propbets.test.mjs
import assert from "node:assert/strict";
import express from "express";

if (!process.env.TEST_DATABASE_URL) {
  console.log("SKIP  prop bet tests (set TEST_DATABASE_URL to a scratch Postgres database to run them)");
  process.exit(0);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_SSL = "false";
process.env.JWT_SECRET = "test-secret";
process.env.ODDS_API_BASE = "https://odds.test/v4";

const GAME_ID = "evt-prop-1";
// Scores feed says the game is final — a prop must still NOT be auto-graded.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith("http://127.0.0.1")) return nativeFetch(url, opts);
  if (String(url).includes("/scores")) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [
      { id: GAME_ID, completed: true, home_team: "Los Angeles Rams", away_team: "Los Angeles Chargers", commence_time: new Date(Date.now() - 4 * 3.6e6).toISOString(),
        scores: [{ name: "Los Angeles Rams", score: "27" }, { name: "Los Angeles Chargers", score: "20" }] },
    ] };
  }
  throw new Error(`unexpected fetch ${url}`);
};

const { pool, ensureSchema } = await import("../src/db.js");
await ensureSchema();
const { signup, signToken } = await import("../src/services/authService.js");
const betsRouter = (await import("../src/routes/bets.js")).default;

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.stack}`); } };

const email = `prop-${Date.now()}@test.com`;
const su = await signup(email, "password123!");
const user = su.user || su;
const token = su.token || signToken(user);
const app = express();
app.use(express.json());
app.use("/api/bets", betsRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/bets`;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const call = async (path, opts = {}) => {
  const res = await nativeFetch(`${base}${path}`, { headers: H, ...opts });
  return { status: res.status, body: await res.json() };
};

const baseProp = {
  betSource: "prop", sport: "nfl", gameId: GAME_ID,
  homeTeam: "Los Angeles Rams", awayTeam: "Los Angeles Chargers",
  commenceTime: new Date(Date.now() - 4 * 3.6e6).toISOString(),
  betTypeLabel: "Puka Nacua Over 85.5 Rec Yds", lineLabel: "DraftKings",
  point: 85.5, price: -115, stake: 1,
};

await test("a prop can be tracked as units (no wager)", async () => {
  const r = await call("", { method: "POST", body: JSON.stringify({ ...baseProp, wagerAmount: null }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bet.market, "player_prop");
  assert.equal(r.body.bet.bet_source, "prop");
  assert.equal(r.body.bet.side, "Puka Nacua Over 85.5 Rec Yds");
  assert.equal(r.body.bet.game_id, GAME_ID);
});

await test("a prop with a wager stores risk/win", async () => {
  const r = await call("", { method: "POST", body: JSON.stringify({ ...baseProp, wagerAmount: 115 }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Number(r.body.bet.wager_amount), 115);
});

await test("missing description or game is rejected", async () => {
  const a = await call("", { method: "POST", body: JSON.stringify({ ...baseProp, betTypeLabel: "" }) });
  assert.equal(a.status, 400);
  const b = await call("", { method: "POST", body: JSON.stringify({ ...baseProp, gameId: null }) });
  assert.equal(b.status, 400);
});

await test("finished game does not auto-grade props; they stay pending to settle by hand", async () => {
  const r = await call("");
  assert.equal(r.status, 200);
  const list = r.body.bets || r.body;
  const props = list.filter((b) => b.bet_source === "prop");
  assert.equal(props.length, 2);
  for (const b of props) assert.equal(b.result, "pending");
});

await test("a prop settles by hand", async () => {
  const list = (await call("")).body.bets;
  const bet = list.find((b) => b.bet_source === "prop" && b.wager_amount != null);
  const r = await call(`/${bet.id}/settle`, { method: "POST", body: JSON.stringify({ result: "win" }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

server.close();
await pool.query("DELETE FROM users WHERE email = $1", [email]);
await pool.end();
if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll prop bet tests passed");
process.exit(0);
