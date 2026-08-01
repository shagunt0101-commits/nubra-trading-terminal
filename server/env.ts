import logger from "./logger.js";

const REQUIRED: Record<string, string> = {
  NUBRA_PHONE: "Nubra broker phone",
  NUBRA_MPIN: "Nubra broker MPIN",
  NUBRA_TOTP_SECRET: "Nubra TOTP secret",
};

const OPTIONAL: Record<string, string> = {
  NUBRA_ENV: "Nubra env (defaults PROD)",
  NUBRA_DEVICE_ID: "Nubra device ID (defaults NQ001)",
  LOG_LEVEL: "Pino log level (defaults debug/dev, info/prod)",
  GEMINI_API_KEY: "Google Gemini API key (AI analysis)",
  CORS_ORIGIN: "CORS origin (defaults http://localhost:3000)",
};

export function validateEnv(): void {
  const missing: string[] = [];

  for (const [key, label] of Object.entries(REQUIRED)) {
    if (!process.env[key]) {
      missing.push(`${key} (${label})`);
    }
  }

  if (missing.length > 0) {
    // Do NOT exit: on Vercel serverless, exit kills the whole function — every
    // endpoint (health included) turns into FUNCTION_INVOCATION_FAILED and the
    // real cause is invisible. Log loudly; trading routes are already guarded
    // by requireAuth, and getLoginState() exposes missingEnv for diagnosis.
    logger.error({ missing }, `Missing required env vars: ${missing.join(", ")}`);
  }

  if (Object.keys(process.env).length > 0) {
    const present = Object.keys(OPTIONAL).filter((k) => process.env[k]);
    if (present.length > 0) {
      logger.debug({ vars: present }, "Optional env vars present");
    }
  }
}
