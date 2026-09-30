// Vercel health check — minimal, no deps
export default function handler(req: any, res: any) {
  res.json({ ok: true, env: process.env.NODE_ENV, vercel: !!process.env.VERCEL });
}
