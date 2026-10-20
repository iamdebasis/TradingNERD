import type { ChartRoute } from './chart/route';
import type { GatewayConnection } from './data/GatewayConnection';
import { GatewayProvider } from './data/GatewayContext';
import { AppShell } from './layout/AppShell';
import { LogoProvider } from './logos/LogoContext';
import { StockKeyProvider } from './stocks/StockKeyContext';

export function App({ gateway, route }: { gateway: GatewayConnection; route: ChartRoute }) {
  return (
    <GatewayProvider connection={gateway}>
      <LogoProvider>
        <StockKeyProvider>
          <AppShell route={route} />
        </StockKeyProvider>
      </LogoProvider>
    </GatewayProvider>
  );
}
