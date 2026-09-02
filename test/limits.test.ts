import { describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_BYTES, BUCKET_CAP, BUCKET_REFILL_MS, MAX_SUBS_PER_SOCKET, MAX_TOPICS_PER_FILTER, bucketOf, fullBucket, takeToken } from '../src/limits';

describe('令牌桶(時間由呼叫端餵=純函數)', () => {
  it('滿桶可爆發 CAP 則,第 CAP+1 則被擋', () => {
    let b = fullBucket(0);
    for (let i = 0; i < BUCKET_CAP; i++) {
      const r = takeToken(b, 0);
      expect(r.ok, `第 ${i + 1} 則`).toBe(true);
      b = r.next;
    }
    expect(takeToken(b, 0).ok).toBe(false);
  });

  it('被擋也會寫回新桶(被擋的人要被計時)', () => {
    const empty = { tokens: 0, at: 0 };
    const r = takeToken(empty, 10);
    expect(r.ok).toBe(false);
    expect(r.next.at).toBe(10);
  });

  it('過 REFILL_MS 回一顆;回補夾在容量', () => {
    const empty = { tokens: 0, at: 0 };
    expect(takeToken(empty, BUCKET_REFILL_MS - 1).ok).toBe(false);
    expect(takeToken(empty, BUCKET_REFILL_MS).ok).toBe(true);
    const long = takeToken(empty, BUCKET_REFILL_MS * BUCKET_CAP * 10);
    expect(long.next.tokens).toBe(BUCKET_CAP - 1);
  });

  it('時間倒退不會變出負的經過時間', () => {
    const b = { tokens: 1, at: 100 };
    expect(takeToken(b, 50).ok).toBe(true);
  });

  it('bucketOf:壞值/缺席給滿桶;合法值夾在 [0, CAP]', () => {
    expect(bucketOf(null, 5)).toEqual(fullBucket(5));
    expect(bucketOf({ tokens: 'x', at: 1 }, 5)).toEqual(fullBucket(5));
    expect(bucketOf({ tokens: Number.NaN, at: 1 }, 5)).toEqual(fullBucket(5));
    expect(bucketOf({ tokens: 999, at: 1 }, 5)).toEqual({ tokens: BUCKET_CAP, at: 1 });
    expect(bucketOf({ tokens: -3, at: 1 }, 5)).toEqual({ tokens: 0, at: 1 });
  });
});

describe('attachment 預算', () => {
  it('政策上限留了餘裕:正常用法 20 筆訂閱遠低於 16384', () => {
    // 政策不是允許 20 筆「最壞情況」都塞滿(16 主題 × 20 筆 ≈ 18KB 會爆),而是:
    // 正常用法(一個房間 2 主題)20 筆遠低於上限,極端用法會先撞到 MAX_TOPICS_PER_FILTER。
    // 這條鎖的是「正常用法一定塞得下」跟「單筆最壞情況也只佔一小塊」。
    const normalSub = JSON.stringify({ s: 'a'.repeat(64), k: [22_690], t: ['a'.repeat(40), 'b'.repeat(40)], z: 1_788_356_261 }).length;
    const worstSub = JSON.stringify({
      s: 'a'.repeat(64),
      k: Array.from({ length: 16 }, (_, i) => 20_000 + i),
      t: Array.from({ length: MAX_TOPICS_PER_FILTER }, (_, i) => `t${String(i).padStart(38, '0')}`),
      z: 1_788_356_261,
    }).length;
    const bucket = JSON.stringify(fullBucket(1_788_356_261_000)).length;
    expect(normalSub * MAX_SUBS_PER_SOCKET + bucket).toBeLessThan(ATTACHMENT_MAX_BYTES / 3);
    expect(worstSub).toBeLessThan(ATTACHMENT_MAX_BYTES / 10);
  });
});
