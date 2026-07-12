// Vercel serverless entry — re-exports the Express app
// Vercel resolves the .ts extension internally
import app from "../server";
export default app;
