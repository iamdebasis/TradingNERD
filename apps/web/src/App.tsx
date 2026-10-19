import type { ChartRoute } from './chart/route';
import type { GatewayConnection } from './data/GatewayConnection';
import { GatewayProvider } from './data/GatewayContext';
import { AppShell } from './layout/AppShell';
import { LogoProvider } from './logos/LogoContext';

export function App({ gateway, route }: { gateway: GatewayConnection; route: ChartRoute }) {
  return (
    <GatewayProvider connection={gateway}>
      <LogoProvider>
        <AppShell route={route} />
      </LogoProvider>
    </GatewayProvider>
  );
}
