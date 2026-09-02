#!/usr/bin/env node
/**
 * 比對「線上宣告的 NIP-11 limitation」與「src/limits.ts 實際的常數」。
 *
 *   node tools/check-nip11.mjs [baseUrl]     預設 http://127.0.0.1:8787
 *
 * 為什麼要有這支:一份**會說謊的**能力宣告比沒有更糟——客戶端會照它調參數,然後在
 * 真正的閘門上撞牆,而那種錯只顯示成莫名其妙的 `NOTICE`。單元測試鎖的是
 * 「產生器用了 limits.ts 的常數」;這支鎖的是「**真的跑起來、經過網路之後**還是那些值」。
 */
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';

/** 從原始碼撈 `export const NAME = <算式>;`,用 Function 求值(支援 `15 * 60` 這種) */
function constFromSource(src, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`).exec(src);
  if (!m) return null;
  try {
    return Function(`return (${m[1]})`)();
  } catch {
    return null;
  }
}

const src = readFileSync(new URL('../src/limits.ts', import.meta.url), 'utf8');
const res = await fetch(`${BASE}/`, { headers: { Accept: 'application/nostr+json' } });
const ct = res.headers.get('content-type') ?? '';
const info = await res.json();

const rows = [
  ['max_message_length', 'MAX_FRAME'],
  ['max_subscriptions', 'MAX_SUBS_PER_SOCKET'],
  ['max_subid_length', 'SUBID_MAX'],
  ['max_event_tags', 'MAX_TAGS_PER_EVENT'],
];

let bad = 0;
const fail = (msg) => {
  bad++;
  console.log(`  FAIL  ${msg}`);
};

console.log(`=== ${BASE} 的 NIP-11 宣告 vs src/limits.ts ===`);
for (const [field, constant] of rows) {
  const served = info.limitation?.[field];
  const actual = constFromSource(src, constant);
  if (actual === null) fail(`${field}: 在原始碼裡找不到 ${constant}`);
  else if (served !== actual) fail(`${field}: 宣告 ${served} 但實際是 ${constant}=${actual}`);
  else console.log(`  PASS  ${field.padEnd(20)} ${String(served).padStart(6)}  = ${constant}`);
}

// 規格表外但刻意宣告的
if (info.limitation?.max_filters !== 1) fail('max_filters 應為 1(我們拒收多 filter 的 REQ)');
else console.log(`  PASS  ${'max_filters'.padEnd(20)}      1  (刻意:規格表外的擴充欄位)`);

// 刻意不填的三項(查過規格才決定的,見 src/nip11.ts 檔頭)
if ('retention' in info) fail('出現 retention —— NIP-11 沒有這個欄位');
else console.log('  PASS  沒有 retention');
if ('created_at_lower_limit' in (info.limitation ?? {}) || 'created_at_upper_limit' in (info.limitation ?? {}))
  fail('出現 created_at_* —— 規格沒定義是絕對時戳還是相對偏移,填了會被誤讀');
else console.log('  PASS  沒有 created_at_*');

// HTTP 層
if (!ct.includes('application/nostr+json')) fail(`Content-Type 是 "${ct}"`);
else console.log(`  PASS  Content-Type   ${ct}`);
for (const h of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods']) {
  if (!res.headers.get(h)) fail(`缺 ${h}(NIP-11 明文 MUST)`);
  else console.log(`  PASS  ${h.padEnd(30)} ${res.headers.get(h)}`);
}
if (!Array.isArray(info.supported_nips) || !info.supported_nips.includes(11)) fail('supported_nips 不含 11');
else console.log(`  PASS  supported_nips  ${JSON.stringify(info.supported_nips)}`);

console.log(`\n  name = ${info.name}`);
console.log(bad ? `\n${bad} 項不合格` : '\n宣告與實作完全一致');
process.exit(bad ? 1 : 0);
