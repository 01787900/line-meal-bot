require('dotenv').config();
const express = require('express');
const { messagingApi, middleware } = require('@line/bot-sdk');
const { estimateFoodFromImage } = require('./visionEstimate');
const { addMealLog, appendMealLog, addBodyWeightLog, updateMealSlot, getFoodRegistry, addFoodRegistry } = require('./sheetsWriter');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const nutritionDb = require('./nutrition-db.json');
const {
  normalizeUserFoodName,
  normalizeFoodNameForCompare,
  filterIgnoredLabels,
  createLabelsKey,
  generateCandidatesFromLabels,
  findLearnedFood,
  updateLearnedFood,
} = require('./foodProcessing');

// Gemini API初期化
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-flash-lite-latest',
  apiVersion: 'v1'
});

const app = express();
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const blobClient = new messagingApi.MessagingApiBlobClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// 食事の時間帯確認待ちユーザーを一時保存するメモリ（key: userId）
const pendingMealConfirmations = new Map();
const MEAL_CONFIRM_TTL_MS = 15 * 60 * 1000; // 15分（確認→時間帯→分量フローのため延長）

// 食品登録待ちユーザーを一時保存（key: userId）
const pendingFoodRegistrations = new Map();
const FOOD_REGISTRY_TTL_MS = 5 * 60 * 1000; // 5分

// 不明食品の食品名入力待ちユーザーを一時保存（key: userId）
const pendingManualFoodInput = new Map();
const MANUAL_FOOD_INPUT_TTL_MS = 5 * 60 * 1000; // 5分

// 食事の時間帯（内部値 → 表示名）
const MEAL_TYPES = {
  breakfast: '朝食',
  lunch: '昼食',
  dinner: '夕食',
  snack: '間食',
  late_night: '夜食',
};

// 食事の分量オプション
const PORTION_OPTIONS = {
  small: {
    label: '少なめ',
    multiplier: 0.7,
  },
  normal: {
    label: '普通',
    multiplier: 1.0,
  },
  large: {
    label: '多め',
    multiplier: 1.3,
  },
  extra_large: {
    label: '大盛り',
    multiplier: 1.6,
  },
};

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
                                        items: Object.keys(MEAL_TYPES).map((key) => ({
                                                      type: 'action',
                                                      action: { type: 'message', label: MEAL_TYPES[key], text: MEAL_TYPES[key] },
                                        })),
                            },
                  }],
          });
          console.log('✉️ LINEに返信しました（時間帯クイックリプライ付き）');
    } catch (error) {
          console.error('❌ LINE返信エラー:', error.message);
    }
}

/**
 * 分量選択用のクイックリプライを送信
 */
async function replyWithPortionQuickReply(replyToken, text) {
    try {
          await client.replyMessage({
                  replyToken: replyToken,
                  messages: [{
                            type: 'text',
                            text: text,
                            quickReply: {
                                        items: Object.keys(PORTION_OPTIONS).map((key) => ({
                                                      type: 'action',
                                                      action: { type: 'message', label: PORTION_OPTIONS[key].label, text: PORTION_OPTIONS[key].label },
                                        })),
                            },
                  }],
          });
          console.log('✉️ LINEに返信しました（分量クイックリプライ付き）');
    } catch (error) {
          console.error('❌ LINE返信エラー:', error.message);
    }
}

/**
 * 栄養値を分量に応じて補正
 * @param {Object} nutrition - 栄養情報 {calories, protein, fat, carbs}
 * @param {number} multiplier - 分量倍率
 * @returns {Object} 補正後の栄養情報
 */
function applyPortionMultiplier(nutrition, multiplier = 1.0) {
  const m = Number(multiplier) || 1.0;
  return {
    calories: Math.round((Number(nutrition.calories || nutrition.calorie || 0)) * m),
    protein: Math.round((Number(nutrition.protein || 0)) * m * 10) / 10,
    fat: Math.round((Number(nutrition.fat || 0)) * m * 10) / 10,
    carbs: Math.round((Number(nutrition.carbs || nutrition.carb || 0)) * m * 10) / 10,
  };
}

/**
 * JST（日本時間）を ISO 8601形式で返す
 * @param {Date} date - 対象日時（デフォルト: 現在時刻）
 * @returns {string} ISO形式（+09:00タイムゾーン付き）
 */
function toJstIsoString(date = new Date()) {
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jstDate.toISOString().replace('Z', '+09:00');
}

