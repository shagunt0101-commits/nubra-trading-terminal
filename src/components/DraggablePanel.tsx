import React, { useCallback } from "react";
import { GripVertical, Maximize2, Minimize2, X, Settings, Move } from "lucide-react";

interface DraggablePanelProps {
  id: string;
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  zone: "left" | "center" | "right" | "bottom";
  index: number;
  isActive?: boolean;
  onDragStart: (e: React.DragEvent, id: string, zone: string, index: number) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onClose?: (id: string) => void;
  onMaximize?: (id: string) => void;
  onMinimize?: (id: string) => void;
  onSettings?: (id: string) => void;
  onMove?: (id: string, direction: "up" | "down" | "left" | "right") => void;
  closable?: boolean;
  maximizable?: boolean;
  minimizable?: boolean;
  movable?: boolean;
  className?: string;
  style?: React.CSSProperties;
  headerClassName?: string;
}

export default function DraggablePanel({
  id,
  title,
  icon,
  children,
  zone,
  index,
  isActive = true,
  onDragStart,
  onDragEnd,
  onClose,
  onMaximize,
  onMinimize,
  onSettings,
  onMove,
  closable = true,
  maximizable = true,
  minimizable = false,
  movable = true,
  className = "",
  style,
  headerClassName = "",
}: DraggablePanelProps) {
  const [isDragging, setIsDragging] = React.useState(false);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    setIsDragging(true);
    onDragStart(e, id, zone, index);
    (e.currentTarget as HTMLElement).classList.add("opacity-40");
  }, [id, zone, index, onDragStart]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    setIsDragging(false);
    onDragEnd(e);
    (e.currentTarget as HTMLElement).classList.remove("opacity-40");
  }, [onDragEnd]);

  if (!isActive) return null;

  return (
    <div
      draggable={movable}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      className={`glass-surface border border-white/6 rounded-xl flex flex-col overflow-hidden transition-all duration-200 ${
        isDragging ? "opacity-40 ring-2 ring-indigo-500/50 scale-[1.01] shadow-2xl" : ""
      } ${className}`}
      style={{ minHeight: zone === "bottom" ? "300px" : undefined, ...style }}
      data-panel-id={id}
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between px-3 py-2 glass-base/50 border-b border-white/6 cursor-move ${headerClassName}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          {movable && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              className="p-1 text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded transition-colors"
              title="Drag to move"
              aria-label="Drag to move panel"
            >
              <Move className="h-4 w-4" />
            </button>
          )}
          {icon && <span className="text-slate-300">{icon}</span>}
          <span className="font-semibold text-sm text-slate-100 truncate">{title}</span>
          {isDragging && (
            <span className="px-2 py-0.5 text-[9px] font-mono bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded">
              DRAGGING
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onSettings && (
            <button
              onClick={(e) => { e.stopPropagation(); onSettings(id); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-1.5 text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded transition-colors"
              title="Settings"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          )}
          {minimizable && onMinimize && (
            <button
              onClick={(e) => { e.stopPropagation(); onMinimize(id); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-1.5 text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded transition-colors"
              title="Minimize"
            >
              <Minimize2 className="h-3.5 w-3.5" />
            </button>
          )}
          {maximizable && onMaximize && (
            <button
              onClick={(e) => { e.stopPropagation(); onMaximize(id); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-1.5 text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded transition-colors"
              title="Maximize"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          )}
          {closable && onClose && (
            <button
              onClick={(e) => { e.stopPropagation(); onClose(id); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
              title="Close panel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {children}
      </div>
    </div>
  );
}