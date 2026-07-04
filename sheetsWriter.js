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

module.exports = { addMealLog, addBodyWeightLog, generateLogId, updateMealSlot, getFoodRegistry, addFoodRegistry };
