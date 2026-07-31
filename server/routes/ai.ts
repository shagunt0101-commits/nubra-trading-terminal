import { Router } from "express";
import { generateTradingSignals } from "../gemini.js";
import { validate, aiAnalyzeSchema } from "../validation.js";

const router = Router();

router.post("/analyze", validate(aiAnalyzeSchema), async (req, res) => {
  const { symbol, strategy, priceData, optionChain, technicalIndicators, positions, funds, aiProvider, customApiKey, customBaseUrl, customModel } = req.body;

  try {
    const markdownReport = await generateTradingSignals({ symbol, priceData, optionChain, technicalIndicators, strategy, positions, funds, aiProvider, customApiKey, customBaseUrl, customModel });
    res.json({ success: true, report: markdownReport });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
