require('dotenv').config();
const express = require('express');
const { messagingApi, middleware } = require('@line/bot-sdk');
const { estimateFoodFromImage } = require('./visionEstimate');
const { addMealLog, addBodyWeightLog, updateMealSlot, getFoodRegistry, addFoodRegistry } = require('./sheetsWriter');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const nutritionDb = require('./nutrition-db.json');

// Gemini API初期化
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

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

// 食品登録待ちユーザーを一時保存（key: userId）
const pendingFoodRegistrations = new Map();
const FOOD_REGISTRY_TTL_MS = 5 * 60 * 1000; // 5分

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
 * Gemini APIで食品のカロリーを推定
 * @param {string} foodName - 食品名
 * @returns {Object} 推定栄養値 {calorie, protein, fat, carb}
 */
async function estimateNutritionByGemini(foodName) {
  try {
    console.log(`🤖 Gemini APIで "${foodName}" のカロリーを推定中...`);

    const prompt = `以下の食品のカロリーと栄養成分（タンパク質、脂肪、炭水化物）を推定してください。

食品名: ${foodName}

以下のJSON形式で返してください。数値のみで単位は含めないでください：
{
  "calorie": 数値,
  "protein": 数値,
  "fat": 数値,
  "carb": 数値
}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // JSON を抽出
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Gemini APIのレスポンスが解析できません');
    }

    const nutrition = JSON.parse(jsonMatch[0]);
    console.log(`✅ Gemini推定: ${foodName} = ${nutrition.calorie}kcal`);

    return {
      calorie: parseFloat(nutrition.calorie) || 0,
      protein: parseFloat(nutrition.protein) || 0,
      fat: parseFloat(nutrition.fat) || 0,
      carb: parseFloat(nutrition.carb) || 0,
    };

  } catch (error) {
    console.error('❌ Gemini推定エラー:', error.message);
    // エラー時はデフォルト値を返す
    return {
      calorie: 200,
      protein: 10,
      fat: 10,
      carb: 20,
    };
  }
}

/**
 * 認識された食べ物から栄養値を推定（DB + Gemini統合）
 */
async function estimateNutrition(foodName, foodRegistry = {}) {
  const foodLower = foodName.toLowerCase();

  // Step 1: food_registry で検索
  if (foodRegistry[foodLower]) {
    console.log(`✅ food_registry で見つかりました: ${foodName}`);
    return foodRegistry[foodLower];
  }

  // Step 2: nutrition-db.json で検索
  for (const [key, nutrition] of Object.entries(nutritionDb)) {
    if (key.toLowerCase().includes(foodLower) || foodLower.includes(key.toLowerCase())) {
      console.log(`✅ nutrition-db で見つかりました: ${key}`);
      return {
        calorie: nutrition.calorie,
        protein: nutrition.protein,
        fat: nutrition.fat,
        carb: nutrition.carb,
      };
    }
  }

  // Step 3: Gemini APIで推定
  console.log(`⚠️  DBに見つかりません。Gemini APIで推定します...`);
  return await estimateNutritionByGemini(foodName);
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
  // webhook返信は200を即座に返す
  res.json({ success: true });

  // イベント処理は非同期で実行（エラーが発生しても返信には影響しない）
  Promise.all(req.body.events.map(async (event) => {
    try {
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

        // 食事確認待ちユーザーからの確認・修正リクエスト
        const confirmText = trimmedText.toLowerCase();
        const userId = event.source && event.source.userId;
        const pending = userId ? pendingMealConfirmations.get(userId) : null;

        if (pending && pending.status === 'food_confirmation_pending' && pending.expireAt > Date.now()) {
          // 確認待ちステータス中の処理
          if (confirmText === '確認' || confirmText === 'ok' || confirmText === 'ｏｋ') {
            // ユーザーが「確認」と返信した場合：ビジョン推定を保存
            try {
              const visionResult = pending.visionResult;
              const foodRegistry = await getFoodRegistry();

              // 選択された食べ物の栄養値を推定
              const selectedFoodNames = visionResult.selectedCandidates.map(c => c.foodName).join(',');
              const nutritionEstimate = await estimateNutrition(selectedFoodNames, foodRegistry);

              // Google Sheetsに記録
              const autoMealSlot = getMealSlotByTime();
              const mealData = {
                meal_slot: autoMealSlot,
                estimated_foods: selectedFoodNames,
                estimated_calorie: nutritionEstimate.calorie,
                protein_g: nutritionEstimate.protein,
                fat_g: nutritionEstimate.fat,
                carb_g: nutritionEstimate.carb,
                confidence: 'confirmed',
                memo: `確認: ${visionResult.selectedCandidates.map(c => c.foodName).join(', ')}`,
              };

              const sheetResult = await addMealLog(mealData);

              // 書き込んだ行番号を取得し、時間帯確認の状態を保存（10分間有効）
              const updatedRange = sheetResult && sheetResult.updates && sheetResult.updates.updatedRange;
              const rowMatch = updatedRange && updatedRange.match(/(\d+)/);
              if (rowMatch && userId) {
                pendingMealConfirmations.set(userId, {
                  row: parseInt(rowMatch[1], 10),
                  expireAt: Date.now() + MEAL_CONFIRM_TTL_MS,
                });
              }

              // 確認待ちステータスを削除
              pendingMealConfirmations.delete(userId);

              // 結果をLINEに返信
              const replyText =
`✅ 食事を記録しました！

🍽️  推定食品: ${selectedFoodNames}
🔥 カロリー: ${Math.round(nutritionEstimate.calorie)}kcal
🥛 タンパク質: ${Math.round(nutritionEstimate.protein * 10) / 10}g
🧈 脂質: ${Math.round(nutritionEstimate.fat * 10) / 10}g
🌾 炭水化物: ${Math.round(nutritionEstimate.carb * 10) / 10}g

🕐 時間帯: ${autoMealSlot}（自動判定）
違う場合は下のボタンから選び直してください`;

              await replyWithMealSlotQuickReply(event.replyToken, replyText);
              return;

            } catch (error) {
              console.error('食事確認エラー:', error.message);
              await replyToUser(event.replyToken, '❌ 食事の確認に失敗しました');
              return;
            }
          } else {
            // 「確認」以外のテキスト → 食品名として処理し、修正食品で確認待ちに戻す
            try {
              const foodRegistry = await getFoodRegistry();
              const foodName = trimmedText;

              console.log(`🔄 食品名を修正: ${foodName}`);

              // 修正開始メッセージを即座に返信
              await replyToUser(event.replyToken, `✏️ 修正を開始します...`);

              const nutrition = await estimateNutrition(foodName, foodRegistry);

              // 修正された食品で確認待ちを更新
              const autoMealSlot = getMealSlotByTime();
              const modifiedResult = {
                status: 'needs_confirmation',
                selectedCandidates: [{ foodName: foodName }],
                alternativeCandidates: [],
                excludedLabels: [],
                portion: 'normal',
                portionLabel: '普通盛り前提',
                message: `${foodName}として修正しました。量は普通盛り前提です。内容を確認してください。`,
              };

              // 確認待ちデータを更新
              pendingMealConfirmations.set(userId, {
                status: 'food_confirmation_pending',
                visionResult: modifiedResult,
                foodName: foodName,
                nutrition: nutrition,
                createdAt: Date.now(),
                expireAt: Date.now() + MEAL_CONFIRM_TTL_MS,
              });

              const replyText = `✅ 修正しました\n\n🍽️ ${modifiedResult.message}\n\n${foodName}のカロリー: 約${Math.round(nutrition.calorie)}kcal\n\nOKなら「確認」と返信、修正する場合は直接料理名を入力してください。`;
              await replyToUser(event.replyToken, replyText);
              return;

            } catch (error) {
              console.error('食品修正エラー:', error.message);
              await replyToUser(event.replyToken, `❌ 食品「${trimmedText}」の処理に失敗しました。別の料理名を入力してください。`);
              return;
            }
          }
        }

        console.log('📝 テキスト内容:', text);

        // 食品登録フロー
        if (confirmText === '登録') {
          // 食品登録開始
          if (userId) {
            pendingFoodRegistrations.set(userId, {
              step: 'food_name',
              data: {},
              expireAt: Date.now() + FOOD_REGISTRY_TTL_MS,
            });
            await replyToUser(event.replyToken, '食品を登録します。登録する食品名を入力してください（例：コーヒー）');
          }
          return;
        }

        // 食品登録待ち中の処理
        const foodReg = userId ? pendingFoodRegistrations.get(userId) : null;
        if (foodReg && foodReg.expireAt > Date.now()) {
          try {
            const trimmedInput = trimmedText;

            if (foodReg.step === 'food_name') {
              foodReg.data.foodName = trimmedInput;
              foodReg.step = 'calorie';
              await replyToUser(event.replyToken, `「${trimmedInput}」を登録します。カロリー（kcal）を入力してください（例：50）`);
              return;
            } else if (foodReg.step === 'calorie') {
              const calorie = parseFloat(trimmedInput);
              if (isNaN(calorie)) {
                await replyToUser(event.replyToken, '❌ 数値で入力してください');
                return;
              }
              foodReg.data.calorie = calorie;
              foodReg.step = 'protein';
              await replyToUser(event.replyToken, `タンパク質（g）を入力してください（例：0）`);
              return;
            } else if (foodReg.step === 'protein') {
              const protein = parseFloat(trimmedInput);
              if (isNaN(protein)) {
                await replyToUser(event.replyToken, '❌ 数値で入力してください');
                return;
              }
              foodReg.data.protein = protein;
              foodReg.step = 'fat';
              await replyToUser(event.replyToken, `脂質（g）を入力してください（例：0）`);
              return;
            } else if (foodReg.step === 'fat') {
              const fat = parseFloat(trimmedInput);
              if (isNaN(fat)) {
                await replyToUser(event.replyToken, '❌ 数値で入力してください');
                return;
              }
              foodReg.data.fat = fat;
              foodReg.step = 'carb';
              await replyToUser(event.replyToken, `炭水化物（g）を入力してください（例：0）`);
              return;
            } else if (foodReg.step === 'carb') {
              const carb = parseFloat(trimmedInput);
              if (isNaN(carb)) {
                await replyToUser(event.replyToken, '❌ 数値で入力してください');
                return;
              }
              foodReg.data.carb = carb;

              // Google Sheetsに登録
              await addFoodRegistry(foodReg.data);
              pendingFoodRegistrations.delete(userId);

              await replyToUser(event.replyToken,
                `✅ 食品「${foodReg.data.foodName}」を登録しました！
カロリー: ${foodReg.data.calorie}kcal
タンパク質: ${foodReg.data.protein}g
脂質: ${foodReg.data.fat}g
炭水化物: ${foodReg.data.carb}g

今後、この食品を入力すると登録されたカロリーが使用されます。`);
              return;
            }
          } catch (error) {
            console.error('食品登録エラー:', error.message);
            pendingFoodRegistrations.delete(userId);
            await replyToUser(event.replyToken, `❌ 食品登録に失敗しました: ${error.message}`);
            return;
          }
        }

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
          return;
        }

        // その他のテキスト
        await replyToUser(event.replyToken, 'ℹ️ 食べ物の画像を送るか、「登録」で食品を新規登録できます。');

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

          // Vision APIで食べ物を認識（確認待ちステータスで返される）
          const visionResult = await estimateFoodFromImage(imageBuffer);

          // ステータスに応じた処理
          if (visionResult.status === 'needs_manual_input') {
            // 手動入力が必要な場合
            console.log('⚠️  料理を認識できません');
            await replyToUser(event.replyToken, visionResult.message);
            return;
          }

          if (visionResult.status === 'needs_confirmation') {
            // 確認待ちステータス：候補をユーザーに表示
            console.log('📋 確認待ち：候補を表示中');

            const userId = event.source && event.source.userId;
            const selectedFoods = visionResult.selectedCandidates.map(c => c.foodName).join('、');

            // 確認待ちデータを保存（ユーザーが確認するまで保持）
            if (userId) {
              pendingMealConfirmations.set(userId, {
                status: 'food_confirmation_pending',
                visionResult: visionResult,
                createdAt: Date.now(),
                expireAt: Date.now() + MEAL_CONFIRM_TTL_MS,
              });
            }

            // ユーザーに確認メッセージを返信
            let confirmMessage = `🍽️ ${visionResult.message}\n\n`;
            confirmMessage += `主候補: ${selectedFoods}\n`;
            confirmMessage += `量: ${visionResult.portionLabel}\n`;

            if (visionResult.alternativeCandidates && visionResult.alternativeCandidates.length > 0) {
              confirmMessage += `\n他の候補:\n`;
              visionResult.alternativeCandidates.slice(0, 3).forEach((cand, idx) => {
                confirmMessage += `  ${idx + 1}. ${cand.foodName}\n`;
              });
            }

            if (visionResult.excludedLabels && visionResult.excludedLabels.length > 0) {
              confirmMessage += `\n除外したラベル: ${visionResult.excludedLabels.join(', ')}\n`;
            }

            confirmMessage += `\n内容がOKなら「確認」と返信してください。修正する場合は直接料理名を入力してください。`;

            await replyToUser(event.replyToken, confirmMessage);
            return;
          }

          // 想定外のステータス
          console.error('未知のステータス:', visionResult.status);
          await replyToUser(event.replyToken, '❌ 予期しないエラーが発生しました');

        } catch (error) {
          console.error('画像処理エラー:', error.message);
          await replyToUser(event.replyToken, `❌ 画像処理に失敗しました: ${error.message}`);
        }
      }
      } catch (eventError) {
        console.error('❌ イベント処理エラー:', eventError.message);
      }
    }))
    .catch(err => {
      console.error('❌ Webhook処理エラー:', err);
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
