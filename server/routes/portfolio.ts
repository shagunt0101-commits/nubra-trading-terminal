import { Router } from "express";
import { nubraApi, getSessionToken } from "../nubra.js";

const router = Router();

router.get("/summary", async (req, res) => {
  try {
    const token = getSessionToken();
    if (!token) return res.status(401).json({ error: "No active broker session" });

    const [funds, holdings, positions] = await Promise.all([
      nubraApi.getFunds(),
      nubraApi.getHoldings(),
      nubraApi.getPositions(),
    ]);

    res.json({ success: true, funds, holdings, positions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
