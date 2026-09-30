import { Router } from "express";
import { getGlobalSentiment } from "../global.js";

const router = Router();

router.get("/sentiment", async (req, res) => {
  try {
    const data = await getGlobalSentiment();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch global sentiment data." });
  }
});

export default router;
