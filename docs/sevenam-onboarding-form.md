# SevenAM New Unit Onboarding Form

用途：讓新部門、公司或單位填寫導入 SevenAM 所需資料。填完後，Codex 可以依照本表建立新的 Notion 控制中心、設定 LINE OA Webhook、配置 Render 環境變數，並產生初始專案與報告設定。

安全提醒：

- `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`、`NOTION_TOKEN`、`SEVEN_CONTROL_API_KEY`、`SEVEN_REPORT_APPROVAL_KEY` 屬於敏感資料。
- 敏感資料請只填在私密文件、Render 環境變數或受控 Notion 頁面，不要貼到公開 GitHub、公開聊天或一般簡報。
- 建立新單位時，Notion integration 只能分享給該單位的 `Codex 總控中心` 及其子資料庫，不應分享整個 workspace。

## 1. 單位基本資料

| 欄位 | 必填 | 填寫內容 |
| --- | --- | --- |
| 公司 / 單位名稱 | 是 |  |
| 部門名稱 | 是 |  |
| SevenAM 專案代號 | 是 |  |
| 助理顯示名稱 | 是 | 例：Seven Jr.、營運助理、財務小助理 |
| 主要使用語言 | 是 | 例：繁體中文 |
| 時區 | 是 | 預設：Asia/Taipei |
| 導入目的 | 是 | 例：LINE 群組訊息彙整、任務追蹤、每日報告 |
| 不納入範圍 | 是 | 例：私人資料、非本部門 Notion、其他公司專案 |
| 上線目標日期 | 否 |  |

## 2. 主負責人與預設通知對象

| 欄位 | 必填 | 填寫內容 |
| --- | --- | --- |
| 主負責人姓名 | 是 |  |
| 職稱 / 角色 | 是 |  |
| Email | 否 |  |
| 手機 | 否 |  |
| LINE 顯示名稱 | 是 |  |
| LINE User ID | 是 | 例：Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx |
| Notion 對話名稱 | 是 | 例：王小明 |
| 自定義名稱 | 是 | 例：王小明的主要訊息 |
| 預設通知 Target Type | 是 | `user` / `group` / `room` |
| 預設通知 Target ID | 是 | userId / groupId / roomId |
| 報告對象搜尋關鍵字 | 否 | 若未固定 Target ID，可用姓名或關鍵字自動尋找 |

Render 對應環境變數：

```text
SEVEN_REPORT_TARGET_ID=
SEVEN_REPORT_TARGET_TYPE=user
SEVEN_REPORT_TARGET_NAME_KEYWORD=
```

## 3. LINE OA / Messaging API

| 欄位 | 必填 | 填寫內容 |
| --- | --- | --- |
| LINE OA 名稱 | 是 |  |
| LINE Developers Provider | 是 |  |
| Messaging API Channel ID | 是 |  |
| LINE_CHANNEL_ACCESS_TOKEN | 是 | 敏感資料 |
| LINE_CHANNEL_SECRET | 是 | 敏感資料 |
| Webhook URL | 建立後填 | `https://<render-service>.onrender.com/webhook/line` |
| 是否啟用 Webhook | 是 | 是 / 否 |
| 是否允許加入群組 | 是 | 是 / 否 |
| 指令觸發名稱 | 否 | 預設支援 Eleven Junior、Seven Junior、7 Junior、11 Jr. |
| 早報指令 | 否 | 預設：早報、#早報、今日早報、行程 |
| 晚報指令 | 否 | 預設：報告、#報告、每日報告 |

Render 對應環境變數：

```text
LINE_CHANNEL_ID=
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
SEVEN_OUTGOING_ACTOR_NAME=
```

## 4. Notion Workspace 與 Integration

