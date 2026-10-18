import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';
import type { ConnectionStatus, GatewayConnection } from './GatewayConnection';

const GatewayContext = createContext<GatewayConnection | null>(null);

export function GatewayProvider({
  connection,
  children,
}: {
  connection: GatewayConnection;
  children: ReactNode;
}) {
  return <GatewayContext.Provider value={connection}>{children}</GatewayContext.Provider>;
}

export function useGateway(): GatewayConnection {
  const connection = useContext(GatewayContext);
  if (!connection) throw new Error('useGateway needs a <GatewayProvider>');
  return connection;
}

/** Live status of the UI's connection to the local gateway. */
export function useGatewayStatus(): ConnectionStatus {
  const connection = useGateway();
  return useSyncExternalStore(connection.subscribeStatus, connection.getStatus);
}
