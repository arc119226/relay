import { describe, expect, it } from 'vitest';
import FX from './fixtures/trystero.json';
import { CLOCK_SKEW_S, KIND_MAX, KIND_MIN } from '../src/limits';
import { eventId, parseClientMsg, serializeForId, verifyEventId, type NostrEvent } from '../src/nip01';

const A = FX.eventA as NostrEvent;
const B = FX.eventB as NostrEvent;
const NOW = A.created_at; // 伺服器時間 = fixture 產生的那一刻

describe('eventId 跟真的 Trystero 一字不差', () => {
  it('fixture 的 id 是我們算出來的 SHA-256(這條在驗「對 NIP-01 序列化的理解跟 Trystero 一致」)', async () => {
    expect(await eventId(A)).toBe(A.id);
    expect(await eventId(B)).toBe(B.id);
    expect(await verifyEventId(A)).toBe(true);
  });

  it('序列化形狀:[0, pubkey, created_at, kind, tags, content],沒有空白', () => {
    const s = serializeForId(A);
    expect(s.startsWith(`[0,"${A.pubkey}",${A.created_at},${A.kind},`)).toBe(true);
    expect(s).not.toContain(': ');
  });

  it('動了 content 一個字,id 就對不上', async () => {
    expect(await verifyEventId({ ...A, content: A.content + ' ' })).toBe(false);
  });
});

describe('parseClientMsg:EVENT', () => {
  it('真的 Trystero 事件通過,原樣保留 tags', () => {
    const r = parseClientMsg(JSON.parse(FX.raw.eventA), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || r.msg.t !== 'event') return;
    expect(r.msg.event.id).toBe(A.id);
    expect(r.msg.event.tags).toEqual(A.tags);
    expect(r.msg.event.kind).toBe(A.kind);
  });

  it('壞形狀一律拒、永不 throw', () => {
    for (const raw of [null, undefined, 42, 'EVENT', {}, [], ['EVENT'], ['EVENT', null], ['EVENT', []], ['EVENT', A, A], ['NOPE', A]]) {
      expect(parseClientMsg(raw, NOW).ok, JSON.stringify(raw) ?? 'undefined').toBe(false);
    }
  });

  it('kind 必須在 ephemeral 區段', () => {
    expect(parseClientMsg(['EVENT', { ...A, kind: KIND_MIN - 1 }], NOW).ok).toBe(false);
    expect(parseClientMsg(['EVENT', { ...A, kind: KIND_MAX + 1 }], NOW).ok).toBe(false);
    expect(parseClientMsg(['EVENT', { ...A, kind: 1 }], NOW).ok).toBe(false);
    expect(parseClientMsg(['EVENT', { ...A, kind: KIND_MIN }], NOW).ok).toBe(true);
  });

  it('created_at 夾在 ±CLOCK_SKEW_S', () => {
    expect(parseClientMsg(['EVENT', A], NOW + CLOCK_SKEW_S).ok).toBe(true);
    expect(parseClientMsg(['EVENT', A], NOW - CLOCK_SKEW_S).ok).toBe(true);
    expect(parseClientMsg(['EVENT', A], NOW + CLOCK_SKEW_S + 1).ok).toBe(false);
    expect(parseClientMsg(['EVENT', A], NOW - CLOCK_SKEW_S - 1).ok).toBe(false);
  });

  it('id / pubkey / sig 只驗形狀(hex 長度),sig 內容不驗', () => {
    expect(parseClientMsg(['EVENT', { ...A, id: 'zz' }], NOW).ok).toBe(false);
    expect(parseClientMsg(['EVENT', { ...A, pubkey: A.pubkey.toUpperCase() }], NOW).ok).toBe(false);
    expect(parseClientMsg(['EVENT', { ...A, sig: 'f'.repeat(127) }], NOW).ok).toBe(false);
    // 一個完全假的 sig,形狀對就過 —— 這是刻意的(spec §4)
    expect(parseClientMsg(['EVENT', { ...A, sig: '0'.repeat(128) }], NOW).ok).toBe(true);
  });

  it('tags 必須是字串陣列的陣列', () => {
    expect(parseClientMsg(['EVENT', { ...A, tags: 'x' }], NOW).ok).toBe(false);
    expect(parseClientMsg(['EVENT', { ...A, tags: [['x', 1]] }], NOW).ok).toBe(false);
    expect(parseClientMsg(['EVENT', { ...A, tags: [[]] }], NOW).ok).toBe(false);
    expect(parseClientMsg(['EVENT', { ...A, tags: [] }], NOW).ok).toBe(true); // 空 tags 形狀合法,只是對不上任何 filter
  });
});

describe('parseClientMsg:REQ / CLOSE', () => {
  it('真的 Trystero REQ 通過,filter 正規化成 {kinds, since, topics}', () => {
    const r = parseClientMsg(JSON.parse(FX.raw.req), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || r.msg.t !== 'req') return;
    expect(r.msg.subId).toBe(FX.req[1]);
    expect(r.msg.filter).toEqual({ kinds: [A.kind], since: (FX.req[2] as { since: number }).since, topics: [FX.topicA] });
  });

  it('REQ 多於一個 filter 明講拒收', () => {
    const r = parseClientMsg(['REQ', 'sub', FX.req[2], FX.req[2]], NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('multi-filter');
  });

  it('subId:1–64 字元的字串', () => {
    expect(parseClientMsg(['REQ', '', FX.req[2]], NOW).ok).toBe(false);
    expect(parseClientMsg(['REQ', 'a'.repeat(65), FX.req[2]], NOW).ok).toBe(false);
    expect(parseClientMsg(['REQ', 42, FX.req[2]], NOW).ok).toBe(false);
    expect(parseClientMsg(['CLOSE', 'a'.repeat(64)], NOW).ok).toBe(true);
    expect(parseClientMsg(['CLOSE', 'a', 'b'], NOW).ok).toBe(false);
  });

  it('CLOSE 通過', () => {
    const r = parseClientMsg(['CLOSE', 'sub-1'], NOW);
    expect(r).toEqual({ ok: true, msg: { t: 'close', subId: 'sub-1' } });
  });
});
