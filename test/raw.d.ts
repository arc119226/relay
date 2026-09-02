// vite/vitest 的 `?raw` 匯入(storageFree.test 用來讀 relay.ts 原始碼)
declare module '*?raw' {
  const src: string;
  export default src;
}

// `import.meta.glob` —— storageFree.test 用它一次讀進整個 src/。
// 只宣告我們實際用到的那個形狀(eager + query:'?raw' + import:'default' ⇒ 字串)。
// 不走 `types: ["vite/client"]`,那會把整包 DOM 型別拉進這個 Worker 專案。
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: '?raw'; import: 'default'; eager: true },
  ): Record<string, string>;
}
