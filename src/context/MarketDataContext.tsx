import React, { createContext, useContext, useState, ReactNode, useCallback } from "react";
import { Instrument, ChartDataPoint, OptionChainData } from "../types";

interface MarketDataContextType {
  selectedInstrument: Instrument | null;
  setSelectedInstrument: (inst: Instrument | null) => void;
  chartData: ChartDataPoint[];
  setChartData: (data: ChartDataPoint[]) => void;
  optionChainData: OptionChainData | null;
  setOptionChainData: (data: OptionChainData | null) => void;
  initializeDefaultInstrument: (instruments: Instrument[]) => void;
}

const MarketDataContext = createContext<MarketDataContextType | undefined>(undefined);

export function MarketDataProvider({ children }: { children: ReactNode }) {
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument | null>(null);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [optionChainData, setOptionChainData] = useState<OptionChainData | null>(null);

  const initializeDefaultInstrument = useCallback((instruments: Instrument[]) => {
    if (!selectedInstrument) {
      const niftyInst = instruments.find((i) => i.asset === "NIFTY" && i.derivative_type !== "OPT");
      if (niftyInst) {
        setSelectedInstrument(niftyInst);
      }
    }
  }, [selectedInstrument, setSelectedInstrument]);

  return (
    <MarketDataContext.Provider
      value={{
        selectedInstrument,
        setSelectedInstrument,
        chartData,
        setChartData,
        optionChainData,
        setOptionChainData,
        initializeDefaultInstrument,
      }}
    >
      {children}
    </MarketDataContext.Provider>
  );
}

export function useMarketData() {
  const context = useContext(MarketDataContext);
  if (!context) {
    throw new Error("useMarketData must be used within a MarketDataProvider");
  }
  return context;
}
