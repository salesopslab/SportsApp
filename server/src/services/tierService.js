// Tier logic used everywhere access is gated: the Board itself is free and
// stays that way (anonymous visitors keep seeing odds — no reason to break
// what already works as a lead-gen funnel). Internal ids vs. plan names:
// standard = "Edge", edge = "Edge+", edge_pro = "Edge Pro". A brand-new signup gets full Edge Pro-level access during the
// trial window so they see the best of the product before choosing a plan.
export const TIER_RANK = {
  none: 0, // not logged in, or a lapsed/expired account — Board-only
  expired: 0,
  standard: 1,
  edge: 2,
  edge_pro: 3,
  trial: 3, // trial mirrors edge_pro while it's still running
};

// Plan ladder. Internal ids are unchanged (every gate, DB row and Stripe
// webhook already uses them); only the customer-facing names and prices
// changed in the Sept 2026 repricing:
//   standard -> "Edge"     $14.99/mo  $149/yr
//   edge     -> "Edge+"    $24.99/mo  $249/yr   (most popular)
//   edge_pro -> "Edge Pro" $39.99/mo  $399/yr
export const TIERS = [
  {
    id: "standard",
    name: "Edge",
    priceCents: 1499,
    annualPriceCents: 14900,
    tagline: "For regular sports fans and bettors.",
    blurb: "Full game analysis, AI insights, injuries, line movement and screenshot bet importing.",
    features: [
      "Full game analysis",
      "AI-powered insights",
      "Injury information",
      "Line movement",
      "Enhanced Ledger AI bet tracking",
      "Screenshot bet importing",
      "Expanded Fantasy Edge tools",
    ],
  },
  {
    id: "edge",
    name: "Edge+",
    priceCents: 2499,
    annualPriceCents: 24900,
    popular: true,
    tagline: "Everything in Edge, plus:",
    blurb: "Deeper AI analysis, full Fantasy Edge, advanced Ledger AI analytics and alerts.",
    features: [
      "More advanced AI analysis",
      "Advanced betting insights",
      "Deeper player and matchup analysis",
      "Full Fantasy Edge functionality",
      "Advanced Ledger AI analytics",
      "Performance and betting-history insights",
      "Alerts and additional personalization",
    ],
  },
  {
    id: "edge_pro",
    name: "Edge Pro",
    priceCents: 3999,
    annualPriceCents: 39900,
    tagline: "Everything in Edge+, plus:",
    blurb: "Highest AI limits, premium analysis and alerts, and first access to new features.",
    features: [
      "Highest AI usage limits",
      "Premium AI analysis",
      "Advanced trend and matchup intelligence",
      "Advanced line-movement analysis",
      "Premium alerts",
      "Maximum customization",
      "Priority access to future BetEdge AI features",
    ],
  },
];

// The Free plan (no subscription). Shown on the pricing page; not a Stripe product.
export const FREE_PLAN = {
  id: "free",
  name: "Free",
  priceCents: 0,
  tagline: "Get into the BetEdge ecosystem.",
  features: [
    "Game information",
    "Basic scores and odds",
    "Limited AI analysis",
    "Basic Ledger AI bet tracking",
    "Limited Fantasy Edge access",
  ],
};

export const TRIAL_DAYS = 7;

// Usage limits per effective tier. aiChat / fantasy are per day (Pacific
// time); scans are per calendar month. A trial gets Edge Pro's limits.
export const LIMITS = {
  none: { aiChat: 3, fantasy: 3, scans: 0 },
  expired: { aiChat: 3, fantasy: 3, scans: 0 },
  standard: { aiChat: 25, fantasy: 20, scans: 15 },
  edge: { aiChat: 75, fantasy: 100, scans: 50 },
  edge_pro: { aiChat: 200, fantasy: 250, scans: 150 },
  trial: { aiChat: 200, fantasy: 250, scans: 150 },
};

export function limitsFor(userRow) {
  return LIMITS[effectiveTier(userRow)] || LIMITS.none;
}

// The next plan up from a tier, for "upgrade for more" prompts.
export function nextTierUp(tierId) {
  const order = ["standard", "edge", "edge_pro"];
  if (["none", "expired", "free"].includes(tierId)) return "standard";
  const i = order.indexOf(tierId === "trial" ? "edge_pro" : tierId);
  return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
}

// The tier that actually governs access right now for a given user row —
// distinct from the raw `tier` column, which doesn't by itself account for a
// trial that has run out or a subscription that lapsed.
export function effectiveTier(userRow) {
  if (!userRow) return "none";
  const { tier, trial_ends_at, subscription_status, bonus_access_until } = userRow;

  // Referral bonus days (see referralService.js) grant Edge Pro-level access
  // on top of whatever the account's own tier/subscription works out to, so
  // check it first and let it override an expired/lapsed base tier too.
  const hasBonus = bonus_access_until && new Date(bonus_access_until).getTime() > Date.now();

  if (tier === "trial") {
    if (trial_ends_at && new Date(trial_ends_at).getTime() > Date.now()) return "trial";
    return hasBonus ? "edge_pro" : "expired";
  }

  if (["standard", "edge", "edge_pro"].includes(tier)) {
    // A subscription that isn't currently active/trialing on Stripe's side
    // (canceled, unpaid, past_due, incomplete_expired) no longer grants access.
    if (subscription_status && !["active", "trialing"].includes(subscription_status)) {
      return hasBonus ? "edge_pro" : "expired";
    }
    return hasBonus ? "edge_pro" : tier;
  }

  return hasBonus ? "edge_pro" : "expired";
}

export function meetsTier(userRow, minTierId) {
  return TIER_RANK[effectiveTier(userRow)] >= TIER_RANK[minTierId];
}

// How much longer (ms) is left on the row's trial, or 0 if none/expired.
export function trialMsRemaining(userRow) {
  if (!userRow || userRow.tier !== "trial" || !userRow.trial_ends_at) return 0;
  return Math.max(0, new Date(userRow.trial_ends_at).getTime() - Date.now());
}

export function tierById(id) {
  return TIERS.find((t) => t.id === id) || null;
}
