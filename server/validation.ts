import { z } from "zod";
import type { Request, Response, NextFunction } from "express";

export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false, error: "Validation failed",
        details: result.error.flatten(),
      });
    }
    req.body = result.data;
    next();
  };
}

export const sendOtpSchema = z.object({
  phone: z.string().optional(),
});

export const verifyOtpSchema = z.object({
  otp: z.string().min(1, "OTP required"),
  tempToken: z.string().min(1, "tempToken required"),
  phone: z.string().optional(),
});

export const historicalSchema = z.object({
  symbol: z.string().min(1),
  interval: z.string().optional().default("5m"),
  length: z.coerce.number().int().positive().optional().default(150),
  exchange: z.string().optional().default("NSE"),
});

export const backtestSchema = z.object({
  symbol: z.string().min(1),
  strategy: z.string().optional(),
  interval: z.string().optional().default("5m"),
  length: z.coerce.number().int().positive().optional().default(200),
  riskReward: z.coerce.number().optional().default(2),
  stopLossPercent: z.coerce.number().optional().default(1.5),
  targetPercent: z.coerce.number().optional().default(3),
  exchange: z.string().optional().default("NSE"),
  confidenceThreshold: z.coerce.number().optional().default(55),
  premiumTargetPct: z.coerce.number().optional().default(30),
  stopLossPct: z.coerce.number().optional().default(15),
  optionRsiThreshold: z.coerce.number().optional().default(40),
  optionRsiPeriod: z.coerce.number().optional().default(14),
  maxEntryPremium: z.coerce.number().optional().default(200),
  premiumTargetPoints: z.coerce.number().optional().default(4),
});

const sideEnum = z.enum(["BUY", "SELL"]);

export const orderPlaceSchema = z.object({
  isMultiLeg: z.boolean().optional().default(false),
  refId: z.coerce.number().int().optional(),
  qty: z.coerce.number().int(),
  side: sideEnum.optional().default("BUY"),
  deliveryType: z.string().optional().default("IDAY"),
  priceType: z.string().optional().default("LIMIT"),
  validityType: z.string().optional().default("DAY"),
  entryPrice: z.coerce.number().optional(),
  legs: z.any().optional(),
  stratTags: z.array(z.string()).optional(),
  executionMode: z.string().optional(),
});

export const orderCancelSchema = z.object({
  orderId: z.coerce.number().int(),
});

export const scalperStartSchema = z.object({
  symbol: z.string().optional(),
  lotCount: z.coerce.number().int().positive().optional(),
  confidenceThreshold: z.coerce.number().optional(),
  premiumTargetPct: z.coerce.number().optional(),
  stopLossPct: z.coerce.number().optional(),
  strikeOffset: z.coerce.number().int().optional(),
  pollIntervalMs: z.coerce.number().int().positive().optional(),
});

export const scalperConfigSchema = z.record(z.string(), z.any());

export const scalperPresetSchema = z.object({ name: z.string().min(1).max(64) });

export const aiAnalyzeSchema = z.object({
  symbol: z.string().min(1),
  strategy: z.string().optional(),
  priceData: z.any().optional(),
  optionChain: z.any().optional(),
  technicalIndicators: z.any().optional(),
  positions: z.any().optional(),
  funds: z.any().optional(),
  aiProvider: z.string().optional(),
  customApiKey: z.string().optional(),
  customBaseUrl: z.string().optional(),
  customModel: z.string().optional(),
});