| 欄位 | 必填 | 填寫內容 |
| --- | --- | --- |
| Notion Workspace 名稱 | 是 |  |
| Notion Workspace URL | 否 |  |
| Workspace 管理者 / Owner | 否 |  |
| Workspace 聯絡窗口 | 否 | 後續權限或資料庫問題找誰 |
| Notion Integration 名稱 | 是 |  |
| Integration 建立者 / 管理者 | 否 |  |
| NOTION_TOKEN | 是 | 敏感資料 |
| Notion API Version | 否 | 預設：2025-09-03 |
| Notion 專案名稱 / 資料庫前綴 | 是 | 例：SevenAM、營運總控、財務助理 |
| 總控中心頁面名稱 | 是 | 建議：`{專案名稱} 總控中心` |
| 總控中心頁面 URL | 是 |  |
| LINE CRM 原始紀錄層頁面 URL | 建立後填 |  |
| Integration 已分享給總控中心 | 是 | 是 / 否 |
| Integration 已分享給所有子資料庫 | 是 | 是 / 否 |
| Notion 頁面結構說明 | 否 |  |
| 資料庫命名備註 | 否 |  |
| Notion 權限與分享備註 | 否 |  |
| 不可讀取 / 不可同步的 Notion 範圍 | 否 |  |
| Notion 其他交接說明 | 否 |  |

命名規則：

- 新單位的 Notion 資料庫名稱建議都用 `{專案名稱} + 資料層名稱`。
- 目前既有資料庫若是以 `7` 開頭，複製到新單位時就把 `7` 換成表單中的「Notion 專案名稱 / 資料庫前綴」。
- Render 環境變數名稱不要跟著改，仍維持 `SEVEN_...`，因為這是程式讀取設定用的固定 key。

Render 對應環境變數：

```text
NOTION_TOKEN=
NOTION_VERSION=2025-09-03
```

## 5. Notion Data Source IDs

這些欄位是建立新資料庫後最重要的對照表。每個 ID 都要填新單位自己的 data source ID，不要沿用 SevenAM 目前的 ID。

建議資料庫名稱中的 `{專案名稱}` 來自第 4 節的「Notion 專案名稱 / 資料庫前綴」。

| 建議資料庫名稱 | 資料層 | 必填 | Render 環境變數 | 新單位 Data Source ID |
| --- | --- | --- | --- | --- |
| `{專案名稱} LINE 對話主檔` | LINE 對話主檔 | 是 | `SEVEN_CONVERSATIONS_DATA_SOURCE_ID` |  |
| `{專案名稱} LINE 訊息紀錄` | LINE 訊息紀錄 | 是 | `SEVEN_MESSAGES_DATA_SOURCE_ID` |  |
| `{專案名稱} LINE 群組成員索引` | LINE 群組成員索引 | 建議 | `SEVEN_LINE_GROUP_MEMBER_INDEX_DATA_SOURCE_ID` |  |
| `{專案名稱} LINE 附件紀錄` | LINE 附件紀錄 | 是 | `SEVEN_ATTACHMENTS_DATA_SOURCE_ID` |  |
| `{專案名稱} LINE 附件轉檔資料庫` | LINE 附件轉檔資料庫 | 建議 | `SEVEN_ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID` |  |
| `{專案名稱} Codex 指令佇列` | Codex 指令佇列 | 建議 | `SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID` |  |
| `{專案名稱} 總控專案庫` | 總控專案庫 | 建議 | 待擴充 / 目前作為 Notion 層使用 |  |
| `{專案名稱} 總控任務庫` | 總控任務庫 | 是 | `SEVEN_TASKS_DATA_SOURCE_ID` |  |
| `{專案名稱} 會議紀錄` | 會議紀錄 | 建議 | `SEVEN_MEETINGS_DATA_SOURCE_ID` |  |
| `{專案名稱} 專案進度報表庫` | 專案進度報表庫 | 建議 | `SEVEN_PROGRESS_REPORTS_DATA_SOURCE_ID` |  |
| `{專案名稱} 風險與決策庫` | 風險與決策庫 | 建議 | `SEVEN_RISK_DECISIONS_DATA_SOURCE_ID` |  |
| `{專案名稱} Automation Run Log` | Automation Run Log | 建議 | `SEVEN_AUTOMATION_RUN_LOG_DATA_SOURCE_ID` |  |
| `{專案名稱} 通知候選佇列` | 通知候選 / Notification Queue | 未來功能 | 待擴充 |  |

LINE 任務判斷資料來源規則：

- `SEVEN_CONVERSATIONS_DATA_SOURCE_ID` 是 hourly LINE 任務判斷、任務來源證據與 User UI 對話呈現的主要來源。
- `SEVEN_MESSAGES_DATA_SOURCE_ID` 仍需建立並設定，用於 raw LINE event log、outgoing message log、附件關聯、Webhook 重送追蹤與除錯。
- 不要把 `SEVEN_MESSAGES_DATA_SOURCE_ID` 當作任務判斷輸入來源。
- `SEVEN_LINE_GROUP_MEMBER_INDEX_DATA_SOURCE_ID` 是 Group ID / Room ID 與 User ID 的成員索引來源；權責判斷與群組成員同步讀這張表，不讀 LINE 訊息紀錄。

關於「總控專案庫」：

- 可以改成 `{專案名稱} 總控專案庫`。
- 它的定位是「這套控制中心底下有哪些專案 / 分類」的資料庫，不是單一專案頁本身。
- 如果要給非技術使用者看，也可以顯示成 `{專案名稱} 總控資料庫`；但內部文件建議保留「總控專案庫」四個字，方便和任務庫、進度報表庫區分。

## 6. 初始專案與部門分類

| 專案 / 分類名稱 | 負責人 | 常見 LINE 群組 | 主要追蹤內容 | 是否啟用 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |

建議至少先建立：

- 業務 / 營運
- 財務
- 人資
- 專案執行
- 私人或主管事項（如果該單位需要）

## 7. 初始 LINE 對話與群組對照

| LINE 群組 / 使用者名稱 | Target Type | Group / Room / User ID | 對應專案 | 監控狀態 | 備註 |
| --- | --- | --- | --- | --- | --- |
|  | group |  |  | 啟用 |  |
|  | user |  |  | 啟用 |  |
|  | room |  |  | 啟用 |  |

規則：

- 新群組若尚未分配專案，先進 LINE 對話主檔，並在每日報告列出讓主管分配。
- 不確定的群組不要硬分專案，避免錯誤同步到任務庫。

## 8. 報告頁與確認頁

| 報告 / 頁面 | 必填 | Render 環境變數 | URL |
| --- | --- | --- | --- |
| 08:30 早報 | 否 | `MORNING_BRIEF_URL` |  |
| 10:00 / 13:00 / 17:00 跟催確認 | 否 | `FOLLOWUP_CONFIRMATION_URL` |  |
| 20:30 每日總控報告 | 否 | `DAILY_REPORT_URL` |  |
| 報告確認 Approval Key | 否 | `SEVEN_REPORT_APPROVAL_KEY` | 敏感資料 |

## 9. Render / 部署資訊

| 欄位 | 必填 | 填寫內容 |
| --- | --- | --- |
| Render 帳號 / Team | 是 |  |
| GitHub Repository | 是 |  |
| Web Service 名稱 | 是 | 例：line-oa-webhook |
| Render Base URL | 建立後填 | 例：https://xxx.onrender.com |
| Webhook URL | 建立後填 | 例：https://xxx.onrender.com/webhook/line |
| Control API Send Report URL | 建立後填 | 例：https://xxx.onrender.com/control/reports/send |
| Control API Push URL | 建立後填 | 例：https://xxx.onrender.com/control/line/push |
| SEVEN_CONTROL_API_KEY | 是 | 敏感資料，請用長隨機字串 |
| Cron 失敗是否 LINE 警示 | 是 | true / false |

Render 對應環境變數：

```text
SEVEN_CONTROL_API_KEY=
CONTROL_API_URL=https://<render-service>.onrender.com/control/reports/send
CONTROL_LINE_PUSH_URL=https://<render-service>.onrender.com/control/line/push
SEVEN_CRON_ALERTS_ENABLED=true
```

## 10. 固定排程

Render Cron 使用 UTC。台北時間 UTC+8。

| 工作 | 台北時間 | UTC Cron | 是否啟用 | 備註 |
| --- | --- | --- | --- | --- |
| 會議任務同步 | 08:00-22:00 每小時 | `0 0-14 * * *` | 是 | `npm run meetings:sync -- --limit 50` |
| 早報 | 08:30 | `30 0 * * *` | 是 | `npm run cron:report -- morning` |
| 跟催確認 1 | 10:00 | `0 2 * * *` | 是 | `npm run cron:report -- followup-morning` |
| 跟催確認 2 | 13:00 | `0 5 * * *` | 是 | `npm run cron:report -- followup-midday` |
| 跟催確認 3 | 17:00 | `0 9 * * *` | 是 | `npm run cron:report -- followup-afternoon` |
| 每日總控報告 | 20:30 | `30 12 * * *` | 是 | `npm run cron:report -- daily` |

