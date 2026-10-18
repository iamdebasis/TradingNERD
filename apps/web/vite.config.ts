import { API_PREFIX, GATEWAY_DEFAULT_PORT, WEB_DEV_PORT, WS_PATH } from '@tradingnerd/core';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const gatewayUrl = `http://127.0.0.1:${Number(process.env.GATEWAY_PORT || GATEWAY_DEFAULT_PORT)}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: WEB_DEV_PORT,
    strictPort: true,
    // Same-origin access to the gateway: the browser only ever talks to the dev server.
    proxy: {
      [API_PREFIX]: { target: gatewayUrl },
      [WS_PATH]: { target: gatewayUrl, ws: true },
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
