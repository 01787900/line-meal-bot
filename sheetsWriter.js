const { google } = require('googleapis');

// Google Sheets APIクライアントをセットアップ
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

/**
 * ユニークなログIDを生成（タイムスタンプベース）
 * 形式: LOG_YYYYMMDD_HHmmssSSS
 */
function generateLogId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');

  return `LOG_${year}${month}${day}_${hours}${minutes}${seconds}${ms}`;
}

/**
 * 新フォーマットで食事ログを Google Sheets の meal_logs に追加
 *
 * カラム構成（全25列）：
 * A: log_id, B: date_jst, C: time_jst, D: timestamp,
 * E: user_id, F: detected_labels, G: estimated_food, H: confirmed_food,
 * I: confidence, J: portion, K: calories, L: protein, M: fat, N: carbs,
 * O: source, P: status, Q: meal_type,
 * R: portion_label, S: portion_multiplier, T: raw_vision_labels,
 * U: filtered_labels, V: labels_key, W: candidate_foods, X: eaten_at
 *
 * @param {Object} params - 食事ログパラメータ
 * @param {string} params.userId - LINEユーザーID
 * @param {Array} params.detectedLabels - Vision APIのラベル配列
 * @param {string} params.estimatedFood - AI推定食品名
 * @param {string} params.confirmedFood - ユーザー確認・修正食品名
 * @param {number} params.confidence - 推定信頼度（0-1）
 * @param {number} params.portion - 分量倍率（デフォルト: 1.0）
 * @param {Object} params.nutrition - 栄養情報 {calorie, protein, fat, carb}
 * @param {string} params.source - 入力源（image, text, manual, learned, corrected）
 * @param {string} params.status - ステータス（pending, confirmed, corrected）
 * @param {string} params.mealType - 食事の時間帯（breakfast, lunch, dinner, snack, late_night）
 * @param {string} params.portionLabel - 分量表示名（少なめ, 普通, 多め, 大盛り）
 * @param {number} params.portionMultiplier - 栄養補正倍率
 * @param {Array} params.rawVisionLabels - Vision API元ラベル配列
 * @param {Array} params.filteredLabels - フィルター後のラベル配列
 * @param {string} params.labelsKey - learnedFoods用正規化キー
 * @param {Array} params.candidateFoods - 候補食品配列
 * @param {string} params.eatenAt - 食事時刻（ISO 8601形式）
 */
async function appendMealLog(params) {
  const now = new Date();
  const logId = generateLogId();

  // ISO形式のタイムスタンプ
  const timestamp = now.toISOString();

  // JST（日本時間）の日付と時刻を計算
  const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9
  const year = jstDate.getUTCFullYear();
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jstDate.getUTCDate()).padStart(2, '0');
  const hours = String(jstDate.getUTCHours()).padStart(2, '0');
  const minutes = String(jstDate.getUTCMinutes()).padStart(2, '0');
  const seconds = String(jstDate.getUTCSeconds()).padStart(2, '0');

  const dateJst = `${year}-${month}-${day}`;
  const timeJst = `${hours}:${minutes}:${seconds}`;

  const detectedLabelsStr = Array.isArray(params.detectedLabels)
    ? params.detectedLabels.join(',')
    : params.detectedLabels || '';

  const rawVisionLabelsStr = Array.isArray(params.rawVisionLabels)
    ? params.rawVisionLabels.join(',')
    : params.rawVisionLabels || '';

  const filteredLabelsStr = Array.isArray(params.filteredLabels)
    ? params.filteredLabels.join(',')
    : params.filteredLabels || '';

  const candidateFoodsStr = Array.isArray(params.candidateFoods)
    ? params.candidateFoods.join(',')
    : params.candidateFoods || '';

  const values = [
    [
      logId,                                              // A: log_id
      dateJst,                                            // B: date_jst
      timeJst,                                            // C: time_jst
      timestamp,                                          // D: timestamp
      params.userId || '',                                // E: user_id
      detectedLabelsStr,                                  // F: detected_labels
      params.estimatedFood || '',                         // G: estimated_food
      params.confirmedFood || params.estimatedFood || '', // H: confirmed_food
      Math.round(params.confidence * 100) / 100 || 0,    // I: confidence
      params.portion || params.portionMultiplier || 1.0,  // J: portion
      Math.round(params.nutrition?.calorie || 0),        // K: calories
      Math.round((params.nutrition?.protein || 0) * 10) / 10, // L: protein
      Math.round((params.nutrition?.fat || 0) * 10) / 10,     // M: fat
      Math.round((params.nutrition?.carb || 0) * 10) / 10,    // N: carbs
      params.source || 'manual',                          // O: source
      params.status || 'pending',                         // P: status
      params.mealType || '',                              // Q: meal_type
      params.portionLabel || '',                          // R: portion_label
      params.portionMultiplier || 1.0,                    // S: portion_multiplier
      rawVisionLabelsStr,                                 // T: raw_vision_labels
      filteredLabelsStr,                                  // U: filtered_labels
      params.labelsKey || '',                             // V: labels_key
      candidateFoodsStr,                                  // W: candidate_foods
      params.eatenAt || timestamp,                        // X: eaten_at
    ],
  ];

  try {
    console.log('📝 新フォーマットで食事ログを記録中...');

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'meal_logs!A:X',
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    console.log(`✅ 食事ログを追加しました (log_id: ${logId}, 日時: ${dateJst} ${timeJst})`);
    return { logId, ...response.data };

  } catch (error) {
    console.error('❌ 新フォーマットシート書き込みエラー:', error.message);
    throw new Error(`食事ログ記録失敗: ${error.message}`);
  }
}

