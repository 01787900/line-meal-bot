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
 * 食事ログを Google Sheets の meal_logs シートに追加
 * @param {Object} mealData - 食事データ
 */
async function addMealLog(mealData) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD形式

  const values = [
    [
      today,
      mealData.meal_slot || 'lunch',
      mealData.estimated_foods || 'その他',
      Math.round(mealData.estimated_calorie || 0),
      Math.round((mealData.protein_g || 0) * 10) / 10,
      Math.round((mealData.fat_g || 0) * 10) / 10,
      Math.round((mealData.carb_g || 0) * 10) / 10,
      mealData.confidence || 'low',
      mealData.memo || '',
    ],
  ];

  try {
    console.log('📝 Google Sheetsに食事データを書き込み中...');

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'meal_logs!A:I',
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    console.log('✅ 食事ログを追加しました');
    return response.data;

  } catch (error) {
    console.error('❌ Sheets書き込みエラー:', error.message);
    throw new Error(`スプレッドシート書き込み失敗: ${error.message}`);
  }
}

/**
 * 体重ログを Google Sheets の body_weight_logs シートに追加
 * @param {number} weight_kg - 体重（kg）
 * @param {string} memo - メモ（オプション）
 */
async function addBodyWeightLog(weight_kg, memo = '') {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD形式

  const values = [
    [
      today,
      parseFloat(weight_kg),
      memo,
    ],
  ];

  try {
    console.log('⚖️  Google Sheetsに体重データを書き込み中...');

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'body_weight_logs!A:C',
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    console.log('✅ 体重ログを追加しました');
    return response.data;

  } catch (error) {
    console.error('❌ Sheets書き込みエラー:', error.message);
    throw new Error(`体重ログ書き込み失敗: ${error.message}`);
  }
}

module.exports = { addMealLog, addBodyWeightLog };
