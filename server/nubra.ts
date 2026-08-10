import crypto from "crypto";
import fs from "fs";
import path from "path";
import logger from "./logger.js";
import * as md from "./market-data.js";

const NUBRA_ENV = process.env.NUBRA_ENV || "PROD";
const NUBRA_PHONE = process.env.NUBRA_PHONE || "";
const NUBRA_MPIN = process.env.NUBRA_MPIN || "";
const NUBRA_DEVICE_ID = process.env.NUBRA_DEVICE_ID || "NQ001";
const NUBRA_TOTP_SECRET = process.env.NUBRA_TOTP_SECRET || "";

export const BASE_URL = NUBRA_ENV === "PROD" ? "https://api.nubra.io" : "https://uatapi.nubra.io";

const SESSION_FILE = path.join(process.env.NUBRA_SESSION_DIR || process.cwd(), ".nubra_session");

let sessionToken = process.env.VERCEL ? "" : loadSession();
let loginError = "";
let loginStatus = sessionToken ? "LOGGED_IN" : "NOT_LOGGED_IN";

function loadSession(): string {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, "utf8").trim();
      if (raw) return raw;
    }
  } catch (_) {}
  return "";
}

function saveSession(token: string) {
  if (process.env.VERCEL) return; // no persistent disk on Vercel
  try {
    fs.writeFileSync(SESSION_FILE, token, "utf8");
  } catch (_) {}
}

export function clearSession() {
  if (process.env.VERCEL) return;
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch (_) {}
}

// 20s fetch timeout — Vercel function budget is 30s; a hung Nubra call must
// fail cleanly (400 with message) instead of burning the budget into a 500.
async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Base32 Decoding helper for TOTP
function base32Decode(base32: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = base32.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  const length = cleaned.length;
  let bits = 0;
  let value = 0;
  let index = 0;
  const buffer = Buffer.alloc(Math.floor((length * 5) / 8));

  for (let i = 0; i < length; i++) {
    const val = alphabet.indexOf(cleaned[i]);
    if (val === -1) continue;
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      buffer[index++] = (value >> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return buffer;
}

// Generates the 6-digit TOTP code standard (HMAC-SHA1 with 30s step)
export function generateTOTP(secret: string): string {
  try {
    const key = base32Decode(secret);
    const epoch = Math.round(Date.now() / 1000);
    let counter = Math.floor(epoch / 30);

    const buffer = Buffer.alloc(8);
    for (let i = 7; i >= 0; i--) {
      buffer[i] = counter & 0xff;
      counter = counter >> 8;
    }

    const hmac = crypto.createHmac("sha1", key);
    hmac.update(buffer);
    const hash = hmac.digest();

    const offset = hash[hash.length - 1] & 0xf;
    const binary =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);

    let otp = (binary % 1000000).toString();
    while (otp.length < 6) {
      otp = "0" + otp;
    }
    return otp;
  } catch (error: any) {
    logger.error({ err: error }, "Error generating TOTP");
    return "000000";
  }
}

let loginInFlight: Promise<string> | null = null;
// Cooldown after a failed login: the broker rate-limits /totp/login, so every
// subsequent request must NOT re-hammer it — wait, then allow ONE retry. The
// old sessionToken stays usable meanwhile (most 404/401 waves were this storm).
let loginCooldownUntil = 0;
export function loginRetryCooldownMs() {
  return Math.max(0, loginCooldownUntil - Date.now());
}

// Performs step-by-step automated login using TOTP and Pin
// Single-flight: concurrent first requests (App fires 4 parallel fetches at
// mount) would each trigger a duplicate TOTP login and stall the boot path.
export function nubraLogin(): Promise<string> {
  if (loginInFlight) return loginInFlight;
  loginInFlight = nubraLoginInner().finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}

async function nubraLoginInner(): Promise<string> {
  loginStatus = "PENDING";
  loginError = "";
  try {
    if (!NUBRA_PHONE || !NUBRA_MPIN || !NUBRA_TOTP_SECRET) {
      throw new Error("Missing phone, MPIN, or TOTP Secret in environment variables.");
    }

    const totpCode = generateTOTP(NUBRA_TOTP_SECRET);
    logger.info("[Nubra] TOTP generated, logging in");

    // Step 1: Login via TOTP to get auth_token
    const loginRes = await fetchWithTimeout(`${BASE_URL}/totp/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-id": NUBRA_DEVICE_ID,
      },
      body: JSON.stringify({
        phone: NUBRA_PHONE,
        totp: parseInt(totpCode, 10),
        otp: "",
      }),
    });

    if (!loginRes.ok) {
      let errText = await loginRes.text();
      try {
        const json = JSON.parse(errText);
        if (json.error) {
          errText = json.error;
        }
      } catch (_) {}
      throw new Error(`TOTP Login failed: ${errText || loginRes.statusText}`);
    }

    const loginData = await loginRes.json();
    const authToken = loginData.auth_token;
    if (!authToken) {
      throw new Error("Auth token not found in TOTP login response.");
    }

    // Step 2: Verify PIN to get session_token
    const pinRes = await fetchWithTimeout(`${BASE_URL}/verifypin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-id": NUBRA_DEVICE_ID,
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        pin: NUBRA_MPIN,
      }),
    });

    if (!pinRes.ok) {
      let errText = await pinRes.text();
      try {
        const json = JSON.parse(errText);
        if (json.error) {
          errText = json.error;
        }
      } catch (_) {}
      throw new Error(`PIN verification failed: ${errText || pinRes.statusText}`);
    }

    const pinData = await pinRes.json();
    const token = pinData.session_token;
    if (!token) {
      throw new Error("Session token not found in PIN verification response.");
    }

    sessionToken = token;
    saveSession(token);
    loginStatus = "LOGGED_IN";
    logger.info("[Nubra] Login successful");
    return sessionToken;
  } catch (err: any) {
    loginError = err.message;
    loginStatus = "FAILED";
    loginCooldownUntil = Date.now() + 60_000;
    logger.error({ err }, "[Nubra] Login error");
    return "";
  }
}

