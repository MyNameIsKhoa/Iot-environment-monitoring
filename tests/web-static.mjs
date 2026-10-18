import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
const firmware = readFileSync(new URL('../warehouse_monitor_esp8266/warehouse_monitor_esp8266.ino', import.meta.url), 'utf8');
for (const id of new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))) {
  assert.ok(html.includes(`id="${id}"`), `Missing HTML id: ${id}`);
}
for (const field of ['temperatureC', 'humidityPct', 'dustAdc', 'dustDeltaAdc', 'dustLevel', 'status', 'timestamp']) {
  assert.ok(firmware.includes(`data["${field}"]`), `Missing firmware field: ${field}`);
  assert.ok(app.includes(field), `Missing web field: ${field}`);
}
assert.match(app, /limitToLast\(size\)/);
assert.match(app, /orderByChild\('timestamp'\)/);
assert.match(app, /devices\/warehouse01/);
assert.doesNotMatch(firmware, /const char\* WIFI_PASSWORD = /);
assert.doesNotMatch(html, /Xem dữ liệu giả|\?demo=/i);
assert.doesNotMatch(app, /demoData|demoRows|startDemo|\?demo=/i);
console.log('Web schema, bounded queries and secret extraction OK');
