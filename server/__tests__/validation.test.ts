import { describe, it, expect } from 'vitest';
import {
  sendOtpSchema,
  verifyOtpSchema,
  historicalSchema,
  backtestSchema,
  orderPlaceSchema,
  orderCancelSchema,
  scalperStartSchema,
  aiAnalyzeSchema,
} from '../validation.ts';

describe('sendOtpSchema', () => {
  it('accepts empty body', () => {
    const r = sendOtpSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts phone', () => {
    const r = sendOtpSchema.safeParse({ phone: '+911234567890' });
    expect(r.success).toBe(true);
  });
});

describe('verifyOtpSchema', () => {
  it('rejects missing otp', () => {
    const r = verifyOtpSchema.safeParse({ tempToken: 'abc' });
    expect(r.success).toBe(false);
  });

  it('rejects missing tempToken', () => {
    const r = verifyOtpSchema.safeParse({ otp: '123456' });
    expect(r.success).toBe(false);
  });

  it('accepts valid input', () => {
    const r = verifyOtpSchema.safeParse({ otp: '123456', tempToken: 'tok_xyz' });
    expect(r.success).toBe(true);
  });
});

describe('historicalSchema', () => {
  it('accepts minimal input and applies defaults', () => {
    const r = historicalSchema.safeParse({ symbol: 'NIFTY' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.interval).toBe('5m');
      expect(r.data.length).toBe(150);
      expect(r.data.exchange).toBe('NSE');
    }
  });

  it('rejects empty symbol', () => {
    const r = historicalSchema.safeParse({ symbol: '' });
    expect(r.success).toBe(false);
  });

  it('coerces string length to number', () => {
    const r = historicalSchema.safeParse({ symbol: 'NIFTY', length: '300' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.length).toBe(300);
  });
});

describe('backtestSchema', () => {
  it('accepts minimal input', () => {
    const r = backtestSchema.safeParse({ symbol: 'BANKNIFTY' });
    expect(r.success).toBe(true);
  });

  it('rejects empty symbol', () => {
    const r = backtestSchema.safeParse({ symbol: '' });
    expect(r.success).toBe(false);
  });

  it('coerces string number fields', () => {
    const r = backtestSchema.safeParse({
      symbol: 'NIFTY',
      length: '100',
      riskReward: '2.5',
      stopLossPercent: '1.0',
      targetPercent: '2.0',
      confidenceThreshold: '60',
      premiumTargetPct: '25',
      stopLossPct: '10',
      optionRsiThreshold: '35',
      maxEntryPremium: '150',
      premiumTargetPoints: '5',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.length).toBe(100);
      expect(r.data.riskReward).toBe(2.5);
      expect(r.data.stopLossPercent).toBe(1.0);
      expect(r.data.targetPercent).toBe(2.0);
      expect(r.data.confidenceThreshold).toBe(60);
      expect(r.data.premiumTargetPct).toBe(25);
      expect(r.data.stopLossPct).toBe(10);
      expect(r.data.optionRsiThreshold).toBe(35);
      expect(r.data.maxEntryPremium).toBe(150);
      expect(r.data.premiumTargetPoints).toBe(5);
    }
  });

  it('rejects negative length', () => {
    const r = backtestSchema.safeParse({ symbol: 'NIFTY', length: -5 });
    expect(r.success).toBe(false);
  });
});

describe('orderPlaceSchema', () => {
  it('accepts minimal input', () => {
    const r = orderPlaceSchema.safeParse({ qty: 75, entryPrice: 150 });
    expect(r.success).toBe(true);
  });

  it('rejects missing qty', () => {
    const r = orderPlaceSchema.safeParse({ entryPrice: 150 });
    expect(r.success).toBe(false);
  });

  it('coerces refId and qty strings', () => {
    const r = orderPlaceSchema.safeParse({ refId: '123', qty: '50', entryPrice: 100 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.refId).toBe(123);
      expect(r.data.qty).toBe(50);
    }
  });
});

describe('orderCancelSchema', () => {
  it('accepts valid orderId', () => {
    const r = orderCancelSchema.safeParse({ orderId: 999 });
    expect(r.success).toBe(true);
  });

  it('coerces string orderId', () => {
    const r = orderCancelSchema.safeParse({ orderId: '888' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.orderId).toBe(888);
  });

  it('rejects missing orderId', () => {
    const r = orderCancelSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

describe('scalperStartSchema', () => {
  it('accepts empty input', () => {
    const r = scalperStartSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('coerces string numbers', () => {
    const r = scalperStartSchema.safeParse({
      lotCount: '3',
      confidenceThreshold: '60',
      pollIntervalMs: '5000',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lotCount).toBe(3);
      expect(r.data.confidenceThreshold).toBe(60);
      expect(r.data.pollIntervalMs).toBe(5000);
    }
  });

  it('rejects negative lotCount', () => {
    const r = scalperStartSchema.safeParse({ lotCount: -1 });
    expect(r.success).toBe(false);
  });
});

describe('aiAnalyzeSchema', () => {
  it('accepts minimal input', () => {
    const r = aiAnalyzeSchema.safeParse({ symbol: 'NIFTY' });
    expect(r.success).toBe(true);
  });

  it('rejects empty symbol', () => {
    const r = aiAnalyzeSchema.safeParse({ symbol: '' });
    expect(r.success).toBe(false);
  });

  it('accepts optional fields', () => {
    const r = aiAnalyzeSchema.safeParse({
      symbol: 'BANKNIFTY',
      strategy: 'scalping',
      priceData: { close: [100] },
      aiProvider: 'gemini',
      customApiKey: 'key_123',
    });
    expect(r.success).toBe(true);
  });
});
