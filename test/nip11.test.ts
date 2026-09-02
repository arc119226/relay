/**
 * NIP-11 文件。核心不變量只有一句:**宣告的數字必須等於程式實際執行的常數。**
 *
 * 一份會說謊的能力宣告比沒有更糟——客戶端會照它調參數,然後在真正的閘門上撞牆,
 * 而且那種錯只會顯示成莫名其妙的 `NOTICE`。所以下面逐項把文件裡的數字釘回 limits.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_S,
  KIND_MAX,
  KIND_MIN,
  MAX_FRAME,
  MAX_SUBS_PER_SOCKET,
  MAX_TAGS_PER_EVENT,
  SUBID_MAX,
} from '../src/limits';
import { SOFTWARE_URL, relayInfo } from '../src/nip11';
import { MAX_FILTERS } from '../src/limits';

const INFO = relayInfo('relay.example.com');

describe('limitation 的每個數字都等於實際執行的常數(防漂移)', () => {
  it('逐項對回 limits.ts', () => {
    const l = INFO.limitation;
    expect(l.max_message_length, 'max_message_length 要等於 MAX_FRAME').toBe(MAX_FRAME);
    expect(l.max_subscriptions, 'max_subscriptions 要等於 MAX_SUBS_PER_SOCKET').toBe(MAX_SUBS_PER_SOCKET);
    expect(l.max_subid_length, 'max_subid_length 要等於 SUBID_MAX').toBe(SUBID_MAX);
    expect(l.max_event_tags, 'max_event_tags 要等於 MAX_TAGS_PER_EVENT').toBe(MAX_TAGS_PER_EVENT);
  });

  it('max_filters = 1 —— 最反直覺的那條,不宣告客戶端一定會踩', () => {
    // 我們對多 filter 的 REQ 回 invalid: multi-filter(nip01.ts)。一般 relay 收多個。
    expect(INFO.limitation.max_filters).toBe(1);
    expect(MAX_FILTERS).toBe(1);
  });

  it('restricted_writes = true —— 只收 ephemeral kind,絕大多數事件會被拒', () => {
    // 填 false 會誤導:那代表「什麼都收」,而我們連 kind 1 都不收
    expect(INFO.limitation.restricted_writes).toBe(true);
  });

  it('沒有認證、沒有付費、沒有工作量證明', () => {
    expect(INFO.limitation.auth_required).toBe(false);
    expect(INFO.limitation.payment_required).toBe(false);
    expect(INFO.limitation.min_pow_difficulty).toBe(0);
  });
});

describe('刻意不填的欄位(鎖住這個決定,免得日後有人好意補回去)', () => {
  const keys = Object.keys(INFO);
  const limKeys = Object.keys(INFO.limitation);

  it('沒有 retention —— NIP-11 規格裡根本沒有這個欄位', () => {
    expect(keys).not.toContain('retention');
  });

  it('沒有 created_at_lower_limit / upper_limit —— 規格沒定義是絕對時戳還是相對偏移', () => {
    // 讀成絕對時戳的話,900 等於「1970 年之後的事件全拒收」,我們會看起來壞掉。
    // ±15 分鐘的容忍改寫進 description(下面那條測試會驗)。
    expect(limKeys).not.toContain('created_at_lower_limit');
    expect(limKeys).not.toContain('created_at_upper_limit');
  });

  it('沒有 pubkey / self / contact —— 沒有穩定身分,也不在公開文件放信箱', () => {
    for (const k of ['pubkey', 'self', 'contact']) expect(keys, k).not.toContain(k);
  });
});

describe('description 要把規格擋掉的三件事講出來', () => {
  it('說了什麼都不存(retention 沒欄位可宣告,只能寫散文)', () => {
    expect(INFO.description).toContain('什麼都不存');
  });

  it('說了 kind 範圍與 created_at 的容忍(created_at_* 沒填,只能寫散文)', () => {
    expect(INFO.description).toContain(String(KIND_MIN));
    expect(INFO.description).toContain(String(KIND_MAX));
    expect(INFO.description, '±15 分鐘要講出來').toContain(String(CLOCK_SKEW_S / 60));
  });

  it('說了這不是完整的 Nostr relay —— supported_nips 沒有「部分支援」的表示法', () => {
    expect(INFO.description).toContain('子集');
  });
});

describe('其餘欄位', () => {
  it('supported_nips 含 1 與 11', () => {
    expect(INFO.supported_nips).toContain(1);
    expect(INFO.supported_nips).toContain(11);
  });

  it('name 來自傳入的 host —— 不寫死網域,fork 自架不必改程式', () => {
    expect(INFO.name).toBe('relay.example.com');
    expect(relayInfo('other.example.org').name).toBe('other.example.org');
  });

  it('software 指到 repo', () => {
    expect(INFO.software).toBe(SOFTWARE_URL);
    expect(INFO.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('整份文件序列化得動', () => {
  it('JSON 往返相等(沒有 undefined / 函式混進去)', () => {
    const round: unknown = JSON.parse(JSON.stringify(INFO));
    expect(round).toEqual(INFO);
  });
});
