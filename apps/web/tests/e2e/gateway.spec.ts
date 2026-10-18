import { expect, test } from '@playwright/test';

// The real local gateway (not the mock), reached through the dev server's proxy like the app
// does. No market data is requested, so nothing goes out to an exchange.

test('the gateway answers health checks through the dev server', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ status: 'ok', protocolVersion: 2 });
});

test('the gateway greets a WebSocket from the app origin', async ({ page }) => {
  await page.goto('/api/health'); // a same-origin page that doesn't start the app
  const hello = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onmessage = (event) => {
          resolve(String(event.data));
          socket.close();
        };
        socket.onerror = () => reject(new Error('WebSocket failed'));
      }),
  );
  expect(JSON.parse(hello)).toMatchObject({ type: 'hello', protocolVersion: 2 });
});
