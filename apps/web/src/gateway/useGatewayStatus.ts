import { parseServerMessage, WS_PATH } from '@tradingnerd/core';
import { useEffect, useState } from 'react';
import { reconnectDelay } from './reconnect';

export type GatewayStatus = 'connecting' | 'connected' | 'disconnected';

/** Keeps a WebSocket open to the local gateway and reports its state, reconnecting with backoff. */
export function useGatewayStatus(): GatewayStatus {
  const [status, setStatus] = useState<GatewayStatus>('connecting');

  useEffect(() => {
    let socket: WebSocket | null = null;
    let attempt = 0;
    let disposed = false;

    const connect = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${window.location.host}${WS_PATH}`);
      socket.addEventListener('message', (event) => {
        if (parseServerMessage(String(event.data))?.type === 'hello') {
          attempt = 0;
          setStatus('connected');
        }
      });
      socket.addEventListener('close', () => {
        if (disposed) return;
        setStatus('disconnected');
        timer = window.setTimeout(connect, reconnectDelay(attempt++));
      });
    };

    // Deferred, so React StrictMode's dev-only mount → unmount → mount never opens a socket
    // only to close it before it connects.
    let timer = window.setTimeout(connect, 0);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return status;
}
