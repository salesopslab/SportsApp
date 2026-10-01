// MLB starter W-L / ERA: parsing MLB Stats API rows and matching starters.
import assert from "node:assert/strict";
const m = await import("../src/services/statsService.js");

const sample = { stats: [{ splits: [
  { player: { id: 554430, fullName: "Zack Wheeler" }, team: { name: "Philadelphia Phillies" }, stat: { wins: 14, losses: 5, era: "3.00" } },
  { player: { id: 669373, fullName: "Tarik Skubal" }, team: { name: "Los Angeles Dodgers" }, stat: { wins: 12, losses: 7, era: "2.72" } },
  { player: { id: 1, fullName: "José Rodríguez" }, team: { name: "Chicago White Sox" }, stat: { wins: 2, losses: 1, era: "3.50" } },
  { player: { id: 805074, fullName: "Yunior Marte" }, team: { name: "San Francisco Giants" }, stat: { wins: 0, losses: 2, era: "4.44" } },
  { player: { id: 628708, fullName: "Yunior Marte" }, team: { name: "Cincinnati Reds" }, stat: { wins: 0, losses: 0, era: "108.00" } },
  { player: { id: 2, fullName: "No Era Yet" }, team: { name: "Seattle Mariners" }, stat: { wins: 0, losses: 0, era: "-.--" } },
] }] };

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); } catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}
const map = m.parseMlbPitchingStats(sample, 2026);

test("W-L and ERA for a starter", () => {
  assert.deepEqual(m.lookupPitcherStats(map, "Zack Wheeler", "PHI"), { wins: 14, losses: 5, era: "3.00", season: "2026", source: "MLB Stats API" });
});
test("accents and punctuation don't matter", () => {
  assert.equal(m.lookupPitcherStats(map, "Jose Rodriguez", "CHW")?.era, "3.50");
});
test("two pitchers with the same name: team decides", () => {
  assert.equal(m.lookupPitcherStats(map, "Yunior Marte", "SF")?.era, "4.44");
  assert.equal(m.lookupPitcherStats(map, "Yunior Marte", "CIN")?.era, "108.00");
});
test("same name and no team match: show nothing rather than guess", () => {
  assert.equal(m.lookupPitcherStats(map, "Yunior Marte", "NYY"), null);
});
test("unknown pitcher -> null; missing ERA -> record only", () => {
  assert.equal(m.lookupPitcherStats(map, "Nobody Here", "NYY"), null);
  assert.deepEqual(m.lookupPitcherStats(map, "No Era Yet", "SEA"), { wins: 0, losses: 0, era: null, season: "2026", source: "MLB Stats API" });
});

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll pitcher tests passed");
