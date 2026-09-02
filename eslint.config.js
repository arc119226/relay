// 兩條鐵律的機器強制。照抄 super-reversi2 eslint.config.js 的 signal 那兩個 block。
import tseslint from 'typescript-eslint';

// ⚠️ **同名規則要用組合,不要靠兩個 block 疊加。**
// 純函式葉檔同時吃得到「src/**」與「葉檔清單」兩個 block,而 flat config 的同名規則
// 是**後蓋前、不是合併** —— 底下那個 block 只要也寫了 no-restricted-properties,
// 上面那個的 fetch 禁令就會在葉檔裡靜默消失,而 `pnpm lint` 照樣全綠。
// 所以共用的部分抽成陣列,在兩處都展開。(super-reversi2 P128-S6 踩過這個坑。)

/** 鐵律 2:不外呼第三方。裸 `fetch` 由 no-restricted-globals 擋,這裡擋繞道的寫法。 */
const NO_OUTBOUND = [
  { object: 'globalThis', property: 'fetch', message: 'relay 不外呼任何第三方(只做轉發)' },
  { object: 'self', property: 'fetch', message: 'relay 不外呼任何第三方(只做轉發)' },
];

/** 鐵律 3:純函式葉檔的決定論 —— 時間與隨機一律由 relay.ts 殼層以參數餵入。 */
const NO_NONDETERMINISM = [
  { object: 'Math', property: 'random', message: '純函式葉檔:隨機住 relay.ts 殼層' },
  { object: 'Date', property: 'now', message: '純函式葉檔:時間以 now 參數餵入' },
  { object: 'crypto', property: 'getRandomValues', message: '純函式葉檔:隨機住 relay.ts 殼層' },
  { object: 'crypto', property: 'randomUUID', message: '純函式葉檔:隨機住 relay.ts 殼層' },
];

/** 動態 import 是 no-restricted-imports 看不到的後門(它只認靜態 import 宣告)。 */
const NO_DYNAMIC_IMPORT = [
  { selector: 'ImportExpression', message: 'relay 零依賴:動態 import 一樣不行(靜態那條擋不到它)' },
];

/** `new Date()` 跟 `Date.now()` 一樣是讀時鐘,但 no-restricted-properties 看不到它。 */
const NO_CLOCK_CONSTRUCTION = [
  { selector: "NewExpression[callee.name='Date']", message: '純函式葉檔:時間以 now 參數餵入(new Date() 也是讀時鐘)' },
];

export default tseslint.config(
  // `**/dist/**`:trystero-smoke 的打包產物也在 dist 底下,`dist/**` 只會對到頂層那個(踩過)
  { ignores: ['node_modules/**', '.wrangler/**', '**/dist/**'] },
  ...tseslint.configs.recommended,
  {
    // 鐵律 2:relay 不外呼任何第三方、零依賴(僅 cloudflare:workers 白名單;相對路徑除外)。
    // 「只做轉發、零第三方」要是 diff 看得見的事實,不是承諾。
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'relay 是 Worker,不可碰 DOM' },
        { name: 'document', message: 'relay 是 Worker,不可碰 DOM' },
        { name: 'fetch', message: 'relay 不外呼任何第三方(只做轉發)' },
      ],
      'no-restricted-properties': ['error', ...NO_OUTBOUND],
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ regex: '^(?!cloudflare:workers$)[^.]', message: 'relay 零依賴(僅 cloudflare:workers;相對路徑除外)' }],
        },
      ],
      'no-restricted-syntax': ['error', ...NO_DYNAMIC_IMPORT],
    },
  },
  {
    // 鐵律 3:純函式葉檔必須決定論 —— 時間與隨機一律由 relay.ts 殼層以參數餵入。
    // ⚠️ 新增葉檔請**擴充這個陣列**,不要另開 block(理由見檔頭)。
    files: ['src/nip01.ts', 'src/match.ts', 'src/limits.ts', 'src/nip11.ts'],
    rules: {
      // 這兩條都是同名覆蓋,所以上面那個 block 的內容必須在這裡一起展開,否則葉檔會漏掉它們
      'no-restricted-properties': ['error', ...NO_OUTBOUND, ...NO_NONDETERMINISM],
      'no-restricted-syntax': ['error', ...NO_DYNAMIC_IMPORT, ...NO_CLOCK_CONSTRUCTION],
    },
  },
);
