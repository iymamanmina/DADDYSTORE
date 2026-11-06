import assert from 'node:assert/strict';
import handler from '../netlify/functions/api.mjs';

const checks = [
  { url: 'https://daddys-store.netlify.app/api/health', method: 'GET', expected: 200 },
  { url: 'https://daddys-store.netlify.app/.netlify/functions/api/health', method: 'GET', expected: 200 },
  { url: 'https://daddys-store.netlify.app/api/admin/me', method: 'GET', expected: 401 },
  { url: 'https://daddys-store.netlify.app/api/not-a-route', method: 'GET', expected: 404 },
];
for (const item of checks) {
  const response = await handler(new Request(item.url, { method: item.method }), {});
  assert.equal(response.status, item.expected, `${item.method} ${new URL(item.url).pathname}`);
  const data = await response.json();
  if (item.url.endsWith('/api/health') || item.url.includes('/.netlify/functions/api/health')) assert.equal(data.status, 'ok');
  console.log(`PASS ${item.method} ${new URL(item.url).pathname} -> ${response.status}`);
}