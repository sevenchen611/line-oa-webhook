# LINE OA Webhook

Seven Jr. 的 LINE OA Webhook 服務，用來接收 LINE 群組/個人對話、寫入 Notion，並提供安全的主動推送入口。

## Webhook

LINE Developers Console 的 Webhook URL：

```text
https://line-oa-webhook-nn5j.onrender.com/webhook/line
```

健康檢查：

```text
https://line-oa-webhook-nn5j.onrender.com/health
```

控制 API 健康檢查：

```text
https://line-oa-webhook-nn5j.onrender.com/control/health
```

## Render Environment

必要設定：

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `NOTION_TOKEN`
- `SEVEN_CONVERSATIONS_DATA_SOURCE_ID`
- `SEVEN_MESSAGES_DATA_SOURCE_ID`
- `SEVEN_ATTACHMENTS_DATA_SOURCE_ID`

主動推送功能需要新增：

- `SEVEN_CONTROL_API_KEY`: 控制 API 密鑰，請使用一組夠長的隨機字串。
- `SEVEN_REPORT_TARGET_ID`: 早報/晚報預設推送對象，可以是 userId、groupId 或 roomId。
- `SEVEN_REPORT_TARGET_TYPE`: `user`、`group` 或 `room`，主要作為紀錄辨識用。
- `MORNING_BRIEF_URL`: 早報網頁連結，可省略，省略時使用 GitHub 預設版。
- `DAILY_REPORT_URL`: 晚報網頁連結，可省略，省略時使用 GitHub 預設版。

## 主動推送 API

所有控制 API 都需要帶其中一種授權：

```text
x-seven-control-key: <SEVEN_CONTROL_API_KEY>
```

或：

```text
Authorization: Bearer <SEVEN_CONTROL_API_KEY>
```

### 指定對象發訊息

```http
POST /control/line/push
```

範例 body：

```json
{
  "targetType": "group",
  "targetId": "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "text": "Seven Jr. 測試主動推送訊息。"
}
```

也可以一次推送多個對象：

```json
{
  "targets": [
    { "type": "user", "id": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
    { "type": "group", "id": "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
  ],
  "text": "這是一則批次通知。"
}
```

### 發送早報或晚報

```http
POST /control/reports/send
```

範例 body：

```json
{
  "reportType": "morning"
}
```

或：

```json
{
  "reportType": "daily"
}
```

若 body 沒有指定 targets，系統會使用 `SEVEN_REPORT_TARGET_ID` 作為預設推送對象。

## LINE 指令回覆

一般訊息只會收集到 Notion，不會自動回覆。以下指令例外：

- `早報`、`#早報`、`今日早報`、`#今日早報`、`行程`、`#行程`
- `報告`、`#報告`、`每日報告`、`#每日報告`

這些指令會回覆對應的報告網頁連結。

## 啟動

```powershell
npm start
```

`npm start` 會同時啟動 Webhook 與控制 API。