/**
 * 食事ログを Google Sheets の meal_logs シートに追加
 *
 * カラム構成：
 * A: log_id, B: date, C: timestamp, D: meal_type, E: food_name,
 * F: calories, G: protein, H: fat, I: carbs, J: portion, K: confidence, L: source, M: memo
 *
 * @param {Object} mealData - 食事データ
 * @param {Object} options - オプション（meal_slot, source など）
 */
async function addMealLog(mealData, options = {}) {
  const now = new Date();
  const logId = generateLogId();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD形式
  const timestamp = now.toISOString(); // ISO 8601形式
  const mealType = options.meal_slot || mealData.meal_slot || 'lunch';
  const source = options.source || 'LINE_IMAGE';
  const portion = mealData.labels?.[0]?.portion || 1.0;

  const values = [
    [
      logId,
      date,
      timestamp,
      mealType,
      mealData.estimated_foods || 'その他',
      Math.round(mealData.estimated_calorie || 0),
      Math.round((mealData.protein_g || 0) * 10) / 10,
      Math.round((mealData.fat_g || 0) * 10) / 10,
      Math.round((mealData.carb_g || 0) * 10) / 10,
      portion,
      mealData.confidence || 'low',
      source,
      mealData.memo || '',
    ],
  ];

  try {
    console.log('📝 Google Sheetsに食事データを書き込み中...');

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'meal_logs!A:M',
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    console.log(`✅ 食事ログを追加しました (log_id: ${logId})`);
    return { logId, ...response.data };

  } catch (error) {
    console.error('❌ Sheets書き込みエラー:', error.message);
    throw new Error(`スプレッドシート書き込み失敗: ${error.message}`);
  }
}

/**
 * 体重ログを Google Sheets の body_weight_logs シートに追加
 *
 * カラム構成：
 * A: log_id, B: date, C: timestamp, D: weight_kg, E: memo
 *
 * @param {number} weight_kg - 体重（kg）
 * @param {string} memo - メモ（オプション）
 */
async function addBodyWeightLog(weight_kg, memo = '') {
  const now = new Date();
  const logId = generateLogId();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD形式
  const timestamp = now.toISOString(); // ISO 8601形式

  const values = [
    [
      logId,
      date,
      timestamp,
      parseFloat(weight_kg),
      memo,
    ],
  ];

  try {
    console.log('⚖️  Google Sheetsに体重データを書き込み中...');

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'body_weight_logs!A:E',
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    console.log(`✅ 体重ログを追加しました (log_id: ${logId})`);
    return { logId, ...response.data };

  } catch (error) {
    console.error('❌ Sheets書き込みエラー:', error.message);
    throw new Error(`体重ログ書き込み失敗: ${error.message}`);
  }
}

/**
 * 食事ログの時間帯（meal_slot）を後から更新する
 * @param {number} rowNumber - meal_logsシートの行番号
 * @param {string} mealSlot - 新しい時間帯（例: '朝食', '昼食', '夕食', '間食'）
 */
