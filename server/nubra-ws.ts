import WebSocket from "ws";
import protobuf from "protobufjs";
import logger from "./logger.js";
import { getSessionToken, nubraApi, getLoginState } from "./nubra.js";

// ─────────────────────────────────────────────────────────────────────────────
// Nubra order-flow WebSocket client — Stage 1 of .claude/plans/orderflow-trading-plan.md
//
// Protocol verified 2026-08-02 against the shipped `nubra-sdk==0.5.0` wheel
// (nubra_python_sdk/ticker/websocketdata.py + protos/nubrafrontend_pb2.py) —
// the published docs disagree in three places, the SDK is ground truth:
//   1. Envelope is NOT `GenericData {string key; Any data}` — it is an
//      Any-of-Any: the outer Any's `value` holds a second Any whose
//      `type_url` suffix identifies the message. Dispatch on the inner type_url.
//   2. PROD endpoint is `wss://api2.nubra.io/apibatch/ws`, NOT api.nubra.io.
//      (UAT matches the docs: wss://uatapi.nubra.io/apibatch/ws.)
//   3. `orderbook_depth` / `socket_interval` are separate text commands,
//      not fields of the subscribe payload.
//
// Field numbers below are taken from the pb2 descriptor. The plan mandates a
// UAT live run before trusting byte-level detail — see `verifyAgainstRest()`.
// ─────────────────────────────────────────────────────────────────────────────

const NUBRA_ENV = process.env.NUBRA_ENV || "PROD";
const WS_URL =
  NUBRA_ENV === "PROD"
    ? "wss://api2.nubra.io/apibatch/ws"
    : "wss://uatapi.nubra.io/apibatch/ws";

const RECONNECT_BASE_MS = 1_000; // 1s, doubling to RECONNECT_MAX_MS
const RECONNECT_MAX_MS = 30_000;
const SUBSCRIBE_DEPTH = 4; // top-4 levels per side (plan: less bandwidth for scalping)

