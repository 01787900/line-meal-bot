const vision = require('@google-cloud/vision');

// Google Cloud 認証情報をセットアップ
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const client = new vision.ImageAnnotatorClient({ credentials });

/**
 * LINEから受け取った画像から食べ物を認識
 * @param {Buffer} imageBuffer - 画像のバイナリデータ
 * @returns {Object} 認識結果（食べ物、信頼度など）
 */
async function estimateFoodFromImage(imageBuffer) {
  console.log('🔍 Google Vision APIで画像を分析中...');

  try {
    const request = {
      image: {
        content: imageBuffer.toString('base64'),
      },
      features: [
        { type: 'LABEL_DETECTION', maxResults: 10 },
        { type: 'TEXT_DETECTION' },
      ],
    };

    const response = await client.annotateImage(request);
    const labels = response[0].labelAnnotations || [];

    console.log('📊 検出されたラベル:', labels.map(l => `${l.description}(${(l.score * 100).toFixed(0)}%)`).join(', '));

    // 食べ物関連のラベルをフィルタリング
    const foodKeywords = [
      'food', 'meal', 'dish', 'rice', 'bread', 'meat', 'vegetable', 'fruit', 'noodle',
      '食べ物', '料理', 'ご飯', '肉', '野菜', '麺', 'パン', 'スープ', '揚げ'
    ];

    const foodLabels = labels.filter(label =>
      foodKeywords.some(keyword =>
        label.description.toLowerCase().includes(keyword.toLowerCase())
      )
    );

    // 信頼度を判定
    let confidence = 'low';
    if (foodLabels.length > 0) {
      const avgScore = foodLabels.reduce((sum, l) => sum + l.score, 0) / foodLabels.length;
      if (avgScore > 0.7) {
        confidence = 'high';
      } else if (avgScore > 0.4) {
        confidence = 'medium';
      }
    }

    const estimatedFoods = foodLabels
      .slice(0, 5) // 上位5つまで
      .map(l => l.description)
      .join(', ');

    console.log(`✅ 認識完了: ${estimatedFoods || '食べ物が認識できませんでした'}`);

    return {
      estimated_foods: estimatedFoods || 'その他',
      confidence: confidence,
      labels: foodLabels.map(l => ({ description: l.description, score: l.score })),
    };

  } catch (error) {
    console.error('❌ Vision API エラー:', error.message);
    throw new Error(`画像認識に失敗しました: ${error.message}`);
  }
}

module.exports = { estimateFoodFromImage };
