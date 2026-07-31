import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  transport: process.env.NODE_ENV === "production"
    ? undefined
    : { target: "pino/file", options: { destination: 1 } }, // stdout
  redact: ["headers.Authorization", "req.headers.authorization", "body.pin", "body.totp"],
});

export default logger;
