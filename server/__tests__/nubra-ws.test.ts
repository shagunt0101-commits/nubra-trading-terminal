import { describe, it, expect } from "vitest";
import protobuf from "protobufjs";

// Mirror of the runtime schema in nubra-ws.ts — must stay in sync. If this
// test's synthetic frame can't roundtrip, the live decode path is broken.
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

/** Encode the exact two-Any envelope the SDK decodes. */
function encodeEnvelope(inner: protobuf.Message, typeUrlSuffix: string, key: string): Buffer {
  const { any, orderbook } = buildSchema();
  const innerAny = any.encode(any.create({ type_url: `type.googleapis.com/${typeUrlSuffix}`, value: orderbook.encode(inner).finish() })).finish();
  return Buffer.from(any.encode(any.create({ type_url: "type.googleapis.com/nubrafrontend.GenericData", value: innerAny })).finish());
}

// Minimal re-implementation of the frame decode in nubra-ws.ts (same logic)
function decodeFrame(data: Buffer) {
  const { any, orderbook } = buildSchema();
  const outer = any.decode(data);
  const inner = any.decode(outer.value as any);
  if (!inner.type_url.endsWith("BatchWebSocketOrderbookMessage")) return null;
  const decoded = orderbook.toObject(orderbook.decode(inner.value as any), { longs: String, defaults: true });
  const instruments = (decoded.instruments as any[]) || [];
  return instruments.map((inst: any) => ({
    instId: inst.inst_id,
    ltp: Number(inst.ltp),
    refId: inst.ref_id,
    bids: (inst.bids || []).map((b: any) => ({ price: Number(b.price), quantity: Number(b.quantity), orders: Number(b.orders) })),
    asks: (inst.asks || []).map((a: any) => ({ price: Number(a.price), quantity: Number(a.quantity), orders: Number(a.orders) })),
  }));
}

describe("nubra-ws frame decode (Any-of-Any)", () => {
  it("decodes an orderbook frame end-to-end", () => {
    const { orderbook } = buildSchema();
    const frame = orderbook.create({
      timestamp: "1710000000000",
      instruments: [
        {
          inst_id: "1120031",
          timestamp: "1710000000000",
          bids: [
            { price: "24550", quantity: "12", orders: "3" },
            { price: "24545", quantity: "5", orders: "1" },
          ],
          asks: [
            { price: "24560", quantity: "8", orders: "2" },
            { price: "24565", quantity: "20", orders: "4" },
          ],
          ltp: "24555",
          ltq: "1",
          volume: "123456",
          ref_id: "73009",
        },
      ],
    });
    const buf = encodeEnvelope(frame, "BatchWebSocketOrderbookMessage", "orderbook");
    const snaps = decodeFrame(buf);
    expect(snaps).not.toBeNull();
    expect(snaps!.length).toBe(1);
    expect(snaps![0].instId).toBe("1120031");
    expect(snaps![0].ltp).toBe(24555);
    expect(snaps![0].refId).toBe("73009");
    expect(snaps![0].bids[0]).toEqual({ price: 24550, quantity: 12, orders: 3 });
    expect(snaps![0].asks[1]).toEqual({ price: 24565, quantity: 20, orders: 4 });
  });

  it("returns null for a non-orderbook type_url (dispatch)", () => {
    const { orderbook } = buildSchema();
    const frame = orderbook.create({ timestamp: "1", instruments: [] });
    const buf = encodeEnvelope(frame, "SomeOtherMessage", "greeks");
    expect(decodeFrame(buf)).toBeNull();
  });

  it("treats int64 as strings then Number (Long precision guard)", () => {
    const { orderbook } = buildSchema();
    const frame = orderbook.create({ timestamp: "1710000000000", instruments: [{ inst_id: "1120031", ref_id: "73009" }] });
    const buf = encodeEnvelope(frame, "BatchWebSocketOrderbookMessage", "orderbook");
    const snaps = decodeFrame(buf);
    expect(snaps![0].instId).toBe("1120031");
    expect(snaps![0].refId).toBe("73009");
  });
});
