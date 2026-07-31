import { useState, useCallback, useRef } from "react";

const STORAGE_PREFIX = "panel-order-";

interface DragItem {
  index: number;
}

/** Generic DnD reorder with localStorage persistence. Returns [order, handlers, reset]. */
export function useDragReorder<T extends string>(
  storageKey: string,
  defaults: readonly T[],
): [T[],
  {
    onDragStart: (index: number) => (e: React.DragEvent) => void;
    onDragOver: (index: number) => (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
    isDragging: (index: number) => boolean;
  },
  () => void
] {
  const saved = (() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as T[];
        if (Array.isArray(parsed) && parsed.length === defaults.length && parsed.every((k) => defaults.includes(k)))
          return parsed;
      }
    } catch {}
    return [...defaults];
  })();

  const [order, setOrder] = useState<T[]>(saved);
  const dragIndex = useRef<number | null>(null);
  const dropIndex = useRef<number | null>(null);

  const save = useCallback((items: T[]) => {
    setOrder(items);
    localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(items));
  }, [storageKey]);

  const reset = useCallback(() => {
    save([...defaults]);
  }, [save, defaults]);

  const onDragStart = useCallback((index: number) => (e: React.DragEvent) => {
    dragIndex.current = index;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    (e.currentTarget as HTMLElement).classList.add("opacity-40");
  }, []);

  const onDragOver = useCallback((index: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dropIndex.current = index;
  }, []);

  const onDragEnd = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove("opacity-40");
    const from = dragIndex.current;
    const to = dropIndex.current;
    dragIndex.current = null;
    dropIndex.current = null;
    if (from === null || to === null || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    save(next);
  }, [order, save]);

  const isDragging = useCallback((index: number) => index === dragIndex.current, []);

  return [order, { onDragStart, onDragOver, onDragEnd, isDragging }, reset];
}
