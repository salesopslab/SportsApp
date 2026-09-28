import "dotenv/config";
import express from "express";
import cors from "cors";
import gamesRouter from "./routes/games.js";
import dossierRouter from "./routes/dossier.js";
import chatRouter from "./routes/chat.js";
import lineHistoryRouter from "./routes/lineHistory.js";
import moversRouter from "./routes/movers.js";
import authRouter from "./routes/auth.js";
import betsRouter from "./routes/bets.js";
import adminRouter from "./routes/admin.js";
import billingRouter, { handleStripeWebhook } from "./routes/billing.js";

const app = express();
// Render puts the app behind a reverse proxy, so without this every request
// looks like it comes from that proxy's own IP — req.ip would be identical
// for every visitor. This makes Express read the real client IP from the
// X-Forwarded-For header the proxy sets, which the referral program's
// same-IP self-referral check (referralService.js) depends on being correct.
app.set("trust proxy", true);
app.use(cors());

// The Stripe webhook needs the RAW request body to verify its signature, so
// it's registered here — before the app-wide express.json() below — with its
// own express.raw() body parser. Every other route gets JSON as normal.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), handleStripeWebhook);

// Raised from Express's 100kb default so a base64-encoded bet-slip
// screenshot (Ledger AI's scan-to-import feature) fits in a single JSON
// body; everything else on the app sends far smaller payloads.
app.use(express.json({ limit: "15mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/games", gamesRouter);
app.use("/api/dossier", dossierRouter);
app.use("/api/chat", chatRouter);
app.use("/api/line-history", lineHistoryRouter);
app.use("/api/movers", moversRouter);
app.use("/api/auth", authRouter);
app.use("/api/bets", betsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/billing", billingRouter);

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`BetEdge AI backend running on :${port}`);
});