/**
 * 食事時刻を決定（現時点ではfallbackDateを使用）
 * @param {*} userInput - ユーザー入力（将来の拡張用）
 * @param {Date} fallbackDate - フォールバック日時
 * @returns {string} ISO形式の食事時刻
 */
function resolveEatenAt(userInput, fallbackDate = new Date()) {
  // 現時点では fallbackDate を使用
  // 将来的に userInput を解析して時刻を推抽出
  return toJstIsoString(fallbackDate);
}

/**
 * ISO形式のJST時刻を表示用フォーマット（YYYY/MM/DD HH:mm）に変換
 * @param {string} isoString - ISO 8601形式の文字列
 * @returns {string} 表示用フォーマット
 */
function formatJstForDisplay(isoString) {
  const date = new Date(isoString);
  // ISO文字列をそのままJSTとして扱う（+09:00が含まれている想定）
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

/**
 * LINE送信用テキストを安全化
 * @param {string} text - 送信するテキスト
 * @returns {string} 安全化されたテキスト
 */
function safeLineText(text) {
  if (!text || typeof text !== 'string') {
    return '処理結果を送信できませんでした。もう一度お試しください。';
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '処理結果を送信できませんでした。もう一度お試しください。';
  }
  if (trimmed.length > 4900) {
    return trimmed.slice(0, 4900);
  }
  return trimmed;
}

// LINE Webhook middleware
app.use(middleware({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
}));

/**
 * 新しいフロー：learnedFoods → candidateRules → Gemini による食品推定
 * @param {Array} englishLabels - Vision API で検出された英語ラベル配列（文字列配列）
 * @returns {Object} {foodName, confidence, source, candidates, rawVisionLabels, filteredLabels, labelsKey}
 */
async function refineFoodWithLearning(englishLabels) {
  try {
    console.log('📋 新フロー: learnedFoods → candidateRules → Gemini');

    // Step 1: 英語ラベルを小文字化して正規化
    const labelStrings = englishLabels.map(l => typeof l === 'string' ? l.toLowerCase() : String(l).toLowerCase());
    const filtered = filterIgnoredLabels(labelStrings);
    const labelsKey = createLabelsKey(filtered);

    console.log(`ℹ️  フィルター後ラベル: ${filtered.join(', ')}`);
    console.log(`ℹ️  ラベルキー: ${labelsKey}`);

    // Step 2: learnedFoods から検索
    const learned = findLearnedFood(filtered);
    if (learned) {
      console.log(`✅ learnedFoods一致: ${learned.correct_food} (count: ${learned.count || 1})`);
      return {
        foodName: learned.correct_food,
        confidence: learned.confidence,
        source: 'learned',
        candidates: [learned.correct_food],
        rawVisionLabels: labelStrings,
        filteredLabels: filtered,
        labelsKey,
      };
    } else {
      console.log('🔎 learnedFoods検索: 一致なし');
    }

    // Step 3: candidateRules から候補生成
    const candidates = generateCandidatesFromLabels(filtered);
    console.log(`ℹ️  候補: ${candidates.join(', ')}`);

    // Step 4: Gemini で候補から選択
    let finalFood = candidates[0]; // デフォルトは第1候補
    let confidence = 0.7;

    if (candidates.length > 1) {
      try {
        const candidatesText = candidates.map((c, i) => `${i + 1}. ${c}`).join('\n');
        const prompt = `以下の候補の中から、最も適切な料理を1つだけ選んでください。

候補：
${candidatesText}

選んだ料理名のみを返してください。`;

        const result = await model.generateContent(prompt);
        const selected = result.response.text().trim();

        if (candidates.includes(selected)) {
          finalFood = selected;
          confidence = 0.85;
        }
      } catch (error) {
        console.warn('⚠️  Gemini候補選択エラー:', error.message);
        // エラー時はデフォルトの候補を使用
      }
    }

    console.log(`🎯 推定結果: ${finalFood} (信頼度: ${confidence})`);

    return {
      foodName: finalFood,
      confidence,
      source: 'estimated',
      candidates,
      rawVisionLabels: labelStrings,
      filteredLabels: filtered,
      labelsKey,
    };
  } catch (error) {
    console.error('❌ 食品推定エラー:', error.message);
    return {
      foodName: '不明',
      confidence: 0,
      source: 'error',
      candidates: [],
      rawVisionLabels: [],
      filteredLabels: [],
      labelsKey: '',
    };
  }
}

/**
 * Vision API の結果を Gemini で精査して、正確な料理名に改善
 * @param {Array} visionLabels - Vision API で検出されたラベル配列
 * @returns {string} Gemini で精査された料理名
 */
async function refineVisualRecognitionWithGemini(visionLabels) {
  try {
    console.log(`🧠 Vision APIの結果をGeminiで精査中...`);

    const labelsText = visionLabels.map(l => `- ${l.description}(${(l.score * 100).toFixed(0)}%)`).join('\n');

    const prompt = `以下のラベルから、最も可能性の高い料理名を1つだけ特定してください。

検出されたラベル：
${labelsText}

回答は料理名のみで、説明は不要です。例：「焼きそば」「カレーライス」「サラダ」`;

    const result = await model.generateContent(prompt);
    const refinedFoodName = result.response.text().trim();

    console.log(`✅ 精査結果: "${refinedFoodName}"`);
    return refinedFoodName;
  } catch (error) {
    console.error('❌ Gemini精査エラー:', error.message);
    // エラー時は空文字列を返す
    return '';
  }
}

/**
 * Gemini APIで食品のカロリーを推定
 * @param {string} foodName - 食品名
 * @returns {Object} 推定栄養値 {calorie, protein, fat, carb}
 */
async function estimateNutritionByGemini(foodName) {
  try {
    console.log(`🤖 Gemini APIで "${foodName}" のカロリーを推定中...`);
    console.log(`🔑 Gemini APIキーが設定されているか: ${process.env.GOOGLE_GENERATIVE_AI_KEY ? '✅ 設定済み' : '❌ 未設定'}`);

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
  const geminiResult = await estimateNutritionByGemini(foodName);
  console.log(`🎯 Gemini APIから取得した推定値: ${JSON.stringify(geminiResult)}`);
  return geminiResult;
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

/**
 * JST（日本時間）の日付と時刻を YYYY-MM-DD HH:mm:ss 形式で取得
 * @returns {string} 日本時間の日付・時刻
 */
function getJstDateTime() {
  const now = new Date();
  const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9

  const year = jstDate.getUTCFullYear();
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jstDate.getUTCDate()).padStart(2, '0');
  const hours = String(jstDate.getUTCHours()).padStart(2, '0');
  const minutes = String(jstDate.getUTCMinutes()).padStart(2, '0');
  const seconds = String(jstDate.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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
        const trimmedText = text.trim();
        const userId = event.source && event.source.userId;
        const pending = userId ? pendingMealConfirmations.get(userId) : null;

        // 食事の時間帯クイックリプライへの返信を判定
        const mealTypeLabels = Object.values(MEAL_TYPES); // 朝食, 昼食, 夕食, 間食, 夜食
        const mealTypeInternalMap = {
          '朝食': 'breakfast',
          '昼食': 'lunch',
          '夕食': 'dinner',
          '間食': 'snack',
          '夜食': 'late_night',
        };

        // 分量クイックリプライへの返信を判定
        const portionLabels = Object.values(PORTION_OPTIONS).map(p => p.label); // 少なめ, 普通, 多め, 大盛り
        const portionInternalMap = {
          '少なめ': 'small',
          '普通': 'normal',
          '多め': 'large',
          '大盛り': 'extra_large',
        };

        // *** 食事時間帯選択フロー (Step 2) ***
        if (mealTypeLabels.includes(trimmedText) && pending && pending.step === 'awaiting_meal_type' && pending.expireAt > Date.now()) {
          try {
            const mealType = mealTypeInternalMap[trimmedText];
            console.log(`🕐 時間帯を選択: ${trimmedText} (${mealType})`);

            // State を更新：mealType を設定して分量選択に進む
            pending.mealType = mealType;
            pending.step = 'awaiting_portion';
            pending.createdAt = Date.now();
            pending.expireAt = Date.now() + MEAL_CONFIRM_TTL_MS;
            pendingMealConfirmations.set(userId, pending);

            // 分量選択クイックリプライを送信
            await replyWithPortionQuickReply(
              event.replyToken,
              '量を選んでください。'
            );

            return;
          } catch (error) {
            console.error('❌ 時間帯処理エラー:', error.message);
            await replyToUser(event.replyToken, safeLineText('❌ 時間帯の処理に失敗しました'));
            return;
          }
        }

        // *** 分量選択フロー (Step 3) ***
        if (portionLabels.includes(trimmedText) && pending && pending.step === 'awaiting_portion' && pending.expireAt > Date.now()) {
          try {
            const portionKey = portionInternalMap[trimmedText];
            const portionOption = PORTION_OPTIONS[portionKey];

            console.log(`📏 分量を選択: ${trimmedText} (倍率: ${portionOption.multiplier})`);

            // 栄養値を分量に応じて補正
            const originalNutrition = pending.visionResult.nutrition;
            const adjustedNutrition = applyPortionMultiplier(originalNutrition, portionOption.multiplier);

            // 食事時刻を記録
            const eatenAt = resolveEatenAt(null, new Date());

            // State を更新：分量と食事時刻を設定して保存可能状態に
            pending.portionLabel = trimmedText;
            pending.portion = portionOption.multiplier;
            pending.portionMultiplier = portionOption.multiplier;
            pending.adjustedNutrition = adjustedNutrition;
            pending.eatenAt = eatenAt;
            pending.step = 'ready_to_save';
            pendingMealConfirmations.set(userId, pending);

            // Google Sheets に保存
            const visionResult = pending.visionResult;
            const foodName = visionResult.selectedCandidates[0].foodName;

            await appendMealLog({
              userId,
              detectedLabels: visionResult.detectedLabels || [],
              estimatedFood: visionResult.selectedCandidates[0].foodName,
              confirmedFood: foodName,
              confidence: visionResult.selectedCandidates[0].confidence || 0.7,
              portion: portionOption.multiplier,
              nutrition: adjustedNutrition,
              source: visionResult.source || 'image',
              status: 'confirmed',
              mealType: pending.mealType,
              portionLabel: trimmedText,
              portionMultiplier: portionOption.multiplier,
              rawVisionLabels: visionResult.rawVisionLabels || visionResult.detectedLabels || [],
              filteredLabels: visionResult.filteredLabels || [],
              labelsKey: visionResult.labelsKey || '',
              candidateFoods: visionResult.candidateFoods || [],
              eatenAt,
            });

            // 記録完了メッセージを送信
            const mealTypeDisplay = MEAL_TYPES[pending.mealType];
            const eatenAtFormatted = formatJstForDisplay(eatenAt);

            const recordMsg = safeLineText(`✅ 記録しました。
料理: ${foodName}
時間帯: ${mealTypeDisplay}
食事時刻: ${eatenAtFormatted}
量: ${trimmedText}
カロリー: ${Math.round(adjustedNutrition.calories)}kcal
P: ${adjustedNutrition.protein}g / F: ${adjustedNutrition.fat}g / C: ${adjustedNutrition.carbs}g`);

            await replyToUser(event.replyToken, recordMsg);

            // State を削除
            pendingMealConfirmations.delete(userId);

            return;
          } catch (error) {
            console.error('❌ 分量処理エラー:', error.message);
            await replyToUser(event.replyToken, safeLineText('❌ 分量の処理に失敗しました'));
            return;
          }
        }

        // *** 食事確認待ちユーザーからの確認・修正リクエスト (Step 1) ***
        const confirmText = trimmedText.toLowerCase();

        if (pending && pending.step === 'food_confirmation_pending' && pending.expireAt > Date.now()) {
          // 確認待ちステータス中の処理
          if (confirmText === '確認' || confirmText === 'ok' || confirmText === 'ｏｋ') {
            // ユーザーが「確認」と返信した場合：時間帯確認フロー
            try {
              const visionResult = pending.visionResult;
              const foodName = visionResult.selectedCandidates[0].foodName;

              console.log(`✅ 食事を確認しました: ${foodName}`);

              // 時間帯確認用のクイックリプライを送信
              await replyWithMealSlotQuickReply(
                event.replyToken,
                `${foodName} を記録します。\n食べた時間帯を選んでください。`
              );

              // pendingMealConfirmations を更新（時間帯確認待ちに）
              pending.step = 'awaiting_meal_type';
              pending.createdAt = Date.now();
              pending.expireAt = Date.now() + MEAL_CONFIRM_TTL_MS;
              pendingMealConfirmations.set(userId, pending);

              return;

            } catch (error) {
              console.error('❌ 食事確認エラー:', error.message);
              await replyToUser(event.replyToken, safeLineText('❌ 食事の記録に失敗しました'));
              return;
            }
          } else {
            // 「確認」以外のテキスト → 食品名として処理
            try {
              const foodRegistry = await getFoodRegistry();
              const modifiedFoodName = normalizeUserFoodName(trimmedText);

              // 比較対象は新フローの最終推定食品を使う
              const originalFood = pending.estimatedFood || pending.visionResult.selectedCandidates[0].foodName;

              const normalizedInput = normalizeFoodNameForCompare(modifiedFoodName);
              const normalizedEstimated = normalizeFoodNameForCompare(originalFood);

              if (normalizedInput === normalizedEstimated) {
                // 同じ食品 → 確認として扱う（修正ではない）
                console.log(`✅ 食品名は推定通りです: ${originalFood}`);

                pending.confirmedFood = originalFood;
                pending.status = "confirmed";

                // source は変更しない（estimatedなどの元の値を維持）
                // learnedFoods も更新しない

                pending.step = "awaiting_meal_type";
                await replyWithMealSlotQuickReply(event.replyToken);
                return;
              }

              // 異なる食品 → 修正として扱う
              console.log(`🔄 食品名を修正: ${originalFood} → ${modifiedFoodName}`);

              updateLearnedFood(
                pending.filteredLabels || pending.visionResult.filteredLabels || pending.visionResult.rawVisionLabels || [],
                originalFood,
                modifiedFoodName
              );

              const nutrition = await estimateNutrition(modifiedFoodName, foodRegistry);

              pending.confirmedFood = modifiedFoodName;
              pending.status = "corrected";
              pending.nutrition = nutrition;
              pending.step = "awaiting_meal_type";

              await replyWithMealSlotQuickReply(event.replyToken);
              return;

            } catch (error) {
              console.error('❌ 食品修正エラー:', error.message);
              await replyToUser(event.replyToken, safeLineText(`❌ 食品「${trimmedText}」の処理に失敗しました。別の料理名を入力してください。`));
              return;
            }
          }
        }

        // *** 不明食品の食品名入力フロー ***
        const manualFoodInput = userId ? pendingManualFoodInput.get(userId) : null;
        if (manualFoodInput && manualFoodInput.expireAt > Date.now()) {
          try {
            const foodRegistry = await getFoodRegistry();
            const manualFoodName = normalizeUserFoodName(trimmedText);

            console.log(`🔤 手動入力食品: ${manualFoodName}`);

            // 栄養値を推定
            const nutrition = await estimateNutrition(manualFoodName, foodRegistry);

            // 確認待ちデータを構築
            const manualFoodResult = {
              selectedCandidates: [{ foodName: manualFoodName, confidence: 0.5 }],
              alternativeCandidates: [],
              excludedLabels: [],
              portion: 1.0,
              portionLabel: '普通盛り',
              detectedLabels: manualFoodInput.detectedLabels || [],
              source: 'manual',
              nutrition,
              rawVisionLabels: manualFoodInput.rawVisionLabels || [],
              filteredLabels: manualFoodInput.filteredLabels || [],
              labelsKey: manualFoodInput.labelsKey || '',
              candidateFoods: [manualFoodName],
            };

            // 確認待ち状態に設定
            pendingMealConfirmations.set(userId, {
              step: 'food_confirmation_pending',
              visionResult: manualFoodResult,
              createdAt: Date.now(),
              expireAt: Date.now() + MEAL_CONFIRM_TTL_MS,
            });

            // 手動入力待ち状態を削除
            pendingManualFoodInput.delete(userId);

            // 確認メッセージを送信
            const confirmMsg = safeLineText(`食事を「${manualFoodName}」として記録します。\n推定カロリー: 約${Math.round(nutrition.calories || nutrition.calorie || 0)}kcal\n\nOKなら「確認」と返信してください`);
            await replyToUser(event.replyToken, confirmMsg);
            return;

          } catch (error) {
            console.error('❌ 手動入力フロー処理エラー:', error.message);
            await replyToUser(event.replyToken, safeLineText(`❌ 食品「${trimmedText}」の処理に失敗しました。別の料理名を入力してください。`));
            return;
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

              const jstDateTime = getJstDateTime();
              await replyToUser(event.replyToken,
                `✅ 食品「${foodReg.data.foodName}」を登録しました！
カロリー: ${foodReg.data.calorie}kcal
タンパク質: ${foodReg.data.protein}g
脂質: ${foodReg.data.fat}g
炭水化物: ${foodReg.data.carb}g
記録日時: ${jstDateTime}

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
            const jstDateTime = getJstDateTime();
            await replyToUser(event.replyToken, `✅ 体重 ${weight}kg を記録しました\n記録日時: ${jstDateTime}`);
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

          // Vision APIで食べ物を認識
          const visionResult = await estimateFoodFromImage(imageBuffer);

          // ステータスに応じた処理
          if (visionResult.status === 'needs_manual_input') {
            // 手動入力が必要な場合
            console.log('⚠️  料理を認識できません');
            await replyToUser(event.replyToken, visionResult.message);
            return;
          }

          if (visionResult.status === 'needs_confirmation') {
            // 確認待ちステータス：新フロー（learnedFoods → candidateRules → Gemini）で推定
            console.log('📋 新フロー: learnedFoods → candidateRules → Gemini中...');

            try {
              // Vision API のラベル（英語）を直接取得
              const englishLabels = visionResult.detectedLabels || [];

              console.log(`📊 英語ラベル: ${englishLabels.join(', ')}`);

              // 新フロー: learnedFoods → candidateRules → Gemini
              const result = await refineFoodWithLearning(englishLabels);
              const {
                foodName: finalFoodName,
                candidates,
                source,
                confidence,
                rawVisionLabels,
                filteredLabels,
                labelsKey,
              } = result;

              console.log(`🎯 最終決定: ${finalFoodName} (source: ${source}, confidence: ${confidence})`);

              // 不明の場合は栄養推定せずにユーザーに入力を促す
              if (finalFoodName === '不明' || candidates[0] === '不明') {
                console.log('⚠️  料理を特定できませんでした');

                const userId = event.source && event.source.userId;
                if (userId) {
                  // 食品名入力待ち状態を保存
                  pendingManualFoodInput.set(userId, {
                    detectedLabels: englishLabels,
                    rawVisionLabels,
                    filteredLabels,
                    labelsKey,
                    createdAt: Date.now(),
                    expireAt: Date.now() + MANUAL_FOOD_INPUT_TTL_MS,
                  });
                }

                const candidatesList = candidates.length > 1 && candidates[0] !== '不明'
                  ? `\n\n候補:\n${candidates.slice(0, 3).map((c, i) => `${i + 1}. ${c}`).join('\n')}`
                  : '';

                const message = safeLineText(`料理名を特定できませんでした。\n食品名を入力してください。\n\n例: パスタ、焼きそば、ラーメン${candidatesList}`);

                await replyToUser(event.replyToken, message);
                return;
              }

              // 栄養値を推定
              const foodRegistry = await getFoodRegistry();
              const nutrition = await estimateNutrition(finalFoodName, foodRegistry);

              // 確認待ちデータを保存
              const userId = event.source && event.source.userId;
              const modifiedResult = {
                selectedCandidates: [{ foodName: finalFoodName, confidence }],
                alternativeCandidates: candidates.slice(1, 5).map(c => ({ foodName: c })),
                excludedLabels: visionResult.excludedLabels || [],
                portion: 1.0,
                portionLabel: '普通盛り',
                detectedLabels: englishLabels,
                source,
                nutrition,
                rawVisionLabels,
                filteredLabels,
                labelsKey,
                candidateFoods: candidates,
              };

              if (userId) {
                pendingMealConfirmations.set(userId, {
                  step: 'food_confirmation_pending',
                  visionResult: modifiedResult,
                  createdAt: Date.now(),
                  expireAt: Date.now() + MEAL_CONFIRM_TTL_MS,
                });
              }

              // ユーザーに確認メッセージを返信（候補表示）
              const candidatesText = candidates.length > 1
                ? `\n\n候補:\n${candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
                : '';

              const confirmMessage = safeLineText(`食事を「${finalFoodName}」として推定しました。\n信頼度: ${Math.round(confidence * 100)}%\n\nこの内容で記録する場合は「確認」と送ってください。\n違う場合は、正しい料理名を送ってください。${candidatesText}`);

              await replyToUser(event.replyToken, confirmMessage);
              return;
            } catch (error) {
              console.error('❌ 食品推定エラー:', error.message);
              await replyToUser(event.replyToken, '料理の推定に失敗しました。正確な料理名を直接入力してください。');
              return;
            }
          }

          // 想定外のステータス
          console.error('未知のステータス:', visionResult.status);
          await replyToUser(event.replyToken, '❌ 予期しないエラーが発生しました');

        } catch (error) {
          console.error('画像処理エラー:', error.message);
          await replyToUser(event.replyToken, `❌ 画像処理に失敗しました: ${error.message}`);
        }
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
