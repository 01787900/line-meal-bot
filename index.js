require('dotenv').config();
const express = require('express');
const { messagingApi, middleware } = require('@line/bot-sdk');
const { estimateFoodFromImage } = require('./visionEstimate');
const { addMealLog, addBodyWeightLog } = require('./sheetsWriter');
const nutritionDb = require('./nutrition-db.json');

const app = express();
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const blobClient = new messagingApi.MessagingApiBlobClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// LINE Webhook middleware
app.use(middleware({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
}));

/**
 * 認識された食べ物から栄養値を推定
 */
function estimateNutrition(foodNames) {
  const foods = foodNames.split(',').map(f => f.trim());
  let totalCalorie = 0;
  let totalProtein = 0;
  let totalFat = 0;
  let totalCarb = 0;
  let matchedCount = 0;

  for (const food of foods) {
    const foodLower = food.toLowerCase();

    // 完全一致または部分一致で栄養値を探す
    let found = false;
    for (const [key, nutrition] of Object.entries(nutritionDb)) {
      if (key.toLowerCase().includes(foodLower) || foodLower.includes(key.toLowerCase())) {
        totalCalorie += nutrition.calorie;
        totalProtein += nutrition.protein;
        totalFat += nutrition.fat;
        totalCarb += nutrition.carb;
        matchedCount++;
        found = true;
        break;
      }
    }

    // マッチしなかった場合はデフォルト値を使用
    if (!found) {
      const defaultNutrition = nutritionDb['その他'];
      totalCalorie += defaultNutrition.calorie;
      totalProtein += defaultNutrition.protein;
      totalFat += defaultNutrition.fat;
      totalCarb += defaultNutrition.carb;
      matchedCount++;
    }
  }

  return {
    estimated_calorie: Math.round(totalCalorie),
    protein_g: Math.round(totalProtein * 10) / 10,
    fat_g: Math.round(totalFat * 10) / 10,
    carb_g: Math.round(totalCarb * 10) / 10,
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
    console.log('✉️  LINEに返信しました');
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
        console.log('📝 テキスト内容:', text);

        // 体重テキスト判定（例：「体重65.2」）
        const weightMatch = text.match(/体重([\d.]+)/);
        if (weightMatch) {
          const weight = parseFloat(weightMatch[1]);
          console.log('⚖️  体重データ検出:', weight, 'kg');

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
        console.log('🖼️  画像を受け取りました');

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

          // 栄養値を推定
          const nutritionEstimate = estimateNutrition(visionResult.estimated_foods);

          // Google Sheetsに記録
          const mealData = {
            meal_slot: 'lunch',
            estimated_foods: visionResult.estimated_foods,
            ...nutritionEstimate,
            confidence: visionResult.confidence,
            memo: `信頼度: ${visionResult.confidence}`,
          };

          await addMealLog(mealData);

          // 結果をLINEに返信
          const replyText =
`✅ 食事を記録しました！

🍽️  推定食品: ${visionResult.estimated_foods}
🔥 カロリー: ${nutritionEstimate.estimated_calorie}kcal
🥛 タンパク質: ${nutritionEstimate.protein_g}g
🧈 脂質: ${nutritionEstimate.fat_g}g
🌾 炭水化物: ${nutritionEstimate.carb_g}g
📊 信頼度: ${visionResult.confidence}`;

          await replyToUser(event.replyToken, replyText);

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
  console.log(`\n🚀 LINE Bot サーバーが起動しました (ポート ${PORT})`);
  console.log(`ウェブフック URL: http://localhost:${PORT}/webhook`);
  console.log('LINEボットからメッセージを送ると、ここに表示されます...\n');
});
