// Vercel serverless entry point
// Disable listening and dev server features for Vercel
process.env.VERCEL = "1";
process.env.NODE_ENV = "production";

// Dynamic import of the Express app — Vercel handles bundling
const { default: app } = await import("../server.js");
export default app;
