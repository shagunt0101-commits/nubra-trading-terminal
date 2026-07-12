import React, { useState, useEffect } from "react";
import { Landmark, ArrowUpRight, ArrowDownLeft, Trash2, Plus, HelpCircle, CheckCircle2 } from "lucide-react";
import { Instrument } from "../types";

interface OrderDeskProps {
  selectedInstrument: Instrument | null;
  instruments: Instrument[];
  onOrderPlaced: () => void;
  prefillParams: {
    side: "BUY" | "SELL";
    price: number;
    stoploss: number;
    target: number;
    qty: number;
  } | null;
}

export default function OrderDesk({
  selectedInstrument,
  instruments,
  onOrderPlaced,
  prefillParams,
}: OrderDeskProps) {
  const [orderType, setOrderType] = useState<"SINGLE" | "STRATEGY">("SINGLE");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [qty, setQty] = useState(1);
  const [deliveryType, setDeliveryType] = useState<"IDAY" | "CNC">("IDAY");
  const [priceType, setPriceType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [entryPrice, setEntryPrice] = useState<string>("");

  // Exit & risk triggers
  const [useStoploss, setUseStoploss] = useState(false);
  const [stoplossTrigger, setStoplossTrigger] = useState("");
  const [stoplossLimit, setStoplossLimit] = useState("");
  const [useTarget, setUseTarget] = useState(false);
  const [targetTrigger, setTargetTrigger] = useState("");
  const [targetLimit, setTargetLimit] = useState("");

  // Strategy Legs (for F&O Basket orders)
  const [legs, setLegs] = useState<Array<{ refId: number; unitQty: number }>>([]);

  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // Pre-fill from AI signals
  useEffect(() => {
    if (prefillParams) {
      if (prefillParams.side) setSide(prefillParams.side);
      if (prefillParams.qty) setQty(prefillParams.qty);
      if (prefillParams.price !== undefined && prefillParams.price !== null) {
        setEntryPrice(prefillParams.price.toString());
      }
      
      if (prefillParams.stoploss) {
        setUseStoploss(true);
        setStoplossTrigger(prefillParams.stoploss.toString());
        setStoplossLimit((prefillParams.stoploss - 1).toString());
      }
      
      if (prefillParams.target) {
        setUseTarget(true);
        setTargetTrigger(prefillParams.target.toString());
        setTargetLimit((prefillParams.target - 1).toString());
      }
    }
  }, [prefillParams]);

  // Set default values when instrument shifts
  useEffect(() => {
    if (selectedInstrument) {
      setQty(selectedInstrument.lot_size > 1 ? selectedInstrument.lot_size : 1);
      if (selectedInstrument.underlying_prev_close) {
        setEntryPrice((selectedInstrument.underlying_prev_close / 100).toString());
      }
    }
  }, [selectedInstrument]);

  const addLeg = () => {
    if (instruments.length > 0) {
      setLegs([...legs, { refId: instruments[0].ref_id, unitQty: 1 }]);
    }
  };

  const removeLeg = (index: number) => {
    setLegs(legs.filter((_, idx) => idx !== index));
  };

  const updateLeg = (index: number, field: "refId" | "unitQty", value: number) => {
    setLegs(
      legs.map((leg, idx) =>
        idx === index ? { ...leg, [field]: value } : leg
      )
    );
  };

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (orderType === "SINGLE" && !selectedInstrument) return;
    setIsLoading(true);
    setError("");
    setMessage("");

    try {
      const payload: any = {
        isMultiLeg: orderType === "STRATEGY",
        qty: parseInt(qty as any, 10),
        side,
        deliveryType,
        priceType,
        validityType: "DAY",
        stratTags: ["manual-terminal"],
      };

      if (orderType === "SINGLE") {
        payload.refId = selectedInstrument!.ref_id;
        if (priceType === "LIMIT") {
          // Convert price to integer paise as expected by OMS V3
          payload.entryPrice = Math.round(parseFloat(entryPrice) * 100);
        } else {
          payload.validityType = "IOC"; // IOC is required for MARKET orders
        }

        // Add stoploss / target triggers
        if (useStoploss || useTarget) {
          payload.executionMode = "ENTRY_AND_EXIT";
          payload.exitConfig = {};
          
          if (useStoploss && stoplossTrigger) {
            payload.exitConfig.stoplossParams = {
              stoplossTriggerPrice: { value: Math.round(parseFloat(stoplossTrigger) * 100) },
              stoplossLimitPrice: { value: Math.round(parseFloat(stoplossLimit || stoplossTrigger) * 100) },
            };
          }

          if (useTarget && targetTrigger) {
            payload.exitConfig.targetParams = {
              targetProfitTriggerPrice: { value: Math.round(parseFloat(targetTrigger) * 100) },
              targetProfitLimitPrice: { value: Math.round(parseFloat(targetLimit || targetTrigger) * 100) },
            };
          }
        } else {
          payload.executionMode = "ENTRY";
        }
      } else {
        // Strategy Basket Order
        if (legs.length === 0) {
          throw new Error("Add at least one Option/Future leg to place a strategy basket.");
        }
        payload.legs = legs.map((l) => ({
          refId: l.refId,
          unitQty: l.unitQty,
        }));
        payload.side = "BUY"; // OMS requirement: Strategy side is BUY, leg multipliers hold signs
        payload.deliveryType = "CNC";
        if (entryPrice) {
          payload.entryPrice = Math.round(parseFloat(entryPrice) * 100);
        }
        payload.executionMode = "ENTRY";
      }

      const res = await fetch("/api/orders/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const data = await res.json();
      setMessage(data.message || "Order placed successfully!");
      onOrderPlaced();
    } catch (err: any) {
      setError(err.message || "Failed to place order.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-brand-card border border-brand-border rounded-lg p-5 shadow-2xl flex flex-col h-[650px] overflow-hidden">
      {/* Tab Switcher */}
      <div className="flex gap-2 border-b border-brand-border pb-3 mb-4 bg-black/20">
        <button
          onClick={() => setOrderType("SINGLE")}
          className={`flex-1 py-1.5 text-xs font-bold rounded uppercase tracking-wider transition-colors border ${
            orderType === "SINGLE"
              ? "bg-white border-transparent text-black"
              : "border-transparent text-gray-400 hover:text-white cursor-pointer"
          }`}
        >
          Regular Entry
        </button>
        <button
          onClick={() => setOrderType("STRATEGY")}
          className={`flex-1 py-1.5 text-xs font-bold rounded uppercase tracking-wider transition-colors border ${
            orderType === "STRATEGY"
              ? "bg-white border-transparent text-black"
              : "border-transparent text-gray-400 hover:text-white cursor-pointer"
          }`}
        >
          Strategy Basket
        </button>
      </div>

      <form onSubmit={handlePlaceOrder} className="flex-1 flex flex-col justify-between overflow-y-auto pr-1">
        <div className="space-y-4">
          {/* Status Message */}
          {message && (
            <div className="p-3 bg-brand-green/10 border border-brand-green/20 text-brand-green rounded flex items-center gap-2 text-xs font-mono">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{message}</span>
            </div>
          )}
          {error && (
            <div className="p-3 bg-brand-red/10 border border-brand-red/20 text-brand-red rounded text-xs font-mono">
              {error}
            </div>
          )}

          {/* SINGLE ORDER CONFIG */}
          {orderType === "SINGLE" ? (
            <>
              {!selectedInstrument ? (
                <div className="text-center py-10 text-gray-500 text-xs font-serif italic">
                  Please pick an asset from the Screener.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex justify-between items-center bg-black p-3 rounded border border-brand-border">
                    <span className="text-xs text-gray-400 font-serif italic">Active Scrip</span>
                    <span className="text-xs font-bold text-white">{selectedInstrument.stock_name}</span>
                  </div>

                  {/* Side Switch */}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setSide("BUY")}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-xs font-bold font-mono uppercase tracking-wider transition-all border cursor-pointer ${
                        side === "BUY"
                          ? "bg-brand-green/15 border-brand-green text-brand-green glow-green"
                          : "bg-black border-brand-border text-gray-400 hover:text-white"
                      }`}
                    >
                      <ArrowUpRight className="h-4 w-4" /> Buy / Long
                    </button>
                    <button
                      type="button"
                      onClick={() => setSide("SELL")}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-xs font-bold font-mono uppercase tracking-wider transition-all border cursor-pointer ${
                        side === "SELL"
                          ? "bg-brand-red/15 border-brand-red text-brand-red glow-red"
                          : "bg-black border-brand-border text-gray-400 hover:text-white"
                      }`}
                    >
                      <ArrowDownLeft className="h-4 w-4" /> Sell / Short
                    </button>
                  </div>

                  {/* Qty, Product & Price Fields */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider mb-1">Quantity</label>
                      <input
                        type="number"
                        min="1"
                        value={qty}
                        onChange={(e) => setQty(parseInt(e.target.value, 10))}
                        className="w-full bg-black border border-brand-border rounded p-2 text-xs text-white focus:outline-none focus:border-white/20 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider mb-1">Product</label>
                      <select
                        value={deliveryType}
                        onChange={(e: any) => setDeliveryType(e.target.value)}
                        className="w-full bg-black border border-brand-border rounded p-2 text-xs text-white focus:outline-none focus:border-white/20 cursor-pointer"
                      >
                        <option value="IDAY">Intraday (IDAY)</option>
                        <option value="CNC">Delivery (CNC)</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider mb-1">Price Type</label>
                      <select
                        value={priceType}
                        onChange={(e: any) => setPriceType(e.target.value)}
                        className="w-full bg-black border border-brand-border rounded p-2 text-xs text-white focus:outline-none focus:border-white/20 cursor-pointer"
                      >
                        <option value="LIMIT">Limit</option>
                        <option value="MARKET">Market</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider mb-1">Limit Price</label>
                      <input
                        type="text"
                        disabled={priceType === "MARKET"}
                        value={priceType === "MARKET" ? "Market" : entryPrice}
                        onChange={(e) => setEntryPrice(e.target.value)}
                        className="w-full bg-black border border-brand-border rounded p-2 text-xs text-white focus:outline-none focus:border-white/20 font-mono disabled:opacity-40"
                      />
                    </div>
                  </div>

                  {/* Stoploss and Target Section */}
                  <div className="space-y-2 border-t border-brand-border pt-3">
                    <div className="flex items-center justify-between text-[10px] uppercase font-bold tracking-wider text-gray-500">
                      <span>Advanced Risk Controls</span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {/* SL Trigger */}
                      <div className="space-y-1.5">
                        <label className="flex items-center gap-1.5 text-[9px] uppercase font-bold text-gray-500 tracking-wider cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useStoploss}
                            onChange={(e) => setUseStoploss(e.target.checked)}
                            className="rounded border-brand-border text-black focus:ring-0"
                          />
                          Stop Loss
                        </label>
                        <input
                          type="text"
                          placeholder="SL Trigger"
                          disabled={!useStoploss}
                          value={stoplossTrigger}
                          onChange={(e) => setStoplossTrigger(e.target.value)}
                          className="w-full bg-black border border-brand-border rounded p-1.5 text-xs text-white focus:outline-none focus:border-white/20 font-mono disabled:opacity-40"
                        />
                      </div>

                      {/* Target Trigger */}
                      <div className="space-y-1.5">
                        <label className="flex items-center gap-1.5 text-[9px] uppercase font-bold text-gray-500 tracking-wider cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useTarget}
                            onChange={(e) => setUseTarget(e.target.checked)}
                            className="rounded border-brand-border text-black focus:ring-0"
                          />
                          Profit Target
                        </label>
                        <input
                          type="text"
                          placeholder="Target Trigger"
                          disabled={!useTarget}
                          value={targetTrigger}
                          onChange={(e) => setTargetTrigger(e.target.value)}
                          className="w-full bg-black border border-brand-border rounded p-1.5 text-xs text-white focus:outline-none focus:border-white/20 font-mono disabled:opacity-40"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* STRATEGY BASKET CONFIG */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[9px] uppercase font-bold text-gray-500 tracking-wider font-mono">Basket Legs</span>
                <button
                  type="button"
                  onClick={addLeg}
                  className="flex items-center gap-1 text-[10px] bg-white text-black px-2.5 py-1.5 rounded font-bold transition-all cursor-pointer shadow-sm hover:bg-gray-100"
                >
                  <Plus className="h-3 w-3 text-black" /> Add Option Leg
                </button>
              </div>

              <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
                {legs.length === 0 ? (
                  <div className="text-center py-6 text-gray-500 text-xs font-serif italic">
                    No active legs in basket. Add legs to structure spreads or options strategies.
                  </div>
                ) : (
                  legs.map((leg, idx) => (
                    <div key={idx} className="flex gap-2 items-center bg-black p-2.5 rounded border border-brand-border">
                      {/* Instrument dropdown */}
                      <select
                        value={leg.refId}
                        onChange={(e) => updateLeg(idx, "refId", parseInt(e.target.value, 10))}
                        className="flex-1 bg-brand-card border border-brand-border text-[10px] text-white rounded px-2 py-1.5 focus:outline-none cursor-pointer"
                      >
                        {instruments.map((inst) => (
                          <option key={inst.ref_id} value={inst.ref_id}>
                            {inst.stock_name} ({inst.derivative_type})
                          </option>
                        ))}
                      </select>

                      {/* Multiplier weight */}
                      <input
                        type="number"
                        placeholder="Weight"
                        value={leg.unitQty}
                        onChange={(e) => updateLeg(idx, "unitQty", parseInt(e.target.value, 10))}
                        className="w-16 bg-brand-card border border-brand-border text-[10px] text-white rounded p-1.5 focus:outline-none font-mono text-center"
                      />

                      <button
                        type="button"
                        onClick={() => removeLeg(idx)}
                        className="p-1.5 hover:bg-brand-red/10 text-brand-red rounded cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Shared parameters */}
              <div className="grid grid-cols-2 gap-3 border-t border-brand-border pt-3">
                <div>
                  <label className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider mb-1">Base Qty</label>
                  <input
                    type="number"
                    value={qty}
                    onChange={(e) => setQty(parseInt(e.target.value, 10))}
                    className="w-full bg-black border border-brand-border rounded p-2 text-xs text-white focus:outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider mb-1">Strategy Price (Net)</label>
                  <input
                    type="text"
                    value={entryPrice}
                    onChange={(e) => setEntryPrice(e.target.value)}
                    className="w-full bg-black border border-brand-border rounded p-2 text-xs text-white focus:outline-none font-mono"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Submit Execution */}
        <div className="pt-4 mt-4 border-t border-brand-border">
          <button
            type="submit"
            disabled={isLoading || (orderType === "SINGLE" && !selectedInstrument)}
            className="w-full py-3 bg-white hover:bg-gray-100 text-black rounded text-xs font-bold font-mono tracking-wider uppercase transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
          >
            <Landmark className="h-4 w-4 text-black" />
            {isLoading ? "Executing..." : "Transmit Order to Exchange"}
          </button>
        </div>
      </form>
    </div>
  );
}
