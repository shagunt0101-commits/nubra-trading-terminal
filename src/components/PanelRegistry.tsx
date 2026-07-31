import React from "react";
import { LayoutPanel, PanelZone } from "../hooks/useLayoutManager";
import { Layers, BarChart2, Zap, Activity, Sparkles, ShoppingBag, ClipboardList, TrendingUp, Menu, Grid, Flame, Search, Layout } from "lucide-react";

// Panel IDs - must match layout state
export const PANEL_IDS = {
  // Left sidebar
  SCREENER: "SCREENER",
  GLOBAL_SENTIMENT: "GLOBAL_SENTIMENT",

  // Center
  MARKET_CHART: "MARKET_CHART",
  OPTIONS_WORKSPACE: "OPTIONS_WORKSPACE",

  // Right sidebar
  AI_SIGNALS: "AI_SIGNALS",
  OPTION_BUYING: "OPTION_BUYING",
  BACKTESTER: "BACKTESTER",
  SCALPER: "SCALPER",

  // Bottom
  ORDER_DESK: "ORDER_DESK",
  ORDER_BOOK: "ORDER_BOOK",
  PORTFOLIO: "PORTFOLIO",
} as const;

export type PanelId = typeof PANEL_IDS[keyof typeof PANEL_IDS];

// Panel metadata registry
export const PANEL_REGISTRY: Record<PanelId, Omit<LayoutPanel, "component">> = {
  [PANEL_IDS.SCREENER]: {
    id: PANEL_IDS.SCREENER,
    title: "F&O Screener",
    icon: <Search className="h-4 w-4" />,
    defaultZone: "left",
    defaultOrder: 0,
    resizable: true,
    minWidth: 200,
    maxWidth: 500,
  },
  [PANEL_IDS.GLOBAL_SENTIMENT]: {
    id: PANEL_IDS.GLOBAL_SENTIMENT,
    title: "Global Sentiment",
    icon: <TrendingUp className="h-4 w-4" />,
    defaultZone: "left",
    defaultOrder: 1,
    resizable: true,
    minWidth: 200,
    maxWidth: 500,
  },
  [PANEL_IDS.MARKET_CHART]: {
    id: PANEL_IDS.MARKET_CHART,
    title: "Market Chart",
    icon: <BarChart2 className="h-4 w-4" />,
    defaultZone: "center",
    defaultOrder: 0,
  },
  [PANEL_IDS.OPTIONS_WORKSPACE]: {
    id: PANEL_IDS.OPTIONS_WORKSPACE,
    title: "Options Workspace",
    icon: <Layers className="h-4 w-4" />,
    defaultZone: "center",
    defaultOrder: 1,
  },
  [PANEL_IDS.AI_SIGNALS]: {
    id: PANEL_IDS.AI_SIGNALS,
    title: "AI Signals",
    icon: <Sparkles className="h-4 w-4" />,
    defaultZone: "right",
    defaultOrder: 0,
  },
  [PANEL_IDS.OPTION_BUYING]: {
    id: PANEL_IDS.OPTION_BUYING,
    title: "Option Buying",
    icon: <Zap className="h-4 w-4" />,
    defaultZone: "right",
    defaultOrder: 1,
  },
  [PANEL_IDS.BACKTESTER]: {
    id: PANEL_IDS.BACKTESTER,
    title: "Backtester",
    icon: <BarChart2 className="h-4 w-4" />,
    defaultZone: "right",
    defaultOrder: 2,
  },
  [PANEL_IDS.SCALPER]: {
    id: PANEL_IDS.SCALPER,
    title: "Auto Scalper",
    icon: <Activity className="h-4 w-4" />,
    defaultZone: "right",
    defaultOrder: 3,
  },
  [PANEL_IDS.ORDER_DESK]: {
    id: PANEL_IDS.ORDER_DESK,
    title: "Order Desk",
    icon: <ClipboardList className="h-4 w-4" />,
    defaultZone: "bottom",
    defaultOrder: 0,
    minHeight: 300,
  },
  [PANEL_IDS.ORDER_BOOK]: {
    id: PANEL_IDS.ORDER_BOOK,
    title: "Order Book",
    icon: <ShoppingBag className="h-4 w-4" />,
    defaultZone: "bottom",
    defaultOrder: 1,
    minHeight: 300,
  },
  [PANEL_IDS.PORTFOLIO]: {
    id: PANEL_IDS.PORTFOLIO,
    title: "Portfolio",
    icon: <Layout className="h-4 w-4" />,
    defaultZone: "bottom",
    defaultOrder: 2,
    minHeight: 300,
  },
};

// Get panel by ID
export function getPanelMeta(id: PanelId) {
  return PANEL_REGISTRY[id];
}

// Get all panel IDs in a zone by default order
export function getDefaultPanelsForZone(zone: PanelZone): PanelId[] {
  return Object.values(PANEL_REGISTRY)
    .filter(p => p.defaultZone === zone)
    .sort((a, b) => a.defaultOrder - b.defaultOrder)
    .map(p => p.id);
}

// Default layout state
export const DEFAULT_LAYOUT_STATE = {
  left: getDefaultPanelsForZone("left"),
  center: getDefaultPanelsForZone("center"),
  right: getDefaultPanelsForZone("right"),
  bottom: getDefaultPanelsForZone("bottom"),
};