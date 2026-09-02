#!/usr/bin/env node
// Hand-rolled NIP-01 exchange against a running relay (default ws://127.0.0.1:8787/).
// Phase-2 proof: A subscribes, B publishes, A receives, and B receives its own event (no skip-self).
// Usage: node tools/smoke-nip01.mjs [wsUrl]
import { createHash } from 'node:crypto';

const URL_ = process.argv[2] ?? 'ws://127.0.0.1:8787/';
const KIND = 22690;
const TOPIC = '2p4n6g54165w2j74s1b6cn4q0233c362f4m1n';
const now = () => Math.floor(Date.now() / 1000);
const hex = (n) => Array.from({ length: n }, (_, i) => (i % 16).toString(16)).join('');

const open = (name) => new Promise((res, rej) => {
  const ws = new WebSocket(URL_);
  const frames = [];
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  ws.onopen = () => res({ name, ws, frames, send: (x) => ws.send(JSON.stringify(x)) });
  ws.onerror = (e) => rej(new Error(`${name} failed to open: ${e.message ?? e}`));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (c, pred, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const f = c.frames.find(pred); if (f) return f; await sleep(20); }
  return null;
};
const mkEvent = (content, tamper = false) => {
  const e = { kind: KIND, tags: [['x', TOPIC]], created_at: now(), content, pubkey: hex(64) };
  const id = createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
  return { ...e, id: tamper ? id.replace(/^./, id[0] === '0' ? '1' : '0') : id, sig: '0'.repeat(128) };
};

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

const A = await open('A');
const B = await open('B');

// 1. REQ -> EOSE (no history)
A.send(['REQ', 'subA', { kinds: [KIND], since: now() - 60, '#x': [TOPIC] }]);
B.send(['REQ', 'subB', { kinds: [KIND], since: now() - 60, '#x': [TOPIC] }]);
check('REQ -> EOSE (A)', !!(await waitFor(A, (f) => f[0] === 'EOSE' && f[1] === 'subA')));
check('REQ -> EOSE (B)', !!(await waitFor(B, (f) => f[0] === 'EOSE' && f[1] === 'subB')));

// 2. B publishes: A receives; B receives its own (echo); B gets OK true
const ev = mkEvent('hello-from-B');
B.send(['EVENT', ev]);
const aGot = await waitFor(A, (f) => f[0] === 'EVENT' && f[1] === 'subA' && f[2]?.id === ev.id);
const bGot = await waitFor(B, (f) => f[0] === 'EVENT' && f[1] === 'subB' && f[2]?.id === ev.id);
const bOk = await waitFor(B, (f) => f[0] === 'OK' && f[1] === ev.id);
check('A receives EVENT on subA', !!aGot);
check('B receives its OWN event back (no skip-self)', !!bGot);
check('B gets OK true', !!bOk && bOk[2] === true, JSON.stringify(bOk));
check('tags forwarded verbatim', !!aGot && JSON.stringify(aGot[2].tags) === JSON.stringify(ev.tags));

// 3. tampered id -> OK false invalid
const bad = mkEvent('tampered', true);
B.send(['EVENT', bad]);
const badOk = await waitFor(B, (f) => f[0] === 'OK' && f[1] === bad.id);
check('tampered id -> OK false invalid:', !!badOk && badOk[2] === false && String(badOk[3]).startsWith('invalid:'), JSON.stringify(badOk));
check('tampered event NOT fanned out', !(await waitFor(A, (f) => f[0] === 'EVENT' && f[2]?.id === bad.id, 300)));

// 4. bad filter -> NOTICE invalid: filter ; bad JSON -> silence
const beforeNotice = A.frames.length;
A.send(['REQ', 'subBad', { kinds: [1], '#x': [TOPIC] }]);
const notice = await waitFor(A, (f) => f[0] === 'NOTICE');
check('bad filter -> NOTICE invalid: filter', !!notice && String(notice[1]).includes('filter'), JSON.stringify(notice));
const beforeJunk = A.frames.length;
A.ws.send('{not json');
await sleep(300);
check('bad JSON -> silent', A.frames.length === beforeJunk);
void beforeNotice;

// 5. other topic does not match
const other = { ...mkEvent('other-room'), tags: [['x', 'zzz-other-topic']] };
other.id = createHash('sha256').update(JSON.stringify([0, other.pubkey, other.created_at, other.kind, other.tags, other.content])).digest('hex');
B.send(['EVENT', other]);
check('other topic: B gets OK true but nobody fanned out', !!(await waitFor(B, (f) => f[0] === 'OK' && f[1] === other.id && f[2] === true)) && !(await waitFor(A, (f) => f[0] === 'EVENT' && f[2]?.id === other.id, 300)));

// 6. CLOSE subA -> A no longer receives; B still echoes
A.send(['CLOSE', 'subA']);
await sleep(100);
const ev2 = mkEvent('after-close');
B.send(['EVENT', ev2]);
check('after CLOSE, A receives nothing', !(await waitFor(A, (f) => f[0] === 'EVENT' && f[2]?.id === ev2.id, 400)));
check('after CLOSE, B still gets its echo', !!(await waitFor(B, (f) => f[0] === 'EVENT' && f[2]?.id === ev2.id)));

// 7. rate limit: blast 60 events fast -> at least one OK false rate-limited
const C = await open('C');
const ids = [];
for (let i = 0; i < 60; i++) { const e = mkEvent(`burst-${i}`); ids.push(e.id); C.send(['EVENT', e]); }
await sleep(800);
const limited = C.frames.filter((f) => f[0] === 'OK' && f[2] === false && String(f[3]).startsWith('rate-limited'));
const accepted = C.frames.filter((f) => f[0] === 'OK' && f[2] === true);
check('burst of 60: some rate-limited, ~40 accepted', limited.length > 0 && accepted.length >= 35 && accepted.length <= 45, `accepted=${accepted.length} limited=${limited.length}`);

for (const c of [A, B, C]) c.ws.close();

let fail = 0;
for (const r of results) { if (!r.ok) fail++; console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   ' + r.detail : ''}`); }
console.log(fail ? `\n${fail} FAILED` : `\nall ${results.length} passed`);
process.exit(fail ? 1 : 0);
