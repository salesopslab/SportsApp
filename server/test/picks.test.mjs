// Picks ledger math: units, implied/no-vig probability, CLV, leaderboard, CSV.
import assert from "node:assert/strict";
import { impliedProb, unitsFor, noVig, clvPoints, buildLeaderboard, betSide, pickersDisagree, toCsv, seasonStart, validOdds } from "../src/services/picksService.js";
const t = (name, fn) => { fn(); console.log("PASS ", name); };

t("units on a flat 1-unit stake", () => {
  assert.equal(unitsFor("win", -110), 0.91);
  assert.equal(unitsFor("win", 150), 1.5);
  assert.equal(unitsFor("win", -200), 0.5);
  assert.equal(unitsFor("loss", -110), -1);
  assert.equal(unitsFor("push", 120), 0);
  assert.equal(unitsFor("void", -110), 0);
  assert.equal(unitsFor("pending", -110), null);
});
t("implied probability and odds validation", () => {
  assert.equal(impliedProb(-110).toFixed(4), "0.5238");
  assert.equal(impliedProb(150), 0.4);
  assert.equal(impliedProb(100), 0.5);
  assert.ok(validOdds(-110) && validOdds(150) && !validOdds(50) && !validOdds(-110.5) && !validOdds("x"));
});
t("no-vig fair probability on a 2-way market", () => {
  const f = noVig(-110, -110);
  assert.equal(f.a, 0.5); assert.equal(f.b, 0.5);
  assert.equal(f.hold.toFixed(4), "0.0476");
  const g = noVig(-150, 130);
  assert.equal((g.a + g.b).toFixed(6), "1.000000");
});
t("closing-line value: beat the close is positive", () => {
  assert.ok(clvPoints(-110, -125) > 0);
  assert.ok(clvPoints(-110, -105) < 0);
});
t("leaderboard: record, units, ROI, streak, CLV, small sample, all pickers present", () => {
  const k = (d) => new Date(Date.UTC(2026, 9, d)).toISOString();
  const rows = [
    { id: 1, picker: "Lone Wolf", sport: "nfl", kickoff_at: k(1), odds: -110, implied_prob: 0.5238, confidence: "High", result: "win", units: 0.91, closing_odds: -125 },
    { id: 2, picker: "Lone Wolf", sport: "nfl", kickoff_at: k(2), odds: 150, implied_prob: 0.4, confidence: "Low", result: "win", units: 1.5 },
    { id: 3, picker: "Lone Wolf", sport: "nfl", kickoff_at: k(3), odds: -110, implied_prob: 0.5238, confidence: "Low", result: "push", units: 0 },
    { id: 4, picker: "Lone Wolf", sport: "nfl", kickoff_at: k(4), odds: -110, implied_prob: 0.5238, confidence: "Low", result: "pending", units: null },
    { id: 5, picker: "The Professor", sport: "nfl", kickoff_at: k(1), odds: -110, implied_prob: 0.5238, confidence: "Medium", result: "loss", units: -1 },
    { id: 6, picker: "The Professor", sport: "nfl", kickoff_at: k(2), odds: -110, implied_prob: 0.5238, confidence: "Medium", result: "void", units: 0 },
  ];
  const lb = buildLeaderboard(rows);
  assert.equal(lb.length, 3);
  const lm = lb[0];
  assert.equal(lm.picker, "Lone Wolf");
  assert.deepEqual([lm.wins, lm.losses, lm.pushes, lm.pending, lm.graded, lm.picks], [2, 0, 1, 1, 3, 4]);
  assert.equal(lm.units, 2.41);
  assert.equal(lm.roi, 80.3); // 2.41 / 3 graded
  assert.equal(lm.winPct, 100);
  assert.equal(lm.streak, "W2"); // push skipped
  assert.equal(lm.byConfidence.Low.units, 1.5);
  assert.equal(lm.clv.picks, 1);
  assert.equal(lm.smallSample, true);
  assert.deepEqual(lm.series.map((p) => p.units), [0.91, 2.41, 2.41]);
  const ms = lb.find((p) => p.picker === "The Professor");
  assert.deepEqual([ms.wins, ms.losses, ms.void, ms.graded, ms.units, ms.streak], [0, 1, 1, 1, -1, "L1"]);
  assert.equal(lb[2].picks, 0); // Value Contrarian with no picks still listed, last
});
t("pickers disagreeing on a game is detected", () => {
  const H = "Kansas City Chiefs", A = "Denver Broncos";
  assert.deepEqual(betSide("Denver Broncos +3", H, A), { market: "side", side: "away" });
  assert.deepEqual(betSide("Under 42.5", H, A), { market: "total", side: "under" });
  assert.equal(pickersDisagree([{ bet: "Denver Broncos +3" }, { bet: "Chiefs -3" }], H, A), true);
  assert.equal(pickersDisagree([{ bet: "Denver Broncos +3" }, { bet: "Broncos ML" }, { bet: "Under 42.5" }], H, A), false);
});
t("CSV quoting", () => {
  const csv = toCsv([{ id: 1, game: "A @ B", reason: 'He said "go", then left', bet: "Under 42.5", units: -1 }]);
  assert.match(csv, /"He said ""go"", then left"/);
  assert.equal(csv.split("\n")[0].split(",")[0], "id");
});
t("season start per sport", () => {
  const now = new Date(Date.UTC(2026, 9, 3));
  assert.equal(seasonStart("nfl", now).toISOString().slice(0, 10), "2026-08-01");
  assert.equal(seasonStart("nba", now).toISOString().slice(0, 10), "2026-10-01");
  assert.equal(seasonStart("ncaab", now).toISOString().slice(0, 10), "2025-11-01");
  assert.equal(seasonStart("mlb", now).toISOString().slice(0, 10), "2026-03-01");
});
const { cleanPick } = await import("../src/services/ledgerService.js");
t("old picker names are still accepted and mapped to the new ones", () => {
  const base = { sport: "nfl", game: "A @ B", kickoff_at: new Date(Date.now() + 3600e3).toISOString(), bet: "A +3", odds: -110, confidence: "Low", reason: "x" };
  assert.equal(cleanPick({ ...base, picker: "Line Movement Picker" }).value.picker, "Lone Wolf");
  assert.equal(cleanPick({ ...base, picker: "The Professor" }).value.picker, "The Professor");
  assert.match(cleanPick({ ...base, picker: "Random Guy" }).error, /picker must be one of: Lone Wolf, The Professor, The Fader/);
});
console.log("All picks tests passed");
