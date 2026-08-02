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

  // Callbacks live in refs so connect() stays stable — the parent re-creates
  // them every render (2s WS tick re-renders App); if connect's identity chases
  // them, each render tears down and reopens the socket (reconnect storm) and
  // every cleanup leaks a reconnect timer that spawns duplicate sockets.
  const onQuotesRef = useRef(onQuotes);
  onQuotesRef.current = onQuotes;
  const onPremiumRef = useRef(onPremium);
  onPremiumRef.current = onPremium;

  const connect = useCallback(() => {
    // A new socket is already live (or one is mid-handshake) — never stack.
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    const ws = new WebSocket(url);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "quotes" && msg.data) {
          onQuotesRef.current(msg.data);
          if (onPremiumRef.current && msg.premium) {
            onPremiumRef.current(msg.premium);
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
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
      // Deliberate close must not schedule a reconnect: mark null after close
      // so the onclose handler sees an intentional teardown and bails.
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch { /* already closed */ }
      }
    };
  }, [connect]);
}