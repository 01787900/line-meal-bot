const vision = require('@google-cloud/vision');
const foodTranslation = require('./foodTranslation.json');
const ignoreLabels = require('./ignoreLabels.json');
const portionMultipliers = require('./portionMultipliers.json');

// Google Cloud 認証情報をセットアップ
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const client = new vision.ImageAnnotatorClient({ credentials });

/**
 * ラベルを正規化（小文字化、スペース削除）
 */
function normalizeLabel(label) {
  return label.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * ラベルが ignore list に含まれているか判定
 */
function shouldIgnoreLabel(label) {
  const normalized = normalizeLabel(label);
  for (const category in ignoreLabels) {
    if (ignoreLabels[category].some(ignore =>
      normalized.includes(ignore.toLowerCase()) || ignore.toLowerCase().includes(normalized)
    )) {
      return true;
    }
  }
  return false;
}

/**
 * Vision API ラベルを foodTranslation で変換
 */
function translateLabelToFood(label) {
  const normalized = normalizeLabel(label);

  for (const foodKey in foodTranslation) {
    const foodRule = foodTranslation[foodKey];
    const ruleName = normalizeLabel(foodRule.key);

    // includes パターンで マッチング
    for (const include of foodRule.includes) {
      const includeNorm = normalizeLabel(include);
      if (normalized === includeNorm ||
          normalized.includes(includeNorm) ||
          includeNorm.includes(normalized)) {
        return { foodKey, foodRule };
      }
    }
  }

  return null;
}

/**
 * ラベルから量の multiplier を推定
 */
function estimatePortionMultiplier(label) {
  const normalized = normalizeLabel(label);

  for (const sizeKey in portionMultipliers.size_keywords) {
    const sizeData = portionMultipliers.size_keywords[sizeKey];
    for (const pattern of sizeData.patterns) {
      if (normalized.includes(normalizeLabel(pattern))) {
        return sizeData.multiplier;
      }
    }
  }

  return portionMultipliers.default_multiplier;
}

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
        { type: 'LABEL_DETECTION', maxResults: 20 },
      ],
    };

    const response = await client.annotateImage(request);
    const rawLabels = response[0].labelAnnotations || [];

    console.log('📊 検出されたラベル:',
      rawLabels.map(l => `${l.description}(${(l.score * 100).toFixed(0)}%)`).join(', '));

    // Step 1: score < 0.5 を除外
    const filteredByScore = rawLabels.filter(l => l.score >= 0.5);
    console.log(`ℹ️  信頼度 >= 50%: ${filteredByScore.length}件`);

    // Step 2: ignore list を適用
    const notIgnored = filteredByScore.filter(l => !shouldIgnoreLabel(l.description));
    console.log(`ℹ️  除外後: ${notIgnored.length}件`);

    // Step 3: foodTranslation で変換
    const translatedFoods = [];
    const addedFoods = new Set();

    for (const label of notIgnored) {
      const translated = translateLabelToFood(label.description);

      if (translated) {
        const { foodKey, foodRule } = translated;

        // 重複排除（includes による重複は1つだけ保持）
        if (!addedFoods.has(foodKey)) {
          addedFoods.add(foodKey);
          translatedFoods.push({
            originalLabel: label.description,
            foodKey: foodKey,
            foodName: foodRule.key,
            type: foodRule.type,
            category: foodRule.category,
            priority: foodRule.priority,
            score: label.score,
            portion: estimatePortionMultiplier(label.description),
          });
        }
      }
    }

    console.log(`ℹ️  変換済み: ${translatedFoods.length}件`);

    // Step 4: priority の高い順にソート
    translatedFoods.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return b.score - a.score;
    });

    console.log('📋 ソート済み結果:',
      translatedFoods.map(f => `${f.foodName}(${f.priority}, ${(f.score * 100).toFixed(0)}%)`).join(', '));

    // Step 5: 有効候補が0件の場合は「その他」
    let estimatedFoods = 'その他';
    let confidence = 'low';
    let selectedFoods = [];

    if (translatedFoods.length > 0) {
      selectedFoods = translatedFoods.slice(0, 5).map(f => f.foodName);
      estimatedFoods = selectedFoods.join(', ');

      // 信頼度を判定（変換後のスコアで判定）
      const avgScore = translatedFoods.slice(0, 3).reduce((sum, f) => sum + f.score, 0) /
                       Math.min(3, translatedFoods.length);
      if (avgScore > 0.7) {
        confidence = 'high';
      } else if (avgScore > 0.4) {
        confidence = 'medium';
      } else {
        confidence = 'low';
      }
    }

    console.log(`✅ 認識完了: ${estimatedFoods} (信頼度: ${confidence})`);

    return {
      estimated_foods: estimatedFoods,
      confidence: confidence,
      labels: translatedFoods.slice(0, 5).map(f => ({
        description: f.foodName,
        score: f.score,
        portion: f.portion,
        type: f.type,
      })),
    };

  } catch (error) {
    console.error('❌ Vision API エラー:', error.message);
    throw new Error(`画像認識に失敗しました: ${error.message}`);
  }
}

module.exports = { estimateFoodFromImage };
