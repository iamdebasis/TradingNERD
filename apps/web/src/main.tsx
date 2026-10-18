import { WS_PATH } from '@tradingnerd/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { chartRoute } from './chart/route';
import { GatewayConnection, gatewaySocketUrl } from './data/GatewayConnection';
import { applyTheme } from './theme/cssVariables';
import { darkTheme } from './theme/tokens';
import './styles/global.css';

applyTheme(document.documentElement, darkTheme);

// One connection for the whole page, created outside React so StrictMode's double effects in
// development never open and close extra sockets.
const gateway = new GatewayConnection(gatewaySocketUrl(window.location, WS_PATH));
gateway.start();

const root = document.getElementById('root');
if (!root) throw new Error('#root element is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App gateway={gateway} route={chartRoute(window.location.search)} />
  </StrictMode>,
);
