const vision = require('@google-cloud/vision');
const foodTranslation = require('./foodTranslation.json');
const ignoreLabels = require('./ignoreLabels.json');
const portionMultipliers = require('./portionMultipliers.json');

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const client = new vision.ImageAnnotatorClient({ credentials });

/**
 * ラベルを正規化（小文字化、スペース削除）
 */
function normalizeLabel(label) {
  return label.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * ラベルがignore listに含まれているか判定
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
 * Vision APIラベルをfoodTranslationで変換
 */
function translateLabelToFood(label) {
  const normalized = normalizeLabel(label);

  for (const foodKey in foodTranslation) {
    const foodRule = foodTranslation[foodKey];
    const includes = foodRule.includes || [];

    for (const include of includes) {
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
 * 候補スコア計算: visionScore × priority
 */
function calculateCandidateScore(visionScore, priority) {
  return visionScore * (priority / 100);
}

/**
 * ラベルから量のmultiplierを推定
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
 * LINEから受け取った画像から食べ物を認識し、確認待ちステータスで返す
 * @param {Buffer} imageBuffer - 画像のバイナリデータ
 * @returns {Object} 認識結果（確認待ちステータス）
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

    // Step 2: ignore listを適用
    const notIgnored = filteredByScore.filter(l => !shouldIgnoreLabel(l.description));
    console.log(`ℹ️  非抽象ラベル: ${notIgnored.length}件`);

    // Step 3: foodTranslationで変換して候補を作成
    const candidates = [];
    const processedLabels = new Set();

    for (const label of notIgnored) {
      const translated = translateLabelToFood(label.description);

      if (translated) {
        const { foodKey, foodRule } = translated;

        // 同じfoodKeyは1回だけ処理
        if (!processedLabels.has(foodKey)) {
          processedLabels.add(foodKey);

          const candidateScore = calculateCandidateScore(label.score, foodRule.priority);
          candidates.push({
            foodKey,
            foodName: foodRule.key,
            type: foodRule.type,
            category: foodRule.category,
            priority: foodRule.priority,
            visionScore: label.score,
            candidateScore,
            includes: foodRule.includes || [],
            originalLabel: label.description,
          });
        }
      }
    }

    console.log(`ℹ️  変換済み候補: ${candidates.length}件`);

    // Step 4: candidateScore でソート
    candidates.sort((a, b) => b.candidateScore - a.candidateScore);

    // Step 5: dish優先ロジック
    const dishCandidates = candidates.filter(c => c.type === 'dish');
    let selectedDish = null;

    if (dishCandidates.length > 0) {
      // 最も高いスコアのdishを採用
      selectedDish = dishCandidates[0];
      console.log(`📋 Vision推定（参考・最終判定には未使用）: ${selectedDish.foodName} (${selectedDish.candidateScore.toFixed(3)})`);
    }

    // Step 6: 候補を選別
    let selectedCandidates = [];
    let alternativeCandidates = [];
    let excludedLabels = [];

    if (selectedDish) {
      // dishがある場合：dishのincludesに含まれる食材は除外
      selectedCandidates.push(selectedDish);

      for (const cand of candidates) {
        if (cand.type === 'dish') {
          // 他のdishは候補にしない
          if (cand.foodKey !== selectedDish.foodKey) {
            alternativeCandidates.push(cand);
          }
        } else {
          // 食材の場合：dishのincludesに含まれるかチェック
          const isIncluded = selectedDish.includes.some(inc => {
            const incNorm = normalizeLabel(inc);
            return normalizeLabel(cand.foodName).includes(incNorm) ||
                   normalizeLabel(cand.originalLabel).includes(incNorm) ||
                   incNorm === normalizeLabel(cand.foodName) ||
                   incNorm === normalizeLabel(cand.originalLabel);
          });

          if (isIncluded) {
            excludedLabels.push(cand.originalLabel);
          } else {
            // dishに含まれない食材（副菜など）は追加候補
            if (cand.category === 'soup' || cand.category === 'side') {
              alternativeCandidates.push(cand);
            } else {
              excludedLabels.push(cand.originalLabel);
            }
          }
        }
      }
    } else {
      // dishがない場合：カテゴリ別代表選択
      const categoryGroups = {};

      for (const cand of candidates) {
        const cat = cand.category;
        if (!categoryGroups[cat]) {
          categoryGroups[cat] = [];
        }
        categoryGroups[cat].push(cand);
      }

      // カテゴリごとに最高スコアを選択
      for (const category in categoryGroups) {
        const group = categoryGroups[category];
        group.sort((a, b) => b.candidateScore - a.candidateScore);

        if (group.length > 0) {
          selectedCandidates.push(group[0]);
          // 同カテゴリの他の候補は除外
          for (let i = 1; i < group.length; i++) {
            excludedLabels.push(group[i].originalLabel);
          }
        }
      }

      // 候補がない場合
      if (selectedCandidates.length === 0) {
        const hasAbstractLabels = notIgnored.length === 0 && filteredByScore.length > 0;

        if (hasAbstractLabels) {
          console.log('⚠️  抽象ラベルのみ検出');
          return {
            status: 'needs_manual_input',
            reason: 'abstract_labels_only',
            message: '食事らしい画像ですが、料理名を特定できませんでした。料理名を入力してください。',
            detectedLabels: rawLabels.map(l => l.description),
          };
        } else {
          console.log('⚠️  食品を認識できません');
          return {
            status: 'needs_manual_input',
            reason: 'no_food_detected',
            message: '料理を認識できませんでした。別の写真を送るか、料理名を入力してください。',
            detectedLabels: rawLabels.map(l => l.description),
          };
        }
      }

      alternativeCandidates = [];
    }

    console.log(`📋 Vision候補（参考・Geminiで再判定中）: ${selectedCandidates.map(c => c.foodName).join(', ')}`);

    // Step 7: 確認待ちステータスで返す
    return {
      status: 'needs_confirmation',
      selectedCandidates: selectedCandidates.map(c => ({
        foodKey: c.foodKey,
        foodName: c.foodName,
        type: c.type,
        category: c.category,
        score: c.visionScore,
        candidateScore: c.candidateScore,
      })),
      alternativeCandidates: alternativeCandidates.slice(0, 5).map(c => ({
        foodKey: c.foodKey,
        foodName: c.foodName,
        type: c.type,
        category: c.category,
        score: c.visionScore,
      })),
      excludedLabels,
      portion: 'normal',
      portionLabel: '普通盛り前提',
      message: `${selectedCandidates.map(c => c.foodName).join('と')}として推定しました。量は普通盛り前提です。内容を確認してください。`,
      detectedLabels: notIgnored.map(l => l.description),
    };

  } catch (error) {
    console.error('❌ Vision API エラー:', error.message);
    throw new Error(`画像認識に失敗しました: ${error.message}`);
  }
}

module.exports = { estimateFoodFromImage };