// OTP-based login flow (step 1: send OTP to phone)
export async function nubraSendOtp(phone?: string): Promise<{ success: boolean; tempToken?: string; error?: string }> {
  try {
    const p = phone || NUBRA_PHONE;
    if (!p) throw new Error("Phone number required.");

    const res = await fetchWithTimeout(`${BASE_URL}/sendphoneotp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-id": NUBRA_DEVICE_ID,
      },
      body: JSON.stringify({ phone: p, skip_totp: false }),
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error || res.statusText };

    const tempToken = res.headers.get("x-temp-token") || data.temp_token || "";
    return { success: true, tempToken };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// OTP-based login flow (step 2: verify OTP + MPIN)
export async function nubraVerifyOtp(otp: string, tempToken: string, phone?: string): Promise<{ success: boolean; token?: string; error?: string }> {
  try {
    const p = phone || NUBRA_PHONE;
    if (!p) throw new Error("Phone number required.");

    const res = await fetchWithTimeout(`${BASE_URL}/verifyphoneotp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-id": NUBRA_DEVICE_ID,
        "x-temp-token": tempToken,
      },
      body: JSON.stringify({ phone: p, otp }),
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error || res.statusText };

    const authToken = data.auth_token;
    if (!authToken) return { success: false, error: "Auth token missing from OTP verify response." };

    // Step 3: Verify PIN to get session_token (no x-temp-token here)
    const pinRes = await fetchWithTimeout(`${BASE_URL}/verifypin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-id": NUBRA_DEVICE_ID,
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ pin: NUBRA_MPIN }),
    });

    const pinData = await pinRes.json();
    if (!pinRes.ok) return { success: false, error: pinData.error || "PIN verification failed." };

    const token = pinData.session_token;
    if (!token) return { success: false, error: "Session token missing from PIN verify response." };

    sessionToken = token;
    saveSession(token);
    loginStatus = "LOGGED_IN";
    loginError = "";
    return { success: true, token };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export function getSessionToken() {
  return sessionToken;
}

export function getLoginState() {
  return {
    status: loginStatus,
    error: loginError,
    phone: NUBRA_PHONE,
    deviceId: NUBRA_DEVICE_ID,
    env: NUBRA_ENV,
    baseUrl: BASE_URL,
    missingEnv: ["NUBRA_PHONE", "NUBRA_MPIN", "NUBRA_TOTP_SECRET"].filter((k) => !process.env[k]),
  };
}

// Generic Fetch Wrapper that injects Authorization headers — auto-login via TOTP if no session
async function nubraRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
  if (!sessionToken || (loginStatus === "FAILED" && Date.now() >= loginCooldownUntil)) {
    // Auto-login with TOTP if credentials are configured. During the cooldown
    // window the old (probably still valid) token is reused — the storm was
    // making everything worse by re-hammering /totp/login every request.
    const token = await nubraLogin();
    if (!token) {
      throw new Error("Not logged in. Use OTP or TOTP login first.");
    }
  }

  const url = endpoint.startsWith("http") ? endpoint : `${BASE_URL}/${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-device-id": NUBRA_DEVICE_ID,
    ...(options.headers as any),
  };

  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  }

  let res = await fetchWithTimeout(url, { ...options, headers });

  // Handle Session Expiry (440 legacy, 401 new) — token is dead, clear it and
  // TOTP re-login. 401 may ALSO be a genuine auth error ("Unauthorized" with no
  // resendMsg); only auto-recover when the body signals session-expiry.
  if (res.status === 440 || res.status === 401) {
    const raw = await res.text().catch(() => "");
    const body = raw.toLowerCase();
    const expired = res.status === 440 || body.includes("session expired") || body.includes("session has expired") || body.includes("resendmsg");
    if (expired) {
      logger.warn(`[Nubra] Session expired (${res.status}), clearing token & re-login`);
      clearSession();
      sessionToken = "";
      // Respect the failed-login cooldown here too — an expiry right after a
      // failed relogin must not immediately retry and re-trigger the storm.
      if (Date.now() < loginCooldownUntil) {
        throw new Error(`Session expired (${res.status}). Retry in ${Math.ceil(loginRetryCooldownMs() / 1000)}s.`);
      }
      const token = await nubraLogin();
      if (!token) {
        throw new Error(`Session expired (${res.status}). Re-login failed: ${loginError}`);
      }
      headers["Authorization"] = `Bearer ${token}`;
      res = await fetchWithTimeout(url, { ...options, headers });
      if (res.ok) return res.json();
      if (res.status === 440 || res.status === 401) {
        clearSession();
        sessionToken = "";
        throw new Error("Session expired. Please login again via OTP.");
      }
    } else {
      // Genuine auth failure (not session-expiry) — surface broker message
      clearSession();
      sessionToken = "";
      throw new Error(parseErrBody(raw) || "Unauthorized: Please login again via OTP.");
    }
  }

  if (!res.ok) {
    let errMsg = `Request failed: ${res.statusText}`;
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json.error) errMsg = json.error;
        if (json.message) errMsg = json.message;
      } catch (_) {
        if (text) errMsg = text.slice(0, 300);
      }
    } catch (_) {}
    throw new Error(errMsg);
  }

  return res.json();
}