async function updateMealSlot(rowNumber, mealSlot) {
  try {
    console.log('🔄 食事の時間帯を更新中...', rowNumber, mealSlot);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `meal_logs!D${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[mealSlot]] },
    });

    console.log('✅ 時間帯を更新しました:', mealSlot);
  } catch (error) {
    console.error('❌ 時間帯更新エラー:', error.message);
    throw new Error(`時間帯更新失敗: ${error.message}`);
  }
}

/**
 * Google Sheets の food_registry シートから登録済み食品を取得
 * @returns {Object} 食品マスタ {foodName: {calorie, protein, fat, carb}}
 */
async function getFoodRegistry() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'food_registry!A:F',
    });

    const rows = response.data.values || [];
    const registry = {};

    // ヘッダーをスキップして、2行目以降を処理
    for (let i = 1; i < rows.length; i++) {
      const [foodName, calorie, protein, fat, carb] = rows[i];
      if (foodName) {
        registry[foodName.toLowerCase()] = {
          foodName,
          calorie: parseFloat(calorie) || 0,
          protein: parseFloat(protein) || 0,
          fat: parseFloat(fat) || 0,
          carb: parseFloat(carb) || 0,
        };
      }
    }

    console.log(`✅ 食品レジストリを読み込みました (${Object.keys(registry).length}件)`);
    return registry;

  } catch (error) {
    console.error('❌ 食品レジストリ読み込みエラー:', error.message);
    return {};
  }
}

/**
 * 新しい食品を food_registry シートに追加
 * @param {Object} foodData - 食品データ {foodName, calorie, protein, fat, carb}
 */
async function addFoodRegistry(foodData) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];

  const values = [
    [
      foodData.foodName,
      foodData.calorie || 0,
      foodData.protein || 0,
      foodData.fat || 0,
      foodData.carb || 0,
      date,
    ],
  ];

  try {
    console.log(`📝 食品 "${foodData.foodName}" をレジストリに登録中...`);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'food_registry!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    console.log(`✅ 食品 "${foodData.foodName}" を登録しました`);
    return true;

  } catch (error) {
    console.error('❌ 食品レジストリ登録エラー:', error.message);
    throw new Error(`食品登録失敗: ${error.message}`);
  }
}

/**
 * 指定ユーザーの今日のmeal_logsを取得
 * @param {string} userId - LINEユーザーID
 * @returns {Promise<Array>} 本日の食事ログ配列
 */
async function getTodayMealLogs(userId) {
  try {
    // TODO: Google Sheets の meal_logs から、
    // user_id が一致し、
    // eaten_at が今日のJST日付に該当する行を取得する
    //
    // 実装手順：
    // 1. meal_logs シート全体を取得（全行全列）
    // 2. header行をスキップ（最初の行）
    // 3. user_id カラム (E列) と一致する行をフィルタ
    // 4. eaten_at カラム (X列) の日付部分を抽出してJST今日と比較
    // 5. status が 'confirmed' または 'corrected' の行のみ抽出
    // 6. 配列で返す

    console.log(`TODO: getTodayMealLogs(${userId}) - Not yet implemented`);
    return [];
  } catch (error) {
    console.error('❌ getTodayMealLogs error:', error.message);
    return [];
  }
}

/**
 * 食事ログを集計（合計とmeal_type別小計）
 * @param {Array} logs - 食事ログ配列
 * @returns {Object} 集計結果 {total: {...}, byMealType: {...}}
 */
function summarizeMealLogs(logs) {
  // TODO: logs から以下を計算：
  // 1. 合計 calories, protein, fat, carbs
  // 2. meal_type (breakfast, lunch, dinner, snack) ごとの小計
  // 3. 各食事の詳細情報（food name, meal_type, portion_label, calories）
  //
  // 戻り値構造例：
  // {
  //   total: {
  //     calories: 1520,
  //     protein: 65.0,
  //     fat: 48.0,
  //     carbs: 205.0
  //   },
  //   byMealType: {
  //     breakfast: { calories: 420, protein: 18, fat: 12, carbs: 45 },
  //     lunch: { calories: 650, protein: 28, fat: 20, carbs: 90 },
  //     dinner: { calories: 0, protein: 0, fat: 0, carbs: 0 },
  //     snack: { calories: 450, protein: 19, fat: 16, carbs: 70 }
  //   },
  //   meals: [
  //     { food: "パスタ", mealType: "snack", label: "普通", calories: 650 },
  //     { food: "プロテイン", mealType: "snack", label: "普通", calories: 120 }
  //   ]
  // }

  console.log(`TODO: summarizeMealLogs() - Not yet implemented`);
  return { total: {}, byMealType: {}, meals: [] };
}

/**
 * 集計結果をLINE返信用テキストにフォーマット
 * @param {Object} summary - summarizeMealLogs() の戻り値
 * @param {string} userId - ユーザーID（オプション、ログ用）
 * @returns {string} LINE送信用テキスト
 */
function formatTodaySummary(summary, userId = '') {
  // TODO: summary をLINE送信用に整形：
  //
  // 出力例：
  // 今日の食事まとめです。
  // 合計: 1,520kcal P: 65.0g / F: 48.0g / C: 205.0g
  //
  // 内訳:
  // 朝食: 420kcal
  // 昼食: 650kcal
  // 夕食: 0kcal
  // 間食: 450kcal
  //
  // 記録:
  // ・パスタ / 間食 / 普通 / 650kcal
  // ・プロテイン / 間食 / 普通 / 120kcal

  console.log(`TODO: formatTodaySummary() - Not yet implemented`);
  return "今日の食事まとめ機能は準備中です。";
}

module.exports = {
  addMealLog,
  appendMealLog,
  addBodyWeightLog,
  generateLogId,
  updateMealSlot,
  getFoodRegistry,
  addFoodRegistry,
  getTodayMealLogs,
  summarizeMealLogs,
  formatTodaySummary
};
