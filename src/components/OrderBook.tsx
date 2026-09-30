import React, { useState, useEffect } from "react";
import { Hash, Play, XCircle, CheckCircle, Clock, Trash2, Activity } from "lucide-react";
import { Order, ScalperTrade } from "../types";

interface OrderBookProps {
  orders: {
    open: Order[];
    executed: Order[];
    cancelled: Order[];
    rejected: Order[];
  } | null;
  onCancelOrder: (orderId: number) => void;
  isLoading: boolean;
}

export default function OrderBook({ orders, onCancelOrder, isLoading }: OrderBookProps) {
  const [bookTab, setBookTab] = useState<"EXCHANGE" | "SCALPER">("EXCHANGE");
  const [scalperTrades, setScalperTrades] = useState<ScalperTrade[]>([]);
  const [scalperLoading, setScalperLoading] = useState(false);

  const fetchScalperTrades = async () => {
    setScalperLoading(true);
    try {
      const res = await fetch("/api/scalper/trades");
      if (res.ok) {
        const data = await res.json();
        if (data.success) setScalperTrades(data.trades || []);
      }
    } catch (_) {}
    setScalperLoading(false);
  };

  useEffect(() => {
    if (bookTab === "SCALPER") {
      fetchScalperTrades();
      const t = setInterval(fetchScalperTrades, 10000);
      return () => clearInterval(t);
    }
  }, [bookTab]);

  const allOrders = [
    ...(orders?.open || []).map((o) => ({ ...o, status: "OPEN" as const })),
    ...(orders?.executed || []).map((o) => ({ ...o, status: "EXECUTED" as const })),
    ...(orders?.cancelled || []).map((o) => ({ ...o, status: "CANCELLED" as const })),
    ...(orders?.rejected || []).map((o) => ({ ...o, status: "REJECTED" as const })),
  ].sort((a, b) => {
    const timeA = a.timestamps?.intentCreatedAt ? new Date(a.timestamps.intentCreatedAt).getTime() : 0;
    const timeB = b.timestamps?.intentCreatedAt ? new Date(b.timestamps.intentCreatedAt).getTime() : 0;
    return timeB - timeA;
  });

  return (
    <div className="glass-surface border border-brand-border rounded-lg p-5 shadow-2xl flex flex-col min-h-[280px] h-auto overflow-hidden">
      {/* Header with tabs */}
      <div className="flex items-center justify-between border-b border-brand-border pb-3 mb-3 glass-base/40">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-gray-400" />
          <div className="flex gap-1 glass-surface-sm p-0.5 rounded-lg text-[9px] font-semibold">
            <button onClick={() => setBookTab("EXCHANGE")}
              className={`px-2 py-1 rounded transition-colors ${bookTab === "EXCHANGE" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"}`}>
              Exchange
            </button>
            <button onClick={() => setBookTab("SCALPER")}
              className={`px-2 py-1 rounded transition-colors flex items-center gap-1 ${bookTab === "SCALPER" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"}`}>
              <Activity className="h-3 w-3" /> Scalper
            </button>
          </div>
        </div>
        <span className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">
          {bookTab === "EXCHANGE" ? "Live Audit Log" : "AutoScalper Trades"}
        </span>
      </div>

      {/* Grid List */}
      <div className="flex-1 overflow-y-auto divide-y divide-brand-border/40 pr-1">
        {bookTab === "EXCHANGE" ? (
          allOrders.length === 0 ? (
            <div className="h-full flex items-center justify-center text-gray-500 text-xs font-serif italic">
              No orders transmitted in this session.
            </div>
          ) : (
            allOrders.map((ord) => {
              const dateStr = ord.timestamps?.intentCreatedAt
                ? new Date(ord.timestamps.intentCreatedAt).toLocaleTimeString()
                : "09:15:00";

              return (
                <div key={ord.intentOrderId} className="py-2.5 flex items-center justify-between text-xs gap-3">
                  <div className="flex items-center gap-2.5">
                    {/* Status Indicator */}
                    {ord.status === "OPEN" ? (
                      <Clock className="h-4 w-4 text-amber-400 shrink-0" />
                    ) : ord.status === "EXECUTED" ? (
                      <CheckCircle className="h-4 w-4 text-brand-green shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-brand-red shrink-0" />
                    )}

                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className={`px-1 rounded text-[9px] font-bold font-mono ${
                          ord.side === "BUY" ? "bg-brand-green/10 text-brand-green" : "bg-brand-red/10 text-brand-red"
                        }`}>
                          {ord.side}
                        </span>
                        <span className="font-semibold text-gray-200">
                          {ord.isMulti ? "Strategy Basket" : `Scrip ID ${ord.refId || "RELIANCE"}`}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-gray-500 font-mono mt-0.5">
                        <span>ID: #{ord.intentOrderId}</span>
                        <span>•</span>
                        <span>{dateStr}</span>
                      </div>
                    </div>
                  </div>

                  {/* Right Quantity / Actions */}
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <span className="block font-bold text-white font-mono">
                        {ord.orderQty} Lots
                      </span>
                      <span className="block text-[10px] text-gray-400 font-mono">
                        Price: ₹{((ord.orderPrice || 120000) / 100).toFixed(2)}
                      </span>
                    </div>

                    {ord.status === "OPEN" && (
                      <button
                        onClick={() => onCancelOrder(ord.intentOrderId)}
                        disabled={isLoading}
                        className="p-1.5 hover:bg-brand-red/10 text-brand-red rounded border border-transparent hover:border-brand-red/20 cursor-pointer transition-colors"
                        title="Cancel Order"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )
        ) : scalperLoading && scalperTrades.length === 0 ? (
          <div className="h-full flex items-center justify-center text-gray-500 text-xs font-mono">
            Loading scalper trades...
          </div>
        ) : scalperTrades.length === 0 ? (
          <div className="h-full flex items-center justify-center text-gray-500 text-xs font-serif italic">
            No scalper trades yet.
          </div>
        ) : (
          scalperTrades.map((t) => {
            const dateStr = t.timestamps?.intentCreatedAt
              ? new Date(t.timestamps.intentCreatedAt).toLocaleTimeString()
              : "—";
            const pnl = t.pnl ?? 0;
            return (
              <div key={t.intentOrderId} className="py-2.5 flex items-center justify-between text-xs gap-3">
                <div className="flex items-center gap-2.5">
                  <Activity className={`h-4 w-4 shrink-0 ${pnl >= 0 ? "text-brand-green" : "text-brand-red"}`} />
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-gray-200 font-mono">
                        {t.optType}{t.strike || ""}
                      </span>
                      <span className={`px-1 rounded text-[9px] font-bold font-mono ${
                        pnl >= 0 ? "bg-brand-green/10 text-brand-green" : "bg-brand-red/10 text-brand-red"
                      }`}>
                        {pnl >= 0 ? "+" : ""}₹{Math.abs(pnl).toFixed(0)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-gray-500 font-mono mt-0.5">
                      <span>Entry: {t.entryPremium?.toFixed(1)}</span>
                      <span>•</span>
                      <span>{t.exitReason || t.status || "—"}</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <span className="block text-[10px] text-gray-400 font-mono">
                    Lot: {t.orderQty || t.qty || "—"}
                  </span>
                  {t.exitPremium && (
                    <span className="block text-[9px] text-gray-500 font-mono">
                      Exit: {t.exitPremium?.toFixed(1)}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
