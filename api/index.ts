// Vercel serverless entry.
// MUST NOT statically import ../server.js: the esbuild bundle inlines "fs"
// (auto-scalper state file) and throws "Dynamic require of fs is not supported"
// at cold start, killing every endpoint. Dynamic import keeps fs external and
// lets the function boot.
export default async function handler(req: any, res: any) {
  try {
    const { default: app } = await import("../server.js");
    return app(req, res);
  } catch (err: any) {
    res.status(500).json({ success: false, error: `App init failed: ${err?.message}` });
  }
}