function parseErrBody(raw: string): string {
  try {
    const json = JSON.parse(raw);
    if (json.error) return json.error;
    if (json.message) return json.message;
  } catch {}
  return raw ? raw.slice(0, 300) : "";
}

// Expose Portfolio, Market and Order placement APIs
export const nubraApi = {
  getHoldings: () => nubraRequest("sentinel/portfolio/holdings"),
  getPositions: () => nubraRequest("sentinel/portfolio/positions"),
  getFunds: () => nubraRequest("sentinel/portfolio/user_funds_and_margin"),
  
  getInstruments: (date: string, exchange = "NSE") => 
    nubraRequest(`refdata/refdata/${date}?exchange=${exchange}`),
  
  getCurrentPrice: (instrument: string, exchange = "NSE") =>
    nubraRequest(`optionchains/${instrument}/price?exchange=${exchange}`),
  
  getOptionChain: (instrument: string, expiry?: string, exchange = "NSE") => {
    let query = `exchange=${exchange}`;
    if (expiry) {
      query += `&expiry=${expiry}`;
    }
    return nubraRequest(`optionchains/${instrument}?${query}`);
  },
  
  getHistoricalData: (query: any) =>
    nubraRequest("charts/timeseries", {
      method: "POST",
      body: JSON.stringify(query),
    }),
  
  getMarginRequired: (query: any) =>
    nubraRequest("sentinel/orders/funds_required", {
      method: "POST",
      body: JSON.stringify({ requestType: "NEW", ...query }),
    }),

  createOrder: (orders: any[]) =>
    nubraRequest("sentinel/orders/create", {
      method: "POST",
      body: JSON.stringify({ requestType: "NEW", orders }),
    }),

  // Sentinel v2 modify — MUST wrap in orders:[] with intent names (orderId/qty/
  // entryPrice/executionMode). Flat payloads are accepted but silently no-op —
  // verified 2026-08-11 on 334443 (price 15→25 reflected once wrapped).
  modifyOrder: (orderId: number, fields: Record<string, any> = {}) =>
    nubraRequest("sentinel/orders/modify", {
      method: "POST",
      body: JSON.stringify({ orders: [{ orderId, ...fields }] }),
    }),

  cancelOrder: (orderId: number) =>
    nubraRequest("sentinel/orders/cancel", {
      method: "POST",
      body: JSON.stringify({ requestType: "NEW", orderId }),
    }),

  getOrders: (intentOrderId?: string, stratTags?: string) => {
    let query = "";
    if (intentOrderId) query += `?intentOrderId=${intentOrderId}`;
    if (stratTags) query += (query ? "&" : "?") + `stratTags=${stratTags}`;
    return nubraRequest(`sentinel/orders${query}`);
  }
};

