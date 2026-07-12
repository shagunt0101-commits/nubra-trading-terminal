import crypto from "crypto";
import fs from "fs";
import path from "path";

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

function clearSession() {
  if (process.env.VERCEL) return;
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch (_) {}
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
    console.error("Error generating TOTP:", error.message);
    return "000000";
  }
}

// Performs step-by-step automated login using TOTP and Pin
export async function nubraLogin(): Promise<string> {
  loginStatus = "PENDING";
  loginError = "";
  try {
    if (!NUBRA_PHONE || !NUBRA_MPIN || !NUBRA_TOTP_SECRET) {
      throw new Error("Missing phone, MPIN, or TOTP Secret in environment variables.");
    }

    const totpCode = generateTOTP(NUBRA_TOTP_SECRET);
    console.log(`[Nubra] TOTP generated and sent for phone login`);

    // Step 1: Login via TOTP to get auth_token
    const loginRes = await fetch(`${BASE_URL}/totp/login`, {
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
    const pinRes = await fetch(`${BASE_URL}/verifypin`, {
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
    console.log("[Nubra] Successfully logged in. Session token established.");
    return sessionToken;
  } catch (err: any) {
    loginError = err.message;
    loginStatus = "FAILED";
    console.error("[Nubra] Login error:", err.message);
    return "";
  }
}

// OTP-based login flow (step 1: send OTP to phone)
export async function nubraSendOtp(phone?: string): Promise<{ success: boolean; tempToken?: string; error?: string }> {
  try {
    const p = phone || NUBRA_PHONE;
    if (!p) throw new Error("Phone number required.");

    const res = await fetch(`${BASE_URL}/sendphoneotp`, {
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

    const res = await fetch(`${BASE_URL}/verifyphoneotp`, {
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
    const pinRes = await fetch(`${BASE_URL}/verifypin`, {
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
  };
}

// Generic Fetch Wrapper that injects Authorization headers — auto-login via TOTP if no session
async function nubraRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
  if (!sessionToken || loginStatus === "FAILED") {
    // Auto-login with TOTP if credentials are configured
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

  let res = await fetch(url, { ...options, headers });

  // Handle Session Expiry (440) — token is dead, clear it
  if (res.status === 440) {
    console.log("[Nubra] Session expired (440). Clearing stale session.");
    clearSession();
    sessionToken = "";
    throw new Error("Session expired. Please login again via OTP.");
  }

  if (!res.ok) {
    let errMsg = `Request failed: ${res.statusText}`;
    try {
      const json = await res.json();
      if (json.error) errMsg = json.error;
    } catch (_) {}
    throw new Error(errMsg);
  }

  return res.json();
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
      body: JSON.stringify(query),
    }),

  createOrder: (orders: any[]) =>
    nubraRequest("sentinel/orders/create", {
      method: "POST",
      body: JSON.stringify({ orders }),
    }),

  modifyOrder: (orders: any[]) =>
    nubraRequest("sentinel/orders/modify", {
      method: "POST",
      body: JSON.stringify({ orders }),
    }),

  cancelOrder: (orders: any[]) =>
    nubraRequest("sentinel/orders/cancel", {
      method: "POST",
      body: JSON.stringify({ orders }),
    }),

  getOrders: (intentOrderId?: string, stratTags?: string) => {
    let query = "";
    if (intentOrderId) query += `?intentOrderId=${intentOrderId}`;
    if (stratTags) query += (query ? "&" : "?") + `stratTags=${stratTags}`;
    return nubraRequest(`sentinel/orders${query}`);
  }
};
