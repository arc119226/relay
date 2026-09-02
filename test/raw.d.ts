// vite/vitest 的 `?raw` 匯入(storageFree.test 用來讀 relay.ts 原始碼)
declare module '*?raw' {
  const src: string;
  export default src;
}
