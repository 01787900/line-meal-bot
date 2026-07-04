require('dotenv').config();
const express = require('express');
const { messagingApi, middleware } = require('@line/bot-sdk');
const { estimateFoodFromImage } = require('./visionEstimate');
const { addMealLog, addBodyWeightLog, updateMealSlot } = require('./sheetsWriter');
const nutritionDb = require('./nutrition-db.json');
const foodTranslation = require('./foodTranslation.json');
const foodLabelIgnoreList = require('./foodLabelIgnoreList.json');
const nutritionGroups = require('./nutritionGroups.json');

const app = express();
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const blobClient = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// 食事の時間帯確認待ちユーザーを一時保存するメモリ（key: userId）
const pendingMealConfirmations = new Map();
const MEAL_CONFIRM_TTL_MS = 10 * 60 * 1000; // 10分
/**
* 現在時刻（JST）から食事の時間帯を自動判定
*/
function getMealSlotByTime() {
  const now = new Date();
  const jstHour = (now.getUTCHours() + 9) % 24;

if (jstHour >= 5 && jstHour < 10) return '朝食';
  if (jstHour >= 10 && jstHour < 14) return '昼食';
  if (jstHour >= 14 && jstHour < 17) return '間食';
  if (jstHour >= 17 && jstHour < 21) return '夕食';
  return '間食';
}

/**
* 食事の時間帯確認をLINEにクイックリプライ付きで返信
*/
async function replyWithMealSlotQuickReply(replyToken, text) {
  try {
    await client.replyMessage({
      replyToken: replyToken,
      messages: [{
        type: 'text',
        text: text,
        quickReply: {
          items: ['朝食', '昼食', '夕食', '間食'].map((label) => ({
            type: 'action',
            action: { type: 'message', label: label, text: label },
          })),
        },
      }],
    });
    console.log('✉️ LINEに返信しました（時間帯クイックリプライ付き）');
  } catch (error) {
    console.error('❌ LINE返信エラー:', error.message);
  }
}
// LINE Webhook middleware
app.use(middleware({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
}));

/**
* Vision APIのラベルを正規化する（小文字化・前後空白除去）
*/
function normalizeLabel(label) {
  return (label || '').toLowerCase().trim();
}

/**
* 認識ラベル1件を、栄養データベースの日本語キーに解決する
* food/dish/ingredientのような抽象ラベルは無視し、
* 英語ラベルはfoodTranslation.jsonで日本語キーに変換してから照合する
*/
function resolveNutritionKey(normalizedLabel) {
  if (!normalizedLabel) return null;

if (foodLabelIgnoreList.some((ignored) => normalizedLabel === ignored || normalizedLabel.includes(ignored))) {
  return null;
}

const singular = normalizedLabel.endsWith('s') ? normalizedLabel.slice(0, -1) : normalizedLabel;
  for (const [enLabel, jaKey] of Object.entries(foodTranslation)) {
    if (normalizedLabel === enLabel || singular === enLabel || normalizedLabel.includes(enLabel)) {
      if (nutritionDb[jaKey]) return jaKey;
    }
  }

for (const key of Object.keys(nutritionDb)) {
  const keyLower = key.toLowerCase();
  if (keyLower.includes(normalizedLabel) || normalizedLabel.includes(keyLower)) {
    return key;
  }
}

return null;
}
/**
* 認識された食べ物ラベル（Vision APIのスコア付き）から栄養値を推定する
*
* Noodle / Spaghetti / Chinese noodles のように同じ料理を指す類義ラベルが
* 複数検出されても二重・多重カウントしないよう、栄養グループ（主食・肉・野菜など）
* ごとにスコアが最も高いラベル1件だけを採用してから合算する。
* 具体的な食品を1件も認識できなかった場合のみ、「その他」のデフォルト値を1回だけ使用し、
* その旨をlow_confidence_fallbackで通知する。
*/
function estimateNutrition(labels) {
  const sortedLabels = [...(labels || [])].sort((a, b) => (b.score || 0) - (a.score || 0));

const bestKeyByGroup = new Map();
  for (const label of sortedLabels) {
    const normalized = normalizeLabel(label.description);
    const key = resolveNutritionKey(normalized);
    if (!key) continue;

  const group = nutritionGroups[key] || 'その他';
    if (!bestKeyByGroup.has(group)) {
      bestKeyByGroup.set(group, key);
    }
  }

let totalCalorie = 0;
  let totalProtein = 0;
  let totalFat = 0;
  let totalCarb = 0;
  let lowConfidenceFallback = false;

if (bestKeyByGroup.size === 0) {
  const defaultNutrition = nutritionDb['その他'];
  totalCalorie = defaultNutrition.calorie;
  totalProtein = defaultNutrition.protein;
  totalFat = defaultNutrition.fat;
  totalCarb = defaultNutrition.carb;
  lowConfidenceFallback = true;
} else {
  for (const key of bestKeyByGroup.values()) {
    const nutrition = nutritionDb[key];
    totalCalorie += nutrition.calorie;
    totalProtein += nutrition.protein;
    totalFat += nutrition.fat;
    totalCarb += nutrition.carb;
  }
}

return {
  estimated_calorie: Math.round(totalCalorie),
  protein_g: Math.round(totalProtein * 10) / 10,
  fat_g: Math.round(totalFat * 10) / 10,
  carb_g: Math.round(totalCarb * 10) / 10,
  low_confidence_fallback: lowConfidenceFallback,
};
}
/**
* LINEに返信
*/
async function replyToUser(replyToken, text) {
  try {
    await client.replyMessage({
      replyToken: replyToken,
      messages: [{
        type: 'text',
        text: text,
      }],
    });
    console.log('✉️ LINEに返信しました');
  } catch (error) {
    console.error('❌ LINE返信エラー:', error.message);
  }
}

