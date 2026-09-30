import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { PanelId } from "../components/PanelRegistry";

export type PanelZone = "left" | "center" | "right" | "bottom";

export interface LayoutPanel {
  id: PanelId;
  title: string;
  icon?: React.ReactNode;
  defaultZone: PanelZone;
  defaultOrder: number;
  resizable?: boolean;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  component?: React.ComponentType<any>;
}

interface LayoutState {
  left: PanelId[];
  center: PanelId[];
  right: PanelId[];
  bottom: PanelId[];
}

interface PanelSizes {
  left: number;
  right: number;
}

const STORAGE_KEY = "workspace-layout-v2";
const DEFAULT_SIZES: PanelSizes = { left: 260, right: 380 };
const PANEL_MIN = { left: 180, right: 240 };
const PANEL_MAX = { left: 450, right: 600 };

const DEFAULT_LAYOUT: LayoutState = {
  left: [],
  center: [],
  right: [],
  bottom: [],
};

function getDefaultPanelsForZone(zone: PanelZone, registry: Record<string, LayoutPanel>): string[] {
  return Object.values(registry)
    .filter(p => p.defaultZone === zone)
    .sort((a, b) => a.defaultOrder - b.defaultOrder)
    .map(p => p.id);
}

export function useLayoutManager(
  panelRegistry: Record<string, LayoutPanel>,
  onLayoutChange?: (layout: LayoutState) => void
) {
  const [layout, setLayout] = useState<LayoutState>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<LayoutState>;
        const defaults = {} as LayoutState;
        (Object.keys(DEFAULT_LAYOUT) as PanelZone[]).forEach(zone => {
          defaults[zone] = (parsed[zone]?.length ? parsed[zone] : getDefaultPanelsForZone(zone, panelRegistry)) as PanelId[];
        });
        return defaults;
      }
    } catch {}
    const initial = {} as LayoutState;
    (Object.keys(DEFAULT_LAYOUT) as PanelZone[]).forEach(zone => {
      initial[zone] = getDefaultPanelsForZone(zone, panelRegistry) as PanelId[];
    });
    return initial;
  });

  const [panelSizes, setPanelSizes] = useState<PanelSizes>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY + "-sizes");
      if (saved) return JSON.parse(saved);
    } catch {}
    return DEFAULT_SIZES;
  });

  const [collapsedPanels, setCollapsedPanels] = useState<Set<string>>(new Set());
  const [maximizedPanel, setMaximizedPanel] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    panelId: string | null;
    sourceZone: PanelZone | null;
    sourceIndex: number | null;
    isDragging: boolean;
    dragOverZone: PanelZone | null;
    dragOverIndex: number | null;
  }>({
    panelId: null,
    sourceZone: null,
    sourceIndex: null,
    isDragging: false,
    dragOverZone: null,
    dragOverIndex: null,
  });

  const dragRef = useRef<{
    startX: number;
    startY: number;
    panelRect: DOMRect | null;
  }>({ startX: 0, startY: 0, panelRect: null });

  // Persist layout
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    onLayoutChange?.(layout);
  }, [layout, onLayoutChange]);

  // Persist sizes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY + "-sizes", JSON.stringify(panelSizes));
  }, [panelSizes]);

  // Drag handlers
  const handleDragStart = useCallback((
    e: React.DragEvent,
    panelId: string,
    zone: PanelZone,
    index: number
  ) => {
    const panel = e.currentTarget as HTMLElement;
    dragRef.current.panelRect = panel.getBoundingClientRect();
    dragRef.current.startX = e.clientX;
    dragRef.current.startY = e.clientY;

    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", panelId);

    setDragState({
      panelId,
      sourceZone: zone,
      sourceIndex: index,
      isDragging: true,
      dragOverZone: zone,
      dragOverIndex: index,
    });
  }, []);

  const handleDragOver = useCallback((
    e: React.DragEvent,
    zone: PanelZone,
    index: number
  ) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const isExternal = !e.dataTransfer.types.includes("text/plain");
    if (isExternal) return;

    setDragState(prev => ({
      ...prev,
      dragOverZone: zone,
      dragOverIndex: index,
    }));
  }, []);

  const handleDragLeave = useCallback((
    e: React.DragEvent,
    zone: PanelZone
  ) => {
    const relatedTarget = e.relatedTarget as HTMLElement;
    const dropZone = e.currentTarget as HTMLElement;

    if (!dropZone.contains(relatedTarget)) {
      setDragState(prev => ({
        ...prev,
        dragOverZone: prev.dragOverZone === zone ? null : prev.dragOverZone,
        dragOverIndex: prev.dragOverZone === zone ? null : prev.dragOverIndex,
      }));
    }
  }, []);

  const handleDrop = useCallback((
    e: React.DragEvent,
    targetZone: PanelZone,
    targetIndex: number
  ) => {
    e.preventDefault();

    const { panelId, sourceZone, sourceIndex } = dragState;
    if (!panelId || sourceZone === null || sourceIndex === null) return;

    const newLayout = { ...layout };
    const sourceArray = [...newLayout[sourceZone]];
    const [movedPanel] = sourceArray.splice(sourceIndex, 1);

    if (sourceZone === targetZone) {
      // Reorder within same zone
      const targetArray = sourceArray;
      const insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
      targetArray.splice(insertIndex, 0, movedPanel);
      newLayout[targetZone] = targetArray;
    } else {
      // Move between zones
      const targetArray = [...newLayout[targetZone]];
      targetArray.splice(targetIndex, 0, movedPanel);
      newLayout[sourceZone] = sourceArray;
      newLayout[targetZone] = targetArray;
    }

    setLayout(newLayout);
    setDragState({
      panelId: null,
      sourceZone: null,
      sourceIndex: null,
      isDragging: false,
      dragOverZone: null,
      dragOverIndex: null,
    });
  }, [dragState, layout]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove("opacity-40");
    setDragState({
      panelId: null,
      sourceZone: null,
      sourceIndex: null,
      isDragging: false,
      dragOverZone: null,
      dragOverIndex: null,
    });
  }, []);

  // Panel size resize handlers
  const handleResizeLeft = useCallback((width: number) => {
    setPanelSizes(prev => ({ ...prev, left: Math.max(PANEL_MIN.left, Math.min(PANEL_MAX.left, width)) }));
  }, []);

  const handleResizeRight = useCallback((width: number) => {
    setPanelSizes(prev => ({ ...prev, right: Math.max(PANEL_MIN.right, Math.min(PANEL_MAX.right, width)) }));
  }, []);

  // Panel visibility
  const togglePanel = useCallback((panelId: string) => {
    setCollapsedPanels(prev => {
      const next = new Set(prev);
      if (next.has(panelId)) next.delete(panelId);
      else next.add(panelId);
      return next;
    });
  }, []);

  const closePanel = useCallback((panelId: string) => {
    setLayout(prev => {
      const next = { ...prev };
      (Object.keys(next) as PanelZone[]).forEach(zone => {
        next[zone] = next[zone].filter(id => id !== panelId);
      });
      return next;
    });
  }, []);

  const maximizePanel = useCallback((panelId: string) => {
    setMaximizedPanel(prev => prev === panelId ? null : panelId);
  }, []);

  const movePanel = useCallback((panelId: PanelId, direction: "up" | "down" | "left" | "right") => {
    setLayout(prev => {
      const next = { ...prev };
      (Object.keys(next) as PanelZone[]).forEach(zone => {
        const idx = next[zone].indexOf(panelId);
        if (idx >= 0) {
          const arr = [...next[zone]];
          const [item] = arr.splice(idx, 1);
          if (direction === "up" || direction === "left") {
            arr.splice(Math.max(0, idx - 1), 0, item);
          } else {
            arr.splice(Math.min(arr.length, idx + 1), 0, item);
          }
          next[zone] = arr;
        }
      });
      return next;
    });
  }, []);

  // Get visible panels for a zone
  const getPanelsForZone = useCallback((zone: PanelZone) => {
    return layout[zone].filter(id => !collapsedPanels.has(id));
  }, [layout, collapsedPanels]);

  // Reset to defaults
  const resetLayout = useCallback(() => {
    const defaults = {} as LayoutState;
    (Object.keys(DEFAULT_LAYOUT) as PanelZone[]).forEach(zone => {
      defaults[zone] = getDefaultPanelsForZone(zone, panelRegistry) as PanelId[];
    });
    setLayout(defaults);
    setPanelSizes(DEFAULT_SIZES);
    setCollapsedPanels(new Set());
    setMaximizedPanel(null);
  }, [panelRegistry]);

  return {
    layout,
    panelSizes,
    collapsedPanels,
    maximizedPanel,
    dragState,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
    handleResizeLeft,
    handleResizeRight,
    togglePanel,
    closePanel,
    maximizePanel,
    movePanel,
    getPanelsForZone,
    resetLayout,
    setLayout,
  };
}