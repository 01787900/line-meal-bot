# Render.com デプロイガイド

このガイドは、LINE食事記録Botを Render.com にデプロイするための手順です。

---

## 📋 必要な準備物

- GitHub アカウント（コードをアップロードするため）
- Render.com アカウント

---

## ステップ1：GitHub にリポジトリをアップロード

### 1-1. GitHub で新しいリポジトリを作成

1. https://github.com/new にアクセス
2. リポジトリ名に `line-meal-bot` と入力
3. 「Create repository」をクリック

### 1-2. ローカルからプッシュ

```bash
cd /Users/yumaofuji/line-meal-bot

# Gitを初期化（初回のみ）
git init
git add .
git commit -m "Initial commit: LINE meal bot"

# GitHubにプッシュ（<your-username> と <your-repo-name> を置き換え）
git branch -M main
git remote add origin https://github.com/<your-username>/line-meal-bot.git
git push -u origin main
```

---

## ステップ2：Render.com にサインアップ

1. https://render.com にアクセス
2. 「Sign up」をクリック
3. GitHub アカウントで連携（推奨）

---

## ステップ3：Web Service を作成

1. Render.com ダッシュボードで「New」をクリック
2. 「Web Service」を選択
3. GitHub リポジトリを接続
   - 「line-meal-bot」を検索して選択
   - 「Connect」をクリック

---

## ステップ4：デプロイ設定

### 4-1. 基本設定

| 項目 | 値 |
|------|-----|
| **Name** | `line-meal-bot`（自動入力される） |
| **Environment** | `Node` |
| **Region** | `Singapore` （低遅延推奨） |
| **Branch** | `main` |

### 4-2. Build & Start Commands

以下はデフォルトのままで OK：

- **Build Command** : `npm install`
- **Start Command** : `npm start`

---

## ステップ5：環境変数を設定

1. 「Environment」セクションまでスクロール
2. 以下の環境変数を追加します：

| キー | 値 |
|------|-----|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging APIから取得した値 |
| `LINE_CHANNEL_SECRET` | LINE Messaging APIから取得した値 |
| `GOOGLE_CLOUD_PROJECT_ID` | `sonorous-pact-501207-m2` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service Account JSON（全文） |
| `GOOGLE_SPREADSHEET_ID` | `1D8eExKUQgKtreLAXCL6Z70kaHMsoYtRWA0PGQr2KaNQ` |
| `PORT` | `3000` |

**注意：** `GOOGLE_SERVICE_ACCOUNT_JSON` は、.env ファイルの値をそのままコピーしてください。

---

## ステップ6：デプロイ実行

1. 「Create Web Service」をクリック
2. デプロイが開始します（3～5分待つ）
3. ✅「Your service is live!」と表示されたら成功

---

## ステップ7：LINE Messaging API の Webhook URL を更新

デプロイが完了したら、Render.com から割り当てられた **URL** を取得します。

### URL を確認

1. Render.com ダッシュボード → Web Service をクリック
2. 画面上部の「Service URL」をコピー
3. 例：`https://line-meal-bot-xxxx.onrender.com`

### LINE Developers で Webhook URL を更新

1. https://developers.line.biz にログイン
2. チャネルを選択 → 「Messaging API設定」
3. **Webhook URL** を以下のように設定：
   ```
   https://line-meal-bot-xxxx.onrender.com/webhook
   ```
   （`xxxx` は Render が割り当てたID）

4. 「Webhook の使用」を **有効** にする

---

## ステップ8：動作確認

1. LINE ボットに写真を送信
2. サーバーログで処理状況を確認
   - Render.com ダッシュボード → 「Logs」タブ

### ログで確認できる内容

```
🚀 LINE Bot サーバーが起動しました (ポート 3000)
========== 新しいメッセージを受け取りました ==========
🖼️  画像を受け取りました
🔍 Google Vision APIで画像を分析中...
✅ 認識完了: ご飯, 鶏の唐揚げ, 味噌汁
📝 Google Sheetsに食事データを書き込み中...
✅ 食事ログを追加しました
✉️  LINEに返信しました
```

---

## トラブルシューティング

### Q. デプロイに失敗した

**A.** ログを確認してください：
- Render.com ダッシュボード → 「Logs」タブ
- エラーメッセージを見て対応

### Q. LINE ボットが返信しない

**A.** 以下を確認：
1. Webhook URL が正しく設定されているか
2. 環境変数が正しく入力されているか
3. Google認証情報が有効か

### Q. Google Sheets に書き込まれない

**A.** Google Sheets のアクセス権限を確認：
1. スプレッドシートを開く
2. 「共有」ボタンで、Service Account のメールアドレス（`line-meal-bot@...@iam.gserviceaccount.com`）を追加

---

## 📊 使用方法

### 食事を記録

1. LINE ボットに **写真** を送信
2. 自動的に分析・記録されます
3. 結果が返信されます

### 体重を記録

1. LINE ボットに **「体重65.2」** などとテキスト送信
2. 自動的に記録されます

---

## 💡 今後の改善案

- [ ] 毎日の栄養目標値との比較
- [ ] 食べ物の種類判定を改善（複数食の認識）
- [ ] レポート機能（週間・月間集計）
- [ ] AIによる栄養アドバイス

---

**デプロイ成功！🎉**