// Runtime protobuf schema — no .proto compile step needed. int64 fields come
// back as Long objects; always decode via toObject({ longs: String }).
// protobufjs 8: dotted names (google.protobuf.Any) MUST be declared via nested
// JSON namespaces inside a single Root.fromJSON — Type.fromJSON flattens
// dotted names and a flat root.add() can't be resolved by dotted lookup.
function buildSchema() {
  const root = protobuf.Root.fromJSON({
    nested: {
      google: {
        nested: {
          protobuf: {
            nested: {
              Any: {
                fields: {
                  type_url: { type: "string", id: 1 },
                  value: { type: "bytes", id: 2 },
                },
              },
            },
          },
        },
      },
      OrderBookLevel: {
        fields: {
          price: { type: "int64", id: 1 },
          quantity: { type: "int64", id: 2 },
          orders: { type: "int64", id: 3 },
        },
      },
      WebSocketMsgOrderBook: {
        fields: {
          inst_id: { type: "int64", id: 1 },
          timestamp: { type: "int64", id: 2 },
          bids: { rule: "repeated", type: "OrderBookLevel", id: 3 },
          asks: { rule: "repeated", type: "OrderBookLevel", id: 4 },
          ltp: { type: "int64", id: 5 },
          ltq: { type: "int64", id: 6 },
          volume: { type: "int64", id: 7 },
          ref_id: { type: "int64", id: 8 },
        },
      },
      BatchWebSocketOrderbookMessage: {
        fields: {
          timestamp: { type: "int64", id: 1 },
          instruments: { rule: "repeated", type: "WebSocketMsgOrderBook", id: 2 },
        },
      },
    },
  });
  return {
    any: root.lookupType("google.protobuf.Any"),
    orderbook: root.lookupType("BatchWebSocketOrderbookMessage"),
  };
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface OrderBookSnapshot {
  instId: string;
  timestamp: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  ltp: number;
  ltq: number;
  volume: number;
  refId: string;
}

const { any: ANY, orderbook: ORDERBOOK } = buildSchema();

export class NubraWsClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private shouldRun = false;
  private instIds: number[] = [];
  private refSymbols = new Map<number, string>();
  private onBookCb: ((snap: OrderBookSnapshot) => void) | null = null;

  /** Start the persistent connection + orderbook subscription. */
  start(instIds: number[] = [], onOrderbook?: (snap: OrderBookSnapshot) => void, refAssetNames: Record<number, string> = {}) {
    if (Object.keys(refAssetNames).length) {
      this.refSymbols = new Map(Object.entries(refAssetNames).map(([k, v]) => [Number(k), v]));
    } // else preserve refs already populated by resolveRefIds()
    this.instIds = instIds;
    this.onBookCb = onOrderbook ?? null;
    this.shouldRun = true;
    this.connect();
  }

  stop() {
    this.shouldRun = false;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    logger.info("[NubraWS] Stopped");
  }

  isConnected() {
    return this.connected;
  }

  /** Option ticker per ref_id (from resolveRefIds) — for REST parity calls. */
  symbolForRefId(refId: number): string {
    return this.refSymbols.get(refId) || "";
  }

  private connect() {
    if (!this.shouldRun) return;
    const token = getSessionToken();
    if (!token) {
      logger.warn("[NubraWS] No session token — not connecting. Login via REST first.");
      this.scheduleReconnect();
      return;
    }

    logger.info(`[NubraWS] Connecting to ${WS_URL} (env=${NUBRA_ENV})`);
    const ws = new WebSocket(WS_URL);

    ws.on("open", () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE_MS;
      logger.info("[NubraWS] Connected — subscribing orderbook");
      // text commands, not JSON-RPC (SDK: f"batch_subscribe {bt} ...")
      ws.send(`batch_subscribe ${token} orderbook {"instruments":[${this.instIds.join(",")}]}`);
      ws.send(`batch_subscribe ${token} orderbook_depth ${SUBSCRIBE_DEPTH}`);
    });

    ws.on("message", (data: Buffer) => {
      try {
        this.handleFrame(data);
      } catch (e: any) {
        // One bad frame must not kill the stream (wrong field numbers throw).
        logger.warn({ err: e.message }, "[NubraWS] Frame decode error (non-fatal)");
      }
    });

    ws.on("close", () => {
      this.connected = false;
      if (this.shouldRun) {
        logger.warn(`[NubraWS] Connection closed — reconnecting in ${this.reconnectDelay}ms`);
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      logger.warn({ err: err.message }, "[NubraWS] Connection error");
    });
  }

  private scheduleReconnect() {
    if (!this.shouldRun || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  /** Decode a binary frame: outer Any → inner Any → typed payload. */
  private handleFrame(data: Buffer) {
    const outer = ANY.decode(data);
    // outer.type_url is the Any-of-Any wrapper; inner.type_url identifies msg
    const inner = ANY.decode(outer.value as any);
    const typeUrl = inner.type_url || "";
    if (!typeUrl.endsWith("BatchWebSocketOrderbookMessage")) return;

    const decoded = ORDERBOOK.toObject(ORDERBOOK.decode(inner.value as any), {
      longs: String,
      defaults: true,
    });
    const instruments = (decoded.instruments as any[]) || [];
    for (const inst of instruments) {
      const snap: OrderBookSnapshot = {
        instId: inst.inst_id,
        timestamp: inst.timestamp,
        bids: (inst.bids || []).map((b: any) => ({
          price: Number(b.price),
          quantity: Number(b.quantity),
          orders: Number(b.orders),
        })),
        asks: (inst.asks || []).map((a: any) => ({
          price: Number(a.price),
          quantity: Number(a.quantity),
          orders: Number(a.orders),
        })),
        ltp: Number(inst.ltp),
        ltq: Number(inst.ltq),
        volume: Number(inst.volume),
        refId: inst.ref_id,
      };
      this.onBookCb?.(snap);
    }
  }

  /**
   * Stage-1 verification helper: fetch the same instrument's live quote via
   * REST and compare best bid/ask against the most recent WS snapshot. Call
   * this during a UAT session — the plan requires the WS frame to roughly
   * match REST before trusting the feed.
   */
  async verifyAgainstRest(refId: number, symbol: string) {
    try {
      // parity must compare the same option: refId → its option ticker, not the
      // underlying index (index REST price is ~24.6k, option premium is ~60)
      const optSymbol = this.symbolForRefId(refId) || symbol;
      const rest = await nubraApi.getCurrentPrice(optSymbol, "NSE");
      logger.info({ rest, refId, optSymbol }, "[NubraWS] REST quote snapshot (for WS parity check)");
    } catch (e: any) {
      logger.warn({ err: e.message }, "[NubraWS] verifyAgainstRest failed");
    }
  }

  /** Resolve numeric ref_ids for a symbol from the instruments master (UAT and
   *  PROD differ — always fetch from the live env). Returns option ref_ids for
   *  the nearest strikes around spot, or [] on failure. */
  async resolveRefIds(symbol: string, spot: number, count = 3): Promise<number[]> {
    try {
      // ISO date (YYYY-MM-DD) — PROD rejects the compact YYYYMMDD form
      const date = new Date().toISOString().slice(0, 10);
      const todayInt = parseInt(date.replace(/-/g, ""), 10);
      const data = await nubraApi.getInstruments(date, "NSE");
      const rows: any[] = data?.refdata || [];

      // refdata rows: asset=underlying ("NIFTY"), stock_name=full option symbol
      // ("NIFTY2680429350CE"), strike_price in paise (÷100 for rupees),
      // derivative_type="OPT", expiry=YYYYMMDD int.
      const options = rows.filter((r) => r.asset === symbol && r.derivative_type === "OPT" && r.expiry >= todayInt);
      if (!options.length) {
        logger.warn({ symbol }, "[NubraWS] No option rows in refdata");
        return [];
      }
      // nearest expiry first, then strikes nearest ATM spot
      options.sort((a: any, b: any) => a.expiry - b.expiry);
      const nearestExpiry = options[0].expiry;
      const near = options
        .filter((r) => r.expiry === nearestExpiry && Math.abs((r.strike_price || 0) / 100 - spot) <= 200)
        .sort((a: any, b: any) => Math.abs((a.strike_price || 0) / 100 - spot) - Math.abs((b.strike_price || 0) / 100 - spot))
        .slice(0, count);
      // remember the option asset_name per ref_id — WS frames carry only ref_id,
      // but REST quote parity needs the option ticker, not the underlying index
      for (const r of near) this.refSymbols.set(r.ref_id, r.stock_name);
      logger.info({ symbol, spot, nearestExpiry, near: near.map((r: any) => ({ ref: r.ref_id, n: r.stock_name, sp: r.strike_price / 100 })) }, "[NubraWS] Resolved ref_ids");
      return near.map((r: any) => r.ref_id);
    } catch (e: any) {
      logger.warn({ err: e.message }, "[NubraWS] resolveRefIds failed");
      return [];
    }
  }
}

// Singleton — same pattern as scalper-instance.ts
export const nubraWs = new NubraWsClient();
