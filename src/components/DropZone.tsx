import React, { useState, useCallback, useRef } from "react";
import { Plus, GripVertical, X, Maximize2, Minimize2, RotateCcw } from "lucide-react";

interface DropZoneProps {
  zone: "left" | "center" | "right" | "bottom";
  panels: React.ReactNode[];
  onDragOver: (e: React.DragEvent, zone: string, index: number) => void;
  onDrop: (e: React.DragEvent, zone: string, index: number) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  isDragTarget?: boolean;
  className?: string;
  direction?: "vertical" | "horizontal";
  showAddButton?: boolean;
  onAddPanel?: (zone: string) => void;
  droppable?: boolean;
}

export default function DropZone({
  zone,
  panels,
  onDragOver,
  onDrop,
  onDragLeave,
  isDragTarget = false,
  className = "",
  direction = "vertical",
  showAddButton = false,
  onAddPanel,
  droppable = true,
}: DropZoneProps) {
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dropTargetRef = useRef<HTMLDivElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!droppable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const target = dropTargetRef.current;
    if (!target) return;

    const rect = target.getBoundingClientRect();
    const children = Array.from(target.children).filter(el =>
      (el as HTMLElement).dataset.panelId
    );

    let index = children.length;
    if (direction === "vertical") {
      const y = e.clientY - rect.top;
      for (let i = 0; i < children.length; i++) {
        const childRect = children[i].getBoundingClientRect();
        if (y < childRect.top + childRect.height / 2) {
          index = i;
          break;
        }
      }
    } else {
      const x = e.clientX - rect.left;
      for (let i = 0; i < children.length; i++) {
        const childRect = children[i].getBoundingClientRect();
        if (x < childRect.left + childRect.width / 2) {
          index = i;
          break;
        }
      }
    }

    setDragOverIndex(index);
    onDragOver(e, zone, index);
  }, [droppable, direction, onDragOver, zone]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!dropTargetRef.current?.contains(e.relatedTarget as Node)) {
      setDragOverIndex(null);
    }
    onDragLeave?.(e);
  }, [onDragLeave]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!droppable) return;
    e.preventDefault();
    setDragOverIndex(null);
    onDrop(e, zone, dragOverIndex ?? panels.length);
  }, [droppable, onDrop, zone, dragOverIndex, panels.length]);

  return (
    <div
      ref={dropTargetRef}
      className={`flex-1 min-w-0 transition-all duration-200 ${
        direction === "vertical" ? "flex flex-col" : "flex flex-row"
      } ${className}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-zone={zone}
    >
      {panels.map((panel, i) => (
        <React.Fragment key={i}>
          {dragOverIndex === i && droppable && (
            <div
              className={`h-2 w-full bg-indigo-500/50 border-dashed border-2 border-indigo-500/50 transition-all ${
                direction === "horizontal" ? "h-full w-2" : ""
              }`}
              data-drop-indicator
            />
          )}
          {panel}
          {dragOverIndex === i + 1 && i === panels.length - 1 && droppable && (
            <div
              className={`h-2 w-full bg-indigo-500/50 border-dashed border-2 border-indigo-500/50 transition-all ${
                direction === "horizontal" ? "h-full w-2" : ""
              }`}
              data-drop-indicator
            />
          )}
        </React.Fragment>
      ))}

      {panels.length === 0 && droppable && (
        <div
          className={`flex items-center justify-center min-h-[100px] border-2 border-dashed border-white/10 rounded-xl bg-black/20 transition-colors ${
            isDragTarget ? "border-indigo-500/50 bg-indigo-500/10" : ""
          } ${direction === "horizontal" ? "min-w-[100px]" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="text-center p-4 text-slate-500">
            <GripVertical className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-xs font-mono">Drop panels here</p>
            {showAddButton && onAddPanel && (
              <button
                onClick={(e) => { e.stopPropagation(); onAddPanel(zone); }}
                className="mt-2 px-3 py-1 text-[10px] bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 rounded hover:bg-indigo-600/30 transition-colors"
              >
                + Add Panel
              </button>
            )}
          </div>
        </div>
      )}

      {panels.length > 0 && showAddButton && onAddPanel && (
        <div className="flex items-center justify-center py-2">
          <button
            onClick={(e) => { e.stopPropagation(); onAddPanel(zone); }}
            className="px-2 py-1 text-[10px] bg-white/5 text-slate-400 border border-white/10 rounded hover:bg-white/10 transition-colors flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        </div>
      )}
    </div>
  );
}