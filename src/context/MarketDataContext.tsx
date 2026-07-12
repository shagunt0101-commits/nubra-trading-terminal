import React, { createContext, useContext, useState, ReactNode } from "react";
import { Instrument, ChartDataPoint } from "../types";

interface MarketDataContextType {
  selectedInstrument: Instrument | null;
  setSelectedInstrument: (inst: Instrument | null) => void;
  chartData: ChartDataPoint[];
  setChartData: (data: ChartDataPoint[]) => void;
  optionChainData: any;
  setOptionChainData: (data: any) => void;
}

const MarketDataContext = createContext<MarketDataContextType | undefined>(undefined);

export function MarketDataProvider({ children }: { children: ReactNode }) {
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument | null>(null);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [optionChainData, setOptionChainData] = useState<any>(null);

  return (
    <MarketDataContext.Provider
      value={{
        selectedInstrument,
        setSelectedInstrument,
        chartData,
        setChartData,
        optionChainData,
        setOptionChainData,
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
