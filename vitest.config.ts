/**
 * 兩個 project,因為兩種測試需要的執行環境不同:
 *
 * - **unit**(node)—— 純函式葉檔與原始碼比對鎖。用 `?raw` 讀原始碼,跑在 node 最快。
 * - **workers**(workerd)—— `*.behaviour.test.ts`。**真的把 Worker 與 RelayDO 跑起來**,
 *   有 WebSocket、有 Hibernation API、有 DO 生命週期。
 *
 * 為什麼需要第二個:完工稽核發現 `src/relay.ts` **從來沒有被任何測試執行過** ——
 * 64 個測試對它只做原始碼字串比對,而字串比對守的是拼字不是行為。當場示範了兩種
 * 「改一行就把 fan-out 改成跳過發送者、而 pnpm check 全綠」的寫法。
 * 原始碼比對留著當第二道防線,但不該是唯一一道。
 */
import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.behaviour.test.ts'],
        },
      },
      defineWorkersProject({
        test: {
          name: 'workers',
          include: ['test/**/*.behaviour.test.ts'],
          poolOptions: {
            workers: {
              // 讀同一份 wrangler.jsonc ⇒ 測試跑的 DO 綁定與 migration 跟正式站同一套設定,
              // 不是另外手抄一份會漂移的
              wrangler: { configPath: './wrangler.jsonc' },
              // isolatedStorage 維持預設(開)。這顆 DO 零儲存,照理沒東西要隔離,
              // 但關掉會讓 workerd 去開一個真的 sqlite 檔然後 SQLITE_CANTOPEN
              // (migration 是 new_sqlite_classes,DO 仍是 sqlite-backed,只是我們不寫)。
              // 收尾時的「Isolated storage failed」真正的原因是**測試留著沒關的 WebSocket**,
              // 那個在測試檔的 afterEach 收,不在這裡關功能。
            },
          },
        },
      }),
    ],
  },
});
