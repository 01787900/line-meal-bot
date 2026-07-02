# 📸 LINE 食事記録Bot

LINE のトーク画面に食事写真を送るだけで、自動的に栄養素を推定して Google Sheets に記録するBot です。

---

## ✨ 機能

- 🖼️ **写真から食べ物を認識**
  - Google Vision API で自動分析
  - 複数の食べ物を同時認識可能

- 📊 **栄養素を自動推定**
  - カロリー、タンパク質、脂質、炭水化物を計算
  - 信頼度レベルも表示

- 📱 **Google Sheets に自動記録**
  - 毎日の食事ログが蓄積される
  - 栄養管理が簡単に

- ⚖️ **体重管理対応**
  - テキストで「体重65.2」と送信すると自動記録

---

## 🚀 クイックスタート

### ローカルで試す

```bash
# 依存パッケージをインストール
npm install

# サーバーを起動
npm start

# 別ターミナルで .env ファイルに秘密情報を設定してください
```

### 本番環境にデプロイ

詳細は [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) を参照してください。

---

## 📁 ファイル構成

```
line-meal-bot/
├── index.js                   # メインサーバー（LINEメッセージ処理）
├── visionEstimate.js          # Google Vision API（画像認識）
├── sheetsWriter.js            # Google Sheets API（データ書き込み）
├── nutrition-db.json          # 食品栄養素データベース
├── .env                       # 環境変数（秘密情報）
├── .env.example               # 環境変数テンプレート
├── package.json               # Node.js プロジェクト設定
├── README.md                  # このファイル
└── DEPLOYMENT_GUIDE.md        # デプロイ手順
```

---

## 🔧 必要な設定

### 1. LINE Messaging API

- **Channel ID**: LINEから取得
- **Channel Secret**: LINEから取得
- **Channel Access Token**: LINEから取得

[LINE Developers](https://developers.line.biz) で設定

### 2. Google Cloud Vision API

- **Service Account JSON**: Google Cloudから取得
- **Project ID**: `sonorous-pact-501207-m2`

[Google Cloud Console](https://console.cloud.google.com) で設定

### 3. Google Sheets

- **Spreadsheet ID**: 共有スプレッドシートのID
- **Sheet 名**: `meal_logs`, `body_weight_logs` など（固定）

---

## 📚 使用技術

| 技術 | 用途 |
|------|------|
| **Node.js** | サーバー実行環境 |
| **Express** | HTTPサーバー |
| **@line/bot-sdk** | LINE Messaging API |
| **@google-cloud/vision** | 画像認識AI |
| **googleapis** | Google Sheets API |
| **dotenv** | 環境変数管理 |

---

## 🎯 動作フロー

```
1. ユーザーが LINE で写真を送信
         ↓
2. サーバーが Webhook で受け取る
         ↓
3. Google Vision API で食べ物を認識
         ↓
4. nutrition-db.json から栄養値を参照
         ↓
5. Google Sheets に書き込み
         ↓
6. LINE に結果を返信
```

---

## 📝 使用例

### 食事を記録

```
📱 ユーザー: [写真]
🤖 Bot:
✅ 食事を記録しました！

🍽️  推定食品: ご飯, 鶏の唐揚げ, 味噌汁
🔥 カロリー: 680kcal
🥛 タンパク質: 25.0g
🧈 脂質: 33.0g
🌾 炭水化物: 65.0g
📊 信頼度: high
```

### 体重を記録

```
📱 ユーザー: 体重65.2
🤖 Bot: ✅ 体重 65.2kg を記録しました
```

---

## ⚠️ 注意事項

- Google Vision API の無料枠は月1000件です
- 栄養値はあくまで推定値です（参考値としてご利用ください）
- Google Sheets のシート名を変更しないでください

---

## 🐛 トラブル対応

### よくあるエラー

| エラー | 原因 | 対応 |
|--------|------|------|
| `401 Unauthorized` | 認証情報が無効 | .env を再確認 |
| `403 Forbidden` | Sheets の権限がない | シートの共有権限を確認 |
| `Vision API not enabled` | APIが有効になっていない | Google Cloudで有効化 |

---

## 📮 サポート

問題が発生した場合は、以下を確認してください：

1. `.env` ファイルの秘密情報が正しいか
2. LINE Developers で Webhook URL が正しく設定されているか
3. Google Sheets にアクセス権限があるか
4. インターネット接続が正常か

---

## 📄 ライセンス

MIT License

---

**Happy food tracking! 🍱**
