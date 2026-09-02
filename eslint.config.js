// 兩條鐵律的機器強制。照抄 super-reversi2 eslint.config.js 的 signal 那兩個 block。
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', '.wrangler/**', 'dist/**'] },
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
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ regex: '^(?!cloudflare:workers$)[^.]', message: 'relay 零依賴(僅 cloudflare:workers;相對路徑除外)' }],
        },
      ],
    },
  },
  {
    // 鐵律 3:純函式葉檔必須決定論 —— 時間與隨機一律由 relay.ts 殼層以參數餵入。
    // ⚠️ 新增葉檔請**擴充這個陣列**,不要另開 block:flat config 同名規則後蓋前,
    //    另開一塊會讓其中一邊靜默失效而 lint 照樣全綠(super-reversi2 P128-S6 踩過)。
    files: ['src/nip01.ts', 'src/match.ts', 'src/limits.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: '純函式葉檔:隨機住 relay.ts 殼層' },
        { object: 'Date', property: 'now', message: '純函式葉檔:時間以 now 參數餵入' },
      ],
    },
  },
);
