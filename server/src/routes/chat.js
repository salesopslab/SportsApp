import { Router } from "express";

const router = Router();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// POST /api/chat  { message, context }
// `context` is the dossier object from /api/dossier/:sport/:gameId — fetched by the
// frontend first and passed in here, so the model reasons over real, current data
// instead of guessing from training knowledge.
router.post("/", async (req, res) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: "message is required" });

  const systemPrompt = `You are a sports betting research assistant. You only analyze
publicly available game data — odds, weather, injuries, head-to-head history. You never
give a "pick" or tell the user what to bet; you explain what the data shows and let them
decide. Always cite which data point (odds movement, weather, injury report, history)
supports each claim. If you don't have data on something, say so rather than guessing.

The "headToHead" field lists past scheduled meetings but does NOT include final scores.
The separate "headToHeadResults" field (when present) has the real final scores and
winner for past meetings — use that field, not "headToHead", when asked who won a
past game.

The "lineMovement" field (when available) shows, per market, the earliest line/price
we've recorded for this game vs. the most recent one — real line movement over time.
If "lineMovement.available" is false or "hasHistory" is false, say plainly that you
don't have movement history for this game yet rather than guessing. This is NOT the
same thing as "sharp money" or bet%/handle% splits (the share of tickets vs. dollars
on each side) — we do not have that data. If asked where "the sharp money" or "the
public" is going, explain that you can only speak to how the line itself has moved,
not to bet/handle percentages, and don't imply otherwise.

Live game data:
${JSON.stringify(context, null, 2)}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const text = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    res.json({ reply: text });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "AI chat failed", detail: err.message });
  }
});

export default router;
