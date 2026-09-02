/**
 * NIP-11 relay information document —— **純函式葉檔**,零 Cloudflare 依賴。
 *
 * 客戶端拿 `GET /` 帶 `Accept: application/nostr+json` 問「你支援什麼」,這支回答。
 *
 * ## 為什麼自用時不做、開源後要做
 *
 * spec §7 當初判「不做」的理由是「Trystero 不讀」——那在只有一個客戶端的前提下成立。
 * 一旦公開,任何 Nostr 客戶端接上來都會先問這一句;沒有答案的話,它們只能**靠試錯**
 * 發現這台只吃 kind 20000–29999、只認 `#x`、一個 REQ 只收一個 filter,
 * 而那些拒絕會以 `NOTICE` 出現,看起來像壞掉。
 *
 * ## 三個欄位刻意不填(查過規格全文才決定的)
 *
 * - **`retention`** —— 規格裡**根本沒有這個欄位**。原本想用 `[{time:0}]` 當
 *   「什麼都不存」的機器可讀宣告,查了才知道不存在。只好寫進 `description` 散文。
 * - **`created_at_lower_limit` / `created_at_upper_limit`** —— 規格的描述只有
 *   「'created_at' lower limit」,**沒有定義是絕對時戳還是相對偏移**;範例給的是
 *   `31536000`(一年的秒數)與 `3`,只有讀成相對偏移才講得通。
 *   填一個語意會被誤讀的數字比不填糟:若客戶端讀成絕對時戳,`900` 等於
 *   「1970 年之後的事件全拒收」,我們會看起來壞掉。±15 分鐘的容忍改寫進 `description`。
 * - **`pubkey` / `self` / `contact`** —— 沒有穩定身分(見 spec §4),也不想在公開文件放信箱。
 *
 * ## 數字一律 import,不得複寫字面量
 *
 * 這是本檔最重要的紀律。一份**會說謊的** NIP-11 文件比沒有更糟——客戶端會照它調參數,
 * 然後在真正的閘門上撞牆。所以 `limitation` 的每個數字都直接來自 `limits.ts`,
 * `test/nip11.test.ts` 再逐項斷言兩邊相等。
 */
// ⚠️ `max_filters` 不在 NIP-11 規格的欄位表裡,是常見的擴充欄位 —— 規格說
// 「clients MUST ignore any additional fields they do not understand」,所以放著是安全的,
// 而**不宣告的話客戶端一定會踩**(我們對多 filter 的 REQ 回 `invalid: multi-filter`)。
import {
  MAX_FILTERS,
  MAX_FRAME,
  MAX_SUBS_PER_SOCKET,
  MAX_TAGS_PER_EVENT,
  SUBID_MAX,
  KIND_MIN,
  KIND_MAX,
  CLOCK_SKEW_S,
} from './limits';

/** 軟體版本。**刻意不 import `package.json`**:default import 會把 scripts 與
 *  devDependencies 整包塞進 Worker bundle,而且那支檔案在 tsconfig 的 include 之外。 */
export const SOFTWARE_VERSION = '0.1.0';
export const SOFTWARE_URL = 'https://github.com/arc119226/relay';

const DESCRIPTION =
  'WebRTC 訊令用的 NIP-01 子集,不是完整的 Nostr relay。' +
  `只接受 ephemeral 事件(kind ${KIND_MIN}–${KIND_MAX});` +
  'filter 只認 kinds / since / #x,其餘欄位靜默忽略;一個 REQ 只收一個 filter。' +
  `created_at 必須落在伺服器時間的 ±${CLOCK_SKEW_S / 60} 分鐘內。` +
  '不驗 schnorr 簽章(客戶端金鑰每次隨機,pubkey 不是身分),但會驗事件 id 的 SHA-256。' +
  '**什麼都不存**:沒有歷史、沒有資料庫,轉發完就沒了。' +
  `詳見 ${SOFTWARE_URL}`;

/** NIP-11 的 `limitation` 物件。全部的數字都來自 limits.ts。 */
export interface Limitation {
  readonly max_message_length: number;
  readonly max_subscriptions: number;
  readonly max_subid_length: number;
  readonly max_event_tags: number;
  readonly max_filters: number;
  readonly min_pow_difficulty: number;
  readonly auth_required: boolean;
  readonly payment_required: boolean;
  readonly restricted_writes: boolean;
}

export interface RelayInfo {
  readonly name: string;
  readonly description: string;
  readonly supported_nips: readonly number[];
  readonly software: string;
  readonly version: string;
  readonly limitation: Limitation;
}

/**
 * 產生這台 relay 的 NIP-11 文件。
 *
 * `host` 由殼層從請求的 URL 取(`new URL(req.url).host`)——**刻意不寫死網域**:
 * 這個 repo 是給人 fork 自架的,寫死會讓每個 fork 都得改一行。
 */
export function relayInfo(host: string): RelayInfo {
  return {
    name: host,
    description: DESCRIPTION,
    // NIP-11 沒有「部分支援」的表示法。宣告 1 是慣例,實際的子集靠 description 講清楚。
    supported_nips: [1, 11],
    software: SOFTWARE_URL,
    version: SOFTWARE_VERSION,
    limitation: {
      // ⚠️ 規格明文是 **UTF-8 byte**(「calculated UTF-8 from `[` to `]`」),
      //    而我們的閘是 `message.length` = UTF-16 code unit。宣告成 byte 是**偏嚴**的
      //    (CJK 實際可到約三倍),對客戶端安全:照這個數字送一定進得來。
      max_message_length: MAX_FRAME,
      max_subscriptions: MAX_SUBS_PER_SOCKET,
      max_subid_length: SUBID_MAX,
      max_event_tags: MAX_TAGS_PER_EVENT,
      max_filters: MAX_FILTERS,
      min_pow_difficulty: 0,
      auth_required: false,
      payment_required: false,
      // 誠實:只收 kind 20000–29999,絕大多數事件會被拒。填 false 會誤導。
      restricted_writes: true,
    },
  };
}
