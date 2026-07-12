import React, { useState } from "react";
import { Landmark, TrendingUp, TrendingDown, Briefcase, Award } from "lucide-react";
import { PortfolioSummary } from "../types";

interface PortfolioProps {
  portfolio: PortfolioSummary | null;
}

export default function Portfolio({ portfolio }: PortfolioProps) {
  const [activeTab, setActiveTab] = useState<"POSITIONS" | "HOLDINGS">("POSITIONS");

  const positions = portfolio?.positions?.portfolio?.positions || [];
  const holdings = portfolio?.holdings?.portfolio?.holdings || [];

  const holdingStats = portfolio?.holdings?.portfolio?.holdingStats;
  const positionStats = portfolio?.positions?.portfolio?.positionStats;

  const totalInvested = holdingStats ? holdingStats.investedAmount / 100 : 350000;
  const currentVal = holdingStats ? holdingStats.currentValue / 100 : 375000;
  const totalPnl = holdingStats ? holdingStats.totalPnl / 100 : 25000;
  const totalPnlChg = holdingStats ? holdingStats.totalPnlChg : 7.14;

  return (
    <div className="bg-brand-card border border-brand-border rounded-lg p-5 shadow-2xl flex flex-col min-h-[280px] h-auto overflow-hidden">
      {/* Tab Select and Overview stats */}
      <div className="flex items-center justify-between border-b border-brand-border pb-3 mb-3 bg-black/10">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab("POSITIONS")}
            className={`px-3 py-1.5 text-xs font-bold rounded uppercase tracking-wider transition-colors border ${
              activeTab === "POSITIONS"
                ? "bg-white border-transparent text-black"
                : "border-transparent text-gray-400 hover:text-white cursor-pointer"
            }`}
          >
            Active Positions
          </button>
          <button
            onClick={() => setActiveTab("HOLDINGS")}
            className={`px-3 py-1.5 text-xs font-bold rounded uppercase tracking-wider transition-colors border ${
              activeTab === "HOLDINGS"
                ? "bg-white border-transparent text-black"
                : "border-transparent text-gray-400 hover:text-white cursor-pointer"
            }`}
          >
            Long-term Holdings
          </button>
        </div>

        {/* Aggregate KPI */}
        <div className="text-right">
          <span className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider">
            {activeTab === "HOLDINGS" ? "Net Invested P&L" : "Day Realized P&L"}
          </span>
          <span className={`text-xs font-mono font-bold ${totalPnl >= 0 ? "text-brand-green glow-green" : "text-brand-red glow-red"}`}>
            {totalPnl >= 0 ? "+" : ""}₹{totalPnl.toLocaleString("en-IN", { minimumFractionDigits: 2 })} ({totalPnlChg.toFixed(2)}%)
          </span>
        </div>
      </div>

      {/* Main table content */}
      <div className="flex-1 overflow-y-auto divide-y divide-brand-border/40 pr-1">
        {activeTab === "POSITIONS" ? (
          positions.length === 0 ? (
            <div className="h-full flex items-center justify-center text-gray-500 text-xs font-serif italic">
              No active futures or option positions found.
            </div>
          ) : (
            positions.map((pos) => {
              const pnl = pos.pnl / 100;
              return (
                <div key={pos.refId} className="py-2.5 flex items-center justify-between text-xs">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-gray-200">{pos.symbol}</span>
                      <span className="text-[10px] text-gray-500 font-mono">({pos.deliveryType})</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500 font-mono mt-0.5">
                      <span>Qty: {pos.netQuantity}</span>
                      <span>•</span>
                      <span>Avg: ₹{(pos.avgPrice / 100).toFixed(2)}</span>
                    </div>
                  </div>

                  {/* Profit indicator */}
                  <div className="text-right space-y-0.5">
                    <span className="block font-mono font-bold text-white">
                      ₹{(pos.lastTradedPrice / 100).toFixed(2)}
                    </span>
                    <span className={`block font-mono text-[10px] font-semibold ${pnl >= 0 ? "text-brand-green" : "text-brand-red"}`}>
                      {pnl >= 0 ? "+" : ""}₹{pnl.toFixed(2)} ({pos.pnlChg.toFixed(2)}%)
                    </span>
                  </div>
                </div>
              );
            })
          )
        ) : holdings.length === 0 ? (
          <div className="h-full flex items-center justify-center text-gray-500 text-xs font-serif italic">
            No durable equity holdings found in demat.
          </div>
        ) : (
          holdings.map((hold) => {
            const pnl = hold.netPnl / 100;
            return (
              <div key={hold.refId} className="py-2.5 flex items-center justify-between text-xs">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-gray-200">{hold.symbol}</span>
                    <span className="text-[9px] px-1 bg-black border border-brand-border text-gray-400 rounded font-mono">
                      {hold.exchange}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-500 font-mono mt-0.5">
                    <span>Held Qty: {hold.quantity}</span>
                    <span>•</span>
                    <span>Avg Price: ₹{(hold.avgPrice / 100).toFixed(2)}</span>
                  </div>
                </div>

                {/* Profit indicator */}
                <div className="text-right space-y-0.5">
                  <span className="block font-mono font-bold text-white">
                    ₹{(hold.lastTradedPrice / 100).toFixed(2)}
                  </span>
                  <span className={`block font-mono text-[10px] font-semibold ${pnl >= 0 ? "text-brand-green" : "text-brand-red"}`}>
                    {pnl >= 0 ? "+" : ""}₹{pnl.toFixed(2)} ({hold.netPnlChg.toFixed(2)}%)
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
