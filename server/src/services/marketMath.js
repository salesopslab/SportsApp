// Market math for the AI, done on the server so the model never has to do
// arithmetic: American odds -> implied probability, the market's total
// implied probability (the overround), the vig, and the no-vig ("fair")
// probability for each side.
//
//   negative odds:  |odds| / (|odds| + 100)     -150 -> 60.0%
//   positive odds:  100 / (odds + 100)          +130 -> 43.5%
//   vig = (sum of both sides) - 100%            -110/-110 -> 52.4% + 52.4% = 104.8% -> 4.8%
//   no-vig = side / sum                         -110/-110 -> 50.0% each

export function impliedProbability(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || Math.abs(p) < 100) return null;
  return p < 0 ? -p / (-p + 100) : 100 / (p + 100);
}

const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10); // 0.5238 -> 52.4

// market: [{ name, point?, price }]  ->  { sides: [...with impliedProbability, noVigProbability], overround, vig }
export function withMarketMath(market) {
  if (!Array.isArray(market) || !market.length) return market;
  const probs = market.map((s) => impliedProbability(s.price));
  const complete = market.length === 2 && probs.every((x) => x != null);
  const sum = complete ? probs[0] + probs[1] : null;
  return {
    sides: market.map((s, i) => ({
      ...s,
      impliedProbability: pct(probs[i]),
      noVigProbability: complete ? pct(probs[i] / sum) : null,
    })),
    overround: pct(sum),
    vig: complete ? pct(sum - 1) : null,
    note: "Probabilities are percentages. impliedProbability includes the vig; noVigProbability removes it (fair price).",
  };
}

// { moneyline, spread, total } -> same with market math attached.
export function linesWithMath(lines) {
  if (!lines || typeof lines !== "object") return lines;
  const out = { ...lines };
  for (const k of ["moneyline", "spread", "total"]) if (Array.isArray(lines[k])) out[k] = withMarketMath(lines[k]);
  return out;
}
