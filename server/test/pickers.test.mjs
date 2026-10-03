// Built-in pickers: bet parsing/grading and each strategy's rules.
import assert from "node:assert/strict";
import { parseBet, gradeBet, betText, crossedKey, lineMovementPick, statsPick, valuePick, parseStandings, findTeam, LINE, STATS, VALUE } from "../src/services/pickerService.js";
const t = (name, fn) => { fn(); console.log("PASS ", name); };
const H = "Kansas City Chiefs", A = "Denver Broncos";

t("bet text round-trips through the parser", () => {
  assert.deepEqual(parseBet(betText.spread(A, 3), H, A), { market: "spread", side: "away", team: A, point: 3 });
  assert.deepEqual(parseBet(betText.spread(H, -3.5), H, A), { market: "spread", side: "home", team: H, point: -3.5 });
  assert.equal(parseBet(betText.spread(H, 0), H, A).point, 0);
  assert.equal(parseBet(betText.moneyline(A), H, A).side, "away");
  assert.deepEqual(parseBet("Under 42.5", H, A), { market: "total", side: "Under", point: 42.5 });
  assert.equal(parseBet("Broncos +3", H, A).side, "away"); // nickname only
  assert.equal(parseBet("Somebody +3", H, A), null);
});
t("grading spreads, moneylines and totals, including pushes", () => {
  const g = (bet, h, a) => gradeBet(parseBet(bet, H, A), h, a);
  assert.equal(g("Denver Broncos +3", 24, 21), "push");
  assert.equal(g("Denver Broncos +3", 24, 22), "win");
  assert.equal(g("Denver Broncos +3", 28, 21), "loss");
  assert.equal(g("Kansas City Chiefs -3.5", 28, 24), "win");
  assert.equal(g("Kansas City Chiefs -3.5", 27, 24), "loss");
  assert.equal(g("Kansas City Chiefs PK", 20, 20), "push");
  assert.equal(g("Denver Broncos ML", 17, 20), "win");
  assert.equal(g("Over 42.5", 24, 19), "win");
  assert.equal(g("Under 42.5", 24, 19), "loss");
  assert.equal(g("Under 43", 24, 19), "push");
  assert.equal(gradeBet(null, 1, 2), null);
});
t("key numbers", () => {
  assert.equal(crossedKey("nfl", -2.5, -3.5), true);
  assert.equal(crossedKey("nfl", -3, -3.5), true);   // off the 3
  assert.equal(crossedKey("nfl", -4, -5), false);
  assert.equal(crossedKey("nba", -2.5, -3.5), false);
});

const T0 = Date.UTC(2026, 9, 4, 12);
const iso = (h) => new Date(T0 + h * 3600e3).toISOString();
const game = (over = {}) => ({
  id: "g1", homeTeam: H, awayTeam: A, commenceTime: iso(3),
  spread: [{ name: H, point: -3, price: -110 }, { name: A, point: 3, price: -110 }],
  moneyline: [{ name: H, price: -160 }, { name: A, price: 135 }],
  total: [{ name: "Over", point: 42.5, price: -110 }, { name: "Under", point: 42.5, price: -110 }],
  allBooks: [], ...over,
});
const hist = (rows) => ({ available: true, hasHistory: true, summary: rows.map((r) => ({ dataPoints: 5, firstSeen: iso(-20), lastSeen: iso(-1), ...r })) });

t("Line Movement: follows a spread move toward the side the money hit", () => {
  const p = lineMovementPick("nfl", game(), hist([{ market: "spread", side: H, openPoint: -4.5, currentPoint: -3 }]));
  assert.equal(p.picker, LINE);
  assert.equal(p.bet, "Denver Broncos +3");
  assert.equal(p.odds, -110);
  assert.equal(p.confidence, "High"); // 1.5 pts + through the 3
  assert.match(p.reason, /Chiefs -4.5 → -3/);
  assert.match(p.reason, /\(1\.5 pts, through a key number\)/);
  assert.doesNotMatch(p.reason, /consensus line now/); // tracked book matches consensus
  const differ = lineMovementPick("nfl", game({ spread: [{ name: H, point: -2.5, price: -110 }, { name: A, point: 2.5, price: -110 }] }), hist([{ market: "spread", side: H, openPoint: -4.5, currentPoint: -3 }]));
  assert.match(differ.reason, /consensus line now \+2\.5/);
  const onePt = lineMovementPick("mlb", game({ spread: [] }), hist([{ market: "total", side: "Over", openPoint: 9, currentPoint: 8 }]));
  assert.match(onePt.reason, /\(1 pt\)/);
});
t("Line Movement: total move, ML move for MLB, ignores noise and thin history", () => {
  assert.equal(lineMovementPick("nfl", game(), hist([{ market: "total", side: "Over", openPoint: 45, currentPoint: 42.5 }])).bet, "Under 42.5");
  const mlb = game({ spread: [] });
  assert.equal(lineMovementPick("mlb", mlb, hist([{ market: "moneyline", side: H, openPrice: -120, currentPrice: -160 }])).bet, "Kansas City Chiefs ML");
  assert.equal(lineMovementPick("nfl", game(), hist([{ market: "spread", side: H, openPoint: -3.5, currentPoint: -4 }])), null); // half point, no key
  assert.equal(lineMovementPick("nfl", game(), hist([{ market: "spread", side: H, openPoint: -6, currentPoint: -3, dataPoints: 2 }])), null);
  assert.equal(lineMovementPick("nfl", game(), { available: true, hasHistory: false }), null);
});
t("Matchup Stats: bets the side its power ratings like vs the spread", () => {
  const ratings = { [H.toLowerCase()]: { games: 4, pf: 120, pa: 80 }, [A.toLowerCase()]: { games: 4, pf: 70, pa: 100 } };
  // KC +10/g, DEN -7.5/g, shrink 4/8 -> 5 - (-3.75) + 1.5 = 10.25 vs market 3 -> edge 7.25 toward KC
  const p = statsPick("nfl", game(), ratings);
  assert.equal(p.picker, STATS);
  assert.equal(p.bet, "Kansas City Chiefs -3");
  assert.equal(p.confidence, "High");
  assert.match(p.reason, /Chiefs by 10\.3/);
  assert.equal(statsPick("nfl", game({ spread: [{ name: H, point: -9.5, price: -110 }, { name: A, point: 9.5, price: -110 }] }), ratings), null); // edge too small
  assert.equal(statsPick("nfl", game(), { [H.toLowerCase()]: { games: 2, pf: 60, pa: 20 }, [A.toLowerCase()]: { games: 4, pf: 70, pa: 100 } }), null); // too few games
  assert.equal(statsPick("nfl", game(), {}), null);
  assert.equal(statsPick("ncaaf", game(), ratings), null); // pro leagues only
  const lopsided = { [H.toLowerCase()]: { games: 4, pf: 200, pa: 40 }, [A.toLowerCase()]: { games: 4, pf: 40, pa: 200 } };
  assert.equal(statsPick("nfl", game(), lopsided), null); // gap too big vs market = missing info, pass
});
t("Matchup Stats: MLB uses run differential vs the no-vig moneyline", () => {
  const ratings = { [H.toLowerCase()]: { games: 150, pf: 760, pa: 680 }, [A.toLowerCase()]: { games: 150, pf: 690, pa: 720 } };
  const p = statsPick("mlb", game({ moneyline: [{ name: H, price: -120 }, { name: A, price: 100 }] }), ratings);
  assert.equal(p.bet, "Kansas City Chiefs ML");
  assert.match(p.reason, /no-vig market/);
});
t("Value Contrarian: takes a dog/under only when a book beats fair value", () => {
  const books = [
    { book: "A", spread: [{ name: H, point: -3, price: -110 }, { name: A, point: 3, price: -110 }], moneyline: [], total: [] },
    { book: "B", spread: [{ name: H, point: -3, price: -112 }, { name: A, point: 3, price: -108 }], moneyline: [], total: [] },
    { book: "BigBook", spread: [{ name: H, point: -3, price: -125 }, { name: A, point: 3, price: 105 }], moneyline: [], total: [] },
    { book: "D", spread: [{ name: H, point: -3.5, price: -105 }, { name: A, point: 3.5, price: 120 }], moneyline: [], total: [] }, // other number: ignored
  ];
  const p = valuePick("nfl", game({ allBooks: books }));
  assert.equal(p.picker, VALUE);
  assert.equal(p.bet, "Denver Broncos +3");
  assert.equal(p.odds, 105);
  assert.match(p.reason, /\+105 at BigBook/);
  const fair = [books[0], books[1], { ...books[1], book: "C" }];
  assert.equal(valuePick("nfl", game({ allBooks: fair })), null); // nothing beats fair
  assert.equal(valuePick("nfl", game({ allBooks: books.slice(0, 2) })), null); // too few books to shop
});
t("ESPN standings parsing + team lookup", () => {
  const json = { children: [{ standings: { entries: [
    { team: { displayName: "Kansas City Chiefs" }, stats: [{ name: "wins", value: 3 }, { name: "losses", value: 1 }, { name: "pointsFor", value: 110 }, { name: "pointsAgainst", value: 80 }] },
    { team: { displayName: "Denver Broncos" }, stats: [{ name: "wins", value: 1 }, { name: "losses", value: 3 }, { name: "pointsFor", value: 70 }, { name: "pointsAgainst", value: 95 }] },
  ] } }, { children: [{ standings: { entries: [{ team: { location: "Alabama", name: "Crimson Tide" }, stats: [{ name: "wins", value: 4 }, { name: "losses", value: 0 }, { name: "pointsFor", value: 160 }, { name: "pointsAgainst", value: 50 }] }] } }] }] };
  const r = parseStandings(json);
  // College-style entry: overall record only via "total", split stats prefixed.
  const cfb = parseStandings({ standings: { entries: [{ team: { displayName: "Michigan Wolverines" }, stats: [
    { name: "wins", type: "wins", value: 4 }, { name: "pointsFor", type: "pointsfor", value: 150 }, { name: "pointsAgainst", type: "pointsagainst", value: 70 },
    { name: "wins", type: "homerecord_wins", value: 3 }, { name: "pointsFor", type: "homerecord_pointsfor", value: 99 },
    { name: "overall", type: "total", displayValue: "4-1" } ] }] } });
  assert.deepEqual([cfb["michigan wolverines"].games, cfb["michigan wolverines"].pf], [5, 150]);
  assert.equal(r["kansas city chiefs"].games, 4);
  assert.equal(findTeam(r, "Alabama Crimson Tide").pf, 160);
  assert.equal(findTeam(r, "Nobody FC"), null);
});
const { inSeason } = await import("../src/services/pickerService.js");
t("season windows", () => {
  const d = (m, day) => new Date(Date.UTC(2026, m - 1, day));
  assert.equal(inSeason("nfl", d(10, 3)), true);
  assert.equal(inSeason("nfl", d(1, 20)), true);   // playoffs wrap the new year
  assert.equal(inSeason("nfl", d(6, 1)), false);
  assert.equal(inSeason("nba", d(10, 3)), false);
  assert.equal(inSeason("mlb", d(10, 3)), true);
});
console.log("All picker tests passed");
