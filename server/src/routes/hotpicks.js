import { Router } from "express";

// Hot Picks (the paid daily bundle) was retired in Oct 2026: every AI
// picker's pick is now included with Edge Pro and during the free trial,
// and Free / Edge / Edge+ accounts get one free pick (see pickPacks.js).
// These stubs keep old app versions and bookmarked links from erroring.
// Past purchases stay in hot_pick_purchases for the admin revenue history,
// and billing.js still records a checkout that was already in flight.
const router = Router();

const RETIRED = "Hot Picks has been retired. Every AI pick is now included with Edge Pro (and free during your trial).";

router.get("/today", (_req, res) => {
  res.json({ available: false, retired: true, reason: RETIRED, picks: [] });
});

router.post("/purchase", (_req, res) => {
  res.status(410).json({ error: RETIRED, upgradeTier: "edge_pro" });
});

export default router;
