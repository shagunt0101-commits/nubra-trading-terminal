import React, { useState, useCallback, useRef, useEffect } from "react";

interface Props {
  side: "left" | "right";
  minW: number;
  maxW: number;
  leftPanelWidth: number;
  rightPanelWidth: number;
  onResizeLeft: (w: number) => void;
  onResizeRight: (w: number) => void;
}

export default function PanelResizer({ side, minW, maxW, leftPanelWidth, rightPanelWidth, onResizeLeft, onResizeRight }: Props) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = side === "left" ? leftPanelWidth : rightPanelWidth;
    e.preventDefault();
  }, [side, leftPanelWidth, rightPanelWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = side === "left" ? e.clientX - startX.current : startX.current - e.clientX;
      const newW = Math.max(minW, Math.min(maxW, startW.current + delta));
      if (side === "left") onResizeLeft(newW); else onResizeRight(newW);
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [side, minW, maxW, onResizeLeft, onResizeRight]);

  return (
    <div className="w-[5px] cursor-col-resize shrink-0 relative group self-stretch flex items-center" onMouseDown={onMouseDown}>
      <div className="w-[3px] h-8 rounded-full bg-white/6 group-hover:bg-indigo-500 group-active:bg-indigo-400 transition-colors" />
    </div>
  );
}