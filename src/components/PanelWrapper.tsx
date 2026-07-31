import React, { useState, useCallback, useRef, useEffect } from "react";
import { GripVertical, Maximize2, Minimize2, X, ChevronLeft, ChevronRight, RotateCcw, PanelLeftClose, PanelRightOpen } from "lucide-react";

interface PanelWrapperProps {
  id: string;
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  isDragging?: boolean;
  isDragOver?: boolean;
  dragOverPosition?: "before" | "after" | "inside";
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onClose?: () => void;
  onMaximize?: () => void;
  onToggle?: () => void;
  isMaximized?: boolean;
  isCollapsed?: boolean;
  canClose?: boolean;
  canMaximize?: boolean;
  canToggle?: boolean;
  resizable?: boolean;
  resizeDirection?: "horizontal" | "vertical";
  className?: string;
  style?: React.CSSProperties;
  headerButtons?: React.ReactNode[];
}

export default function PanelWrapper({
  id,
  title,
  icon,
  children,
  isDragging = false,
  isDragOver = false,
  dragOverPosition,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onClose,
  onMaximize,
  onToggle,
  isMaximized = false,
  isCollapsed = false,
  canClose = true,
  canMaximize = true,
  canToggle = true,
  resizable = false,
  resizeDirection = "horizontal",
  className = "",
  style,
  headerButtons = [],
}: PanelWrapperProps) {
  const [isHovered, setIsHovered] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  useEffect(() => {
    if (!resizable) return;

    const handleResize = (e: MouseEvent) => {
      if (!draggingRef.current || !resizeRef.current) return;
      const delta = resizeDirection === "horizontal"
        ? e.clientX - startXRef.current
        : e.clientY - startYRef.current;
      const newSize = Math.max(200, startWidthRef.current + delta);
      resizeRef.current.style.width = `${newSize}px`;
    };

    const handleUp = () => {
      draggingRef.current = false;
      document.removeEventListener("mousemove", handleResize);
      document.removeEventListener("mouseup", handleUp);
    };

    const handleDown = (e: MouseEvent) => {
      if (!resizable) return;
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startYRef.current = e.clientY;
      startWidthRef.current = resizeRef.current?.offsetWidth || 0;
      document.addEventListener("mousemove", handleResize);
      document.addEventListener("mouseup", handleUp);
      e.preventDefault();
      e.stopPropagation();
    };

    const resizeHandle = resizeRef.current;
    if (resizeHandle) {
      resizeHandle.addEventListener("mousedown", handleDown);
    }
    return () => {
      if (resizeHandle) resizeHandle.removeEventListener("mousedown", handleDown);
    };
  }, [resizable, resizeDirection]);

  const startYRef = useRef(0);

  if (isCollapsed) return null;

  return (
    <div
      draggable={!isMaximized}
      onDragStart={(e) => {
        (e.currentTarget as HTMLElement).classList.add("opacity-40", "ring-2", "ring-indigo-500/50");
        onDragStart(e);
      }}
      onDragEnd={(e) => {
        (e.currentTarget as HTMLElement).classList.remove("opacity-40", "ring-2", "ring-indigo-500/50");
        onDragEnd(e);
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`relative group flex flex-col h-full min-h-0 transition-all duration-200 ${
        isDragging ? "opacity-40 ring-2 ring-indigo-500/50" : ""
      } ${isDragOver ? "ring-2 ring-indigo-500/30" : ""} ${className}`}
      style={style}
    >
      {!isMaximized && (
        <div
          className={`flex items-center justify-between px-3 py-2 glass-base/60 border-b border-white/6 transition-all duration-200 ${
            isDragOver
              ? dragOverPosition === "before"
                ? "border-t-2 border-indigo-500"
                : dragOverPosition === "after"
                ? "border-b-2 border-indigo-500"
                : "bg-indigo-500/10"
              : ""
          } ${isHovered ? "bg-white/5" : ""}`}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <div className="flex items-center gap-2 cursor-grab active:cursor-grabbing">
            <GripVertical className="h-4 w-4 text-slate-500 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity" />
            {icon && <span className="text-slate-300">{icon}</span>}
            <span className="font-semibold text-xs text-slate-200 truncate">{title}</span>
          </div>
          <div className="flex items-center gap-1">
            {headerButtons}
            {canToggle && onToggle && (
              <button
                onClick={(e) => { e.stopPropagation(); onToggle(); }}
                className="p-1 rounded hover:bg-white/10 transition-colors text-slate-400 hover:text-white"
                title={isCollapsed ? "Expand" : "Collapse"}
              >
                {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
              </button>
            )}
            {canMaximize && onMaximize && (
              <button
                onClick={(e) => { e.stopPropagation(); onMaximize(); }}
                className="p-1 rounded hover:bg-white/10 transition-colors text-slate-400 hover:text-white"
                title={isMaximized ? "Minimize" : "Maximize"}
              >
                {isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            )}
            {canClose && onClose && (
              <button
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                className="p-1 rounded hover:bg-red-500/20 transition-colors text-slate-400 hover:text-red-400"
                title="Remove panel"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <div
        className="flex-1 min-h-0 overflow-hidden"
        style={{ width: isMaximized ? "100%" : undefined }}
      >
        {children}
      </div>

      {resizable && !isMaximized && (
        <div
          ref={resizeRef}
          className={`absolute ${resizeDirection === "horizontal" ? "right-0 top-0 bottom-0 w-1 cursor-col-resize" : "bottom-0 left-0 right-0 h-1 cursor-row-resize"} bg-transparent hover:bg-indigo-500/30 transition-colors`}
          title="Drag to resize"
        />
      )}

      {dragOverPosition === "before" && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-indigo-500/60 pointer-events-none" />
      )}
      {dragOverPosition === "after" && (
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-indigo-500/60 pointer-events-none" />
      )}
    </div>
  );
}