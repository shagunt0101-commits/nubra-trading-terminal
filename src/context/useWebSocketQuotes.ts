import { useEffect, useRef, useCallback } from "react";

interface QuoteEntry {
  price: number;
  prev_close: number;
  change: number;
}

interface PremiumEntry {
  ltp: number;
  strike: number;
  optType: string;
}

const RECONNECT_DELAY = 3000;

export function useWebSocketQuotes(
  onQuotes: (quotes: Record<string, QuoteEntry>) => void,
  onPremium?: (premium: PremiumEntry | null) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    const ws = new WebSocket(url);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "quotes" && msg.data) {
          onQuotes(msg.data);
          if (onPremium && msg.premium) {
            onPremium(msg.premium);
          }
        }
      } catch { /* ignore bad frames */ }
    };

    ws.onclose = () => {
      wsRef.current = null;
      timerRef.current = setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = () => ws.close();
    wsRef.current = ws;
  }, [onQuotes, onPremium]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);
}