// Native intervals supported by Nubra
const BROKER_INTERVALS = new Set(["1s","1m","2m","3m","5m","15m","30m","1h","1d","1w","1mt"]);

// Indices must be queried with type "INDEX" — "STOCK" returns "ticker not found"
const INDEXES = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]);

function resolveAssetType(symbol: string): string {
  return INDEXES.has(symbol.toUpperCase()) ? "INDEX" : "STOCK";
}

export async function fetchCandlesInternal(symbol: string, exchange: string, interval: string, count: number): Promise<any[]> {
  const brokerInterval = BROKER_INTERVALS.has(interval) ? interval : "1m";
  const stepMins: Record<string, number> = { "1s": 1/60, "1m": 1, "2m": 2, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "1d": 1440, "1w": 10080, "1mt": 43200 };
  const step = stepMins[interval] || 5;
  const today = new Date();
  const daysBack = md.daysBackFor(count, step);
  const startDate = new Date(today.getTime() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const endDate = today.toISOString();

  const query = { query: [{ exchange, type: resolveAssetType(symbol), values: [symbol], fields: ["open", "high", "low", "close", "cumulative_volume"], startDate, endDate, interval: brokerInterval, intraDay: false, realTime: false }] };
  let candles: any[] = [];
  try {
    const data = await nubraApi.getHistoricalData(query);
    if (data?.result?.[0]) {
      const symData = data.result[0].values[0][symbol];
      if (symData?.close) {
        const times = symData.close.map((p: any) => p.ts);
        const volume = md.toPerBarVolume(symData.cumulative_volume.map((p: any) => p.v));
        candles = times.map((ts: number, idx: number) => ({ ts, open: symData.open[idx].v / 100, high: symData.high[idx].v / 100, low: symData.low[idx].v / 100, close: symData.close[idx].v / 100, volume: volume[idx] }));
      }
    }
  } catch (_) {}
  // No synthetic fallback — return only real broker data
  if (candles.length > count) candles = candles.slice(candles.length - count);
  return candles;
}

/** Fetch option symbol (e.g., "NIFTY25JUL24100CE") for a given strike and type from option chain */
export async function fetchOptionSymbol(symbol: string, strike: number, optType: "CE" | "PE", exchange = "NSE"): Promise<string | null> {
  try {
    const chain = await nubraApi.getOptionChain(symbol, undefined, exchange);
    const entries = chain?.chain?.[optType.toLowerCase()];
    if (!entries) return null;
    const arr = Object.values(entries) as any[];
    const match = arr.find((o: any) => Math.round(o.sp / 100) === strike);
    return match?.symbol || null;
  } catch { return null; }
}

/** Fetch OHLC candles for a specific option strike */
export async function fetchOptionCandles(symbol: string, strike: number, optType: "CE" | "PE", exchange: string, interval: string, count: number): Promise<any[]> {
  const optSym = await fetchOptionSymbol(symbol, strike, optType, exchange);
  if (!optSym) return [];
  return fetchCandlesInternal(optSym, exchange, interval, count);
}
