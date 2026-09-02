import { describe, expect, it } from 'vitest';
import FX from './fixtures/trystero.json';
import { MAX_KINDS_PER_FILTER, MAX_TOPICS_PER_FILTER } from '../src/limits';
import { matches, normalizeFilter, type Filter } from '../src/match';
import type { NostrEvent } from '../src/nip01';

const A = FX.eventA as NostrEvent;
const B = FX.eventB as NostrEvent;
const REQ = FX.req[2] as Record<string, unknown>;
const F = normalizeFilter(REQ) as Filter;

describe('normalizeFilter', () => {
  it('真的 Trystero filter 正規化', () => {
    expect(F).toEqual({ kinds: [A.kind], since: REQ['since'], topics: [FX.topicA] });
  });

  it('多餘欄位靜默丟掉(未來的客戶端多送也不會壞)', () => {
    const f = normalizeFilter({ ...REQ, authors: ['x'], ids: ['y'], limit: 10, until: 1, '#e': ['z'] });
    expect(f).toEqual(F);
  });

  it('since 缺席 = 0', () => {
    const { since: _drop, ...noSince } = REQ;
    void _drop;
    expect(normalizeFilter(noSince)?.since).toBe(0);
  });

  it('kinds / #x 去重', () => {
    const f = normalizeFilter({ kinds: [A.kind, A.kind], '#x': [FX.topicA, FX.topicA] });
    expect(f?.kinds).toEqual([A.kind]);
    expect(f?.topics).toEqual([FX.topicA]);
  });

  it('壞形狀回 null、永不 throw', () => {
    for (const raw of [null, 1, 'f', [], {}, { kinds: [], '#x': [FX.topicA] }, { kinds: [A.kind], '#x': [] }, { kinds: [1], '#x': [FX.topicA] }, { kinds: [A.kind], '#x': [''] }, { kinds: [A.kind], '#x': [FX.topicA], since: -1 }, { kinds: [A.kind], '#x': [FX.topicA], since: 1.5 }]) {
      expect(normalizeFilter(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('上限:主題與 kinds 各 16', () => {
    const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
    expect(normalizeFilter({ kinds: [A.kind], '#x': many(MAX_TOPICS_PER_FILTER, (i) => `t${i}`) })).not.toBeNull();
    expect(normalizeFilter({ kinds: [A.kind], '#x': many(MAX_TOPICS_PER_FILTER + 1, (i) => `t${i}`) })).toBeNull();
    expect(normalizeFilter({ kinds: many(MAX_KINDS_PER_FILTER, (i) => 20_000 + i), '#x': [FX.topicA] })).not.toBeNull();
    expect(normalizeFilter({ kinds: many(MAX_KINDS_PER_FILTER + 1, (i) => 20_000 + i), '#x': [FX.topicA] })).toBeNull();
  });
});

describe('matches:三個條件全成立才 true', () => {
  it('同房間的事件對得上;另一個房間(B)對不上', () => {
    expect(matches(A, F)).toBe(true);
    expect(matches(B, F)).toBe(false);
  });

  it('kind 不在 kinds 裡 → false', () => {
    expect(matches({ ...A, kind: A.kind + 1 }, F)).toBe(false);
  });

  it('created_at < since → false;等於 since → true', () => {
    expect(matches({ ...A, created_at: F.since - 1 }, F)).toBe(false);
    expect(matches({ ...A, created_at: F.since }, F)).toBe(true);
  });

  it('只認 x 標籤;其他標籤帶同名值不算', () => {
    expect(matches({ ...A, tags: [['e', FX.topicA]] }, F)).toBe(false);
    expect(matches({ ...A, tags: [['e', 'zzz'], ['x', FX.topicA]] }, F)).toBe(true);
    expect(matches({ ...A, tags: [] }, F)).toBe(false);
  });

  it('批次 filter:多主題、多 kind,任一命中即可', () => {
    const batch = normalizeFilter({ kinds: [A.kind, B.kind], since: 0, '#x': [FX.topicA, FX.topicB] }) as Filter;
    expect(matches(A, batch)).toBe(true);
    expect(matches(B, batch)).toBe(true);
  });
});

// isFilter 是給殼層從 attachment 讀回訂閱表用的守衛;跟上面共用同一份 fixture
import { isFilter } from '../src/match';

describe('isFilter:attachment 讀回來的東西是不是我們寫出去的 Filter', () => {
  it('normalizeFilter 的產物一定過', () => {
    expect(isFilter(F)).toBe(true);
    expect(isFilter(normalizeFilter({ kinds: [A.kind], '#x': [FX.topicA] }))).toBe(true); // since 缺席=0 也合法
  });

  it('原始 NIP 形狀(#x 而不是 topics)不算,壞值不算,永不 throw', () => {
    for (const raw of [null, 1, [], {}, REQ, { kinds: [A.kind], topics: [FX.topicA] }, { kinds: [A.kind], topics: [FX.topicA], since: -1 }, { kinds: ['x'], topics: [FX.topicA], since: 0 }, { kinds: [A.kind], topics: [1], since: 0 }]) {
      expect(isFilter(raw), JSON.stringify(raw)).toBe(false);
    }
  });
});
