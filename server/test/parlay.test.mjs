// Parlay combined-odds math used by the bet-slip scanner.
import assert from "node:assert/strict";
process.env.DATABASE_URL ||= "";
const m = await import("../src/routes/bets.js");
let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

test("3-leg CFB parlay from the user's slip: -300 / -140 / -165 = +267", () => {
  assert.equal(m.parlayPriceFromLegs([{ price: -300 }, { price: -140 }, { price: -165 }]), 267);
});
test("classic 2-leg -110 parlay = +264; 3-leg = +596", () => {
  assert.equal(m.parlayPriceFromLegs([{ price: -110 }, { price: -110 }]), 264);
  assert.equal(m.parlayPriceFromLegs([{ price: -110 }, { price: -110 }, { price: -110 }]), 596);
});
test("underdog legs: +150 / +200 = +650", () => {
  assert.equal(m.parlayPriceFromLegs([{ price: 150 }, { price: 200 }]), 650);
});
test("a leg without valid odds -> no calculation (never guesses)", () => {
  assert.equal(m.parlayPriceFromLegs([{ price: -140 }, { price: null }]), null);
  assert.equal(m.parlayPriceFromLegs([{ price: -140 }]), null);
});
test("odds implied by the slip's own risk/to-win: $50/134 -> +268, $60/50 -> -120", () => {
  assert.equal(m.priceFromRiskAndWin(50, 134), 268);
  assert.equal(m.priceFromRiskAndWin(60, 50), -120);
  assert.equal(m.priceFromRiskAndWin(null, 50), null);
});
if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll parlay tests passed");
process.exit(0);
