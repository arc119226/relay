# `docs/` 的授權

SPDX-License-Identifier: CC-BY-SA-4.0

本目錄下的文件（`spec.md` 與 `plan.md`）以
**創用 CC 姓名標示-相同方式分享 4.0 國際**（CC BY-SA 4.0）授權：

- 授權條款全文：<https://creativecommons.org/licenses/by-sa/4.0/legalcode.zh-hant>
- 摘要：<https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hant>

## 為什麼與程式碼分開

repo 其餘部分走 Apache-2.0（見根目錄 `LICENSE`）。這裡不同，理由跟程式碼那邊不一樣：

1. **這些是散文不是程式。** `spec.md` 是一份逐行讀客戶端原始碼推導出來的協定子集說明，
   `plan.md` 是一份帶著「每一步怎麼證明」的施工紀錄。Apache-2.0 的用語（衍生著作、
   專利授權、目的碼形式）套在這種東西上語意很奇怪。
2. **相同方式分享是刻意的。** 這兩份文件的價值有一半在於它們**記下了為什麼不做**——
   為什麼不驗簽章、為什麼不存事件、為什麼扇出要包含發送者自己。
   若有人引用、改寫、擴充它們，那份改寫也應該保持開放。

## 怎麼署名

    「NIP-01 訊令子集規格」，作者 Arc Liu，採 CC BY-SA 4.0 授權。
    來源：https://github.com/arc119226/relay/blob/main/docs/spec.md

修改過的版本請註明已修改，並以相同授權散布。

## 例外

`docs/spec.md` 引述的 NIP-01 規格本身不屬於本專案，見根目錄 `NOTICE`。
