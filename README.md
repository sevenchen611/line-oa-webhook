# LINE OA Webhook

這是一個最小可用的 LINE Official Account Webhook 接收端。

## 本機啟動

1. 複製環境變數：

```powershell
Copy-Item .env.example .env
```

2. 在 `.env` 填入 LINE Developers Console 裡的：

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

3. 啟動：

```powershell
node src/server.js
```

本機 Webhook endpoint 是：

```text
http://localhost:3000/webhook/line
```

LINE Webhook URL 不能使用 `localhost`，必須填公開 HTTPS 網址。

## 取得公開 HTTPS 網址

最穩的做法是部署到 Render。部署完成後，Render 會提供一個公開網址，例如：

```text
https://line-oa-webhook.onrender.com
```

LINE Developers Console 裡要填的是加上路徑後的完整 Webhook URL：

```text
https://line-oa-webhook.onrender.com/webhook/line
```

## Render 部署

1. 把這個 repo 連到 Render。
2. Render 會讀取 `render.yaml` 建立 `line-oa-webhook` 服務。
3. 在 Render 的 Environment 填入：

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

4. 部署完成後，把 Render 的公開網址加上 `/webhook/line`，填到 LINE Developers Console。

## LINE Developers Console 設定

到 Channel ID `2010309641` 的 Messaging API 分頁：

1. 找到 Webhook settings。
2. 在 Webhook URL 填入公開 HTTPS Webhook URL。
3. 開啟 Use webhook。
4. 按 Verify 確認成功。
5. 若還沒有 Channel access token，請在 Messaging API 分頁發行，並填到 Render Environment。

目前程式會把使用者文字訊息回覆成：

```text
收到：使用者訊息
```
