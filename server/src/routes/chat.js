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
        max_tokens: 600,
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