## 11. 權限與風險規則

| 規則 | 必填 | 設定 |
| --- | --- | --- |
| 財務、合約、法律、稅務、人資是否一律待確認 | 是 | 建議：是 |
| 外部承諾訊息是否需主管批准才發送 | 是 | 建議：是 |
| 低信心任務是否只進候選任務 | 是 | 建議：是 |
| 是否允許自動回覆一般 LINE 訊息 | 是 | 建議：否 |
| 是否允許 Codex 建立內部待辦 | 是 | 建議：是 |
| 是否允許 Codex 主動對外發訊息 | 是 | 建議：否，需經確認頁 |
| 不可讀取的 Notion 範圍 | 是 |  |

## 12. 完整 Render Env 草稿

填完後可依照下列格式整理到 Render。空白欄位代表尚未建立或不啟用。

```text
LINE_CHANNEL_ID=
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
NOTION_TOKEN=
NOTION_VERSION=2025-09-03

SEVEN_OUTGOING_ACTOR_NAME=
SEVEN_CONTROL_API_KEY=
SEVEN_REPORT_APPROVAL_KEY=

SEVEN_CONVERSATIONS_DATA_SOURCE_ID=
SEVEN_MESSAGES_DATA_SOURCE_ID=
SEVEN_LINE_GROUP_MEMBER_INDEX_DATA_SOURCE_ID=
SEVEN_ATTACHMENTS_DATA_SOURCE_ID=
SEVEN_ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID=
SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID=
SEVEN_MEETINGS_DATA_SOURCE_ID=
SEVEN_TASKS_DATA_SOURCE_ID=
SEVEN_PROGRESS_REPORTS_DATA_SOURCE_ID=
SEVEN_RISK_DECISIONS_DATA_SOURCE_ID=
SEVEN_AUTOMATION_RUN_LOG_DATA_SOURCE_ID=

SEVEN_REPORT_TARGET_ID=
SEVEN_REPORT_TARGET_TYPE=user
SEVEN_REPORT_TARGET_NAME_KEYWORD=

MORNING_BRIEF_URL=
DAILY_REPORT_URL=
FOLLOWUP_CONFIRMATION_URL=

CONTROL_API_URL=https://<render-service>.onrender.com/control/reports/send
CONTROL_LINE_PUSH_URL=https://<render-service>.onrender.com/control/line/push
SEVEN_CRON_ALERTS_ENABLED=true
```

## 13. 建立新專案前檢查

| 檢查項目 | 狀態 |
| --- | --- |
| HTML 表單已下載 JSON 備份 |  |
| HTML 表單已下載 Markdown 或 TXT 交接文件 |  |
| LINE OA 已建立 Messaging API Channel |  |
| Webhook URL 已填入 LINE Developers Console |  |
| LINE OA 已開啟 Webhook |  |
| Notion Integration 已建立 |  |
| Integration 已分享給新單位的總控中心與資料庫 |  |
| Data Source IDs 已填入本表 |  |
| Render Web Service 已建立 |  |
| Render 環境變數已填妥 |  |
| Render Cron Jobs 已建立 |  |
| 主負責人已傳訊息給 LINE OA 以取得 User ID |  |
| `/control/health` 測試成功 |  |
| LINE 測試推送成功 |  |
| 早報 / 晚報手動測試成功 |  |

## 14. Codex 後續產生項目

Codex 取得本表後，下一步可產生：

- 新單位專用 `render.yaml`
- 新單位專用 `.env.example`
- 新 Notion 資料庫建立清單與 schema
- 初始專案與 LINE 群組對照資料
- 主負責人測試推送指令
- 上線驗收 checklist

## 15. HTML 表單使用方式

如果使用內建瀏覽器下載檔案，但看不到下載位置：

- 按 `顯示 JSON`，表單底部會顯示完整 JSON。
- 按 `複製 JSON`，直接把內容貼給 Codex 建立新專案。
- `下載 JSON` 適合用一般瀏覽器保存檔案；內建瀏覽器可能不會明確顯示下載路徑。
- `複製 Markdown` 可產生交接文件內容，適合給主管或其他部門確認。