// Webhook endpoint
app.post('/webhook', (req, res) => {
  Promise.all(req.body.events.map(async (event) => {
    console.log('\n========== 新しいメッセージを受け取りました ==========');
    console.log('イベントタイプ:', event.type);

                                  if (event.type === 'message') {
                                    console.log('メッセージタイプ:', event.message.type);

    // テキストメッセージ処理
    if (event.message.type === 'text') {
      const text = event.message.text;

                                    // 食事の時間帯クイックリプライへの返信を判定
                                    const mealSlotKeywords = ['朝食', '昼食', '夕食', '間食'];
      const trimmedText = text.trim();
      if (mealSlotKeywords.includes(trimmedText)) {
        const userId = event.source && event.source.userId;
        const pending = userId ? pendingMealConfirmations.get(userId) : null;

      if (pending && pending.expireAt > Date.now()) {
        try {
          await updateMealSlot(pending.row, trimmedText);
          pendingMealConfirmations.delete(userId);
          await replyToUser(event.replyToken, `✅ 食事の時間帯を「${trimmedText}」に更新しました`);
        } catch (error) {
          console.error('時間帯更新エラー:', error.message);
          await replyToUser(event.replyToken, '❌ 時間帯の更新に失敗しました');
        }
      } else {
        await replyToUser(event.replyToken, 'ℹ️ 確認可能な直近の食事記録が見つかりませんでした（10分以内に送信された画像のみ変更できます）');
      }

      return;
      }
      console.log('📝 テキスト内容:', text);
      // 体重テキスト判定（例：「体重65.2」）
                                    const weightMatch = text.match(/体重([\d.]+)/);
      if (weightMatch) {
        const weight = parseFloat(weightMatch[1]);
        console.log('⚖️ 体重データ検出:', weight, 'kg');

      try {
        await addBodyWeightLog(weight, '');
        await replyToUser(event.replyToken, `✅ 体重 ${weight}kg を記録しました`);
      } catch (error) {
        console.error('体重記録エラー:', error.message);
        await replyToUser(event.replyToken, '❌ 体重記録に失敗しました');
      }
      }

    }
                                    // 画像メッセージ処理
    else if (event.message.type === 'image') {
                                    console.log('🖼️ 画像を受け取りました');

      try {   
        // LINEから画像をダウンロード
                                    console.log('📥 画像をダウンロード中...');
      const stream = await blobClient.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const imageBuffer = Buffer.concat(chunks);

                                    // Vision APIで食べ物を認識
                                    const visionResult = await estimateFoodFromImage(imageBuffer);

                                    // 栄養値を推定（ラベルのスコアを使ってグループごとに重複排除する）
                                    const nutritionEstimate = estimateNutrition(visionResult.labels);


                                    // Google Sheetsに記録
                                    const autoMealSlot = getMealSlotByTime();
        const mealData = {
          meal_slot: autoMealSlot,
          estimated_foods: visionResult.estimated_foods,
          ...nutritionEstimate,
          confidence: visionResult.confidence,
          memo: `信頼度: ${visionResult.confidence}`,
        };

                                    const sheetResult = await addMealLog(mealData);

                                    // 書き込んだ行番号を取得し、時間帯確認の状態を保存（10分間有効）
                                    const updatedRange = sheetResult && sheetResult.updates && sheetResult.updates.updatedRange;
        const rowMatch = updatedRange && updatedRange.match(/(\d+)/);
        const userId = event.source && event.source.userId;
        if (rowMatch && userId) {
          pendingMealConfirmations.set(userId, {
            row: parseInt(rowMatch[1], 10),
            expireAt: Date.now() + MEAL_CONFIRM_TTL_MS,
          });
        }

                                    // 結果をLINEに返信
                                    const lowConfidenceNote = nutritionEstimate.low_confidence_fallback
        ? '\n⚠️ 具体的な食品を認識できなかったため、栄養値は概算です'
                                      : '';
        const replyText =
          `✅ 食事を記録しました！
          🍽️ 推定食品: ${visionResult.estimated_foods}
          🔥 カロリー: ${nutritionEstimate.estimated_calorie}kcal
          🥛 タンパク質: ${nutritionEstimate.protein_g}g
          🧈 脂質: ${nutritionEstimate.fat_g}g
          🌾 炭水化物: ${nutritionEstimate.carb_g}g
          📊 信頼度: ${visionResult.confidence}${lowConfidenceNote}
          🕐 時間帯: ${autoMealSlot}（自動判定）
          違う場合は下のボタンから選び直してください`;

                                    await replyWithMealSlotQuickReply(event.replyToken, replyText);
      } catch (error) {
        console.error('画像処理エラー:', error.message);
        await replyToUser(event.replyToken, `❌ 画像処理に失敗しました: ${error.message}`);
      }
                                  }
  }

                                  return Promise.resolve();
}))
.then(() => res.json({ success: true }))
.catch(err => {
  console.error('❌ エラー:', err);
  res.status(500).end();
});
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 LINE Bot サーバーが起動しました（ポート ${PORT}）`);
  console.log(`ウェブフック URL: http://localhost:${PORT}/webhook`);
  console.log('LINEボットからメッセージを送ると、ここに表示されます...\n');
});
