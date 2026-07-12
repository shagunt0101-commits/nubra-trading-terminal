// Vercel health check — minimal, no deps
import type { VercelRequest, VercelResponse } from "@vercel/node";
export default function handler(req: VercelRequest, res: VercelResponse) {
  res.json({ ok: true, env: process.env.NODE_ENV, vercel: !!process.env.VERCEL });
}
