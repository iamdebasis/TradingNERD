import type { ChartRoute } from './chart/route';
import type { GatewayConnection } from './data/GatewayConnection';
import { GatewayProvider } from './data/GatewayContext';
import { AppShell } from './layout/AppShell';

export function App({ gateway, route }: { gateway: GatewayConnection; route: ChartRoute }) {
  return (
    <GatewayProvider connection={gateway}>
      <AppShell route={route} />
    </GatewayProvider>
  );
}
