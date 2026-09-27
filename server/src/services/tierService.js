// Tier logic used everywhere access is gated: the Board itself is free and
// stays that way (anonymous visitors keep seeing odds — no reason to break
// what already works as a lead-gen funnel). Everything gated here is the
// stuff added on top: line tracking / Big Moves (Edge) and AI picks advice
// (Edge Pro). A brand-new signup gets full Edge Pro-level access during the
// trial window so they see the best of the product before choosing a plan.
export const TIER_RANK = {
  none: 0, // not logged in, or a lapsed/expired account — Board-only
  expired: 0,
  standard: 1,
  edge: 2,
  edge_pro: 3,
  trial: 3, // trial mirrors edge_pro while it's still running
};

export const TIERS = [
  { id: "standard", name: "Standard", priceCents: 1999, blurb: "Live odds board across every sport." },
  { id: "edge", name: "Edge", priceCents: 2999, blurb: "Standard, plus Big Moves alerts and full line-movement tracking." },
  { id: "edge_pro", name: "Edge Pro", priceCents: 4999, blurb: "Edge, plus AI picks advice on every matchup." },
];

export const TRIAL_DAYS = 3;

// The tier that actually governs access right now for a given user row —
// distinct from the raw `tier` column, which doesn't by itself account for a
// trial that has run out or a subscription that lapsed.
export function effectiveTier(userRow) {
  if (!userRow) return "none";
  const { tier, trial_ends_at, subscription_status } = userRow;

  if (tier === "trial") {
    if (trial_ends_at && new Date(trial_ends_at).getTime() > Date.now()) return "trial";
    return "expired";
  }

  if (["standard", "edge", "edge_pro"].includes(tier)) {
    // A subscription that isn't currently active/trialing on Stripe's side
    // (canceled, unpaid, past_due, incomplete_expired) no longer grants access.
    if (subscription_status && !["active", "trialing"].includes(subscription_status)) {
      return "expired";
    }
    return tier;
  }

  return "expired";
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
