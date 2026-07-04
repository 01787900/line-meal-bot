const fs = require('fs');
const path = require('path');
const foodTranslation = require('./foodTranslation.json');
const ignoreLabels = require('./ignoreLabels.json');

/**
 * ユーザー入力の食品名を正規化
 * @param {string} text - ユーザーが入力した食品名
 * @returns {string} 正規化された食品名
 */
function normalizeUserFoodName(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  let normalized = text.trim();

  // 末尾のパターンを削除
  normalized = normalized
    .replace(/です\s*$/, '')
    .replace(/だよ\s*$/, '')
    .replace(/だ\s*$/, '')
    .replace(/でお願いします\s*$/, '')
    .replace(/お願いします\s*$/, '')
    .replace(/[。！]$/, '');

  normalized = normalized.trim();

  // 空文字になった場合は元のテキストを返す
  if (normalized.length === 0) {
    return text.trim();
  }

  return normalized;
}

/**
 * JSONファイルを安全に読み込む
 * @param {string} filePath - ファイルパス
 * @param {*} defaultValue - デフォルト値
 * @returns {*} JSONデータまたはデフォルト値
 */
function loadJsonFile(filePath, defaultValue = {}) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.warn(`⚠️  JSONファイル読み込みエラー: ${filePath}`);
    return defaultValue;
  }
}

/**
 * JSONファイルを安全に保存
 * @param {string} filePath - ファイルパス
 * @param {*} data - 保存するデータ
 * @returns {boolean} 成功したか
 */
function saveJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error(`❌ JSONファイル保存エラー: ${filePath}`, error.message);
    return false;
  }
}

/**
 * ラベル配列から無視リストに含まれるラベルを除外
 * @param {Array} labels - Vision APIのラベル配列
 * @returns {Array} フィルター後のラベル配列
 */
function filterIgnoredLabels(labels) {
  const allIgnoredLabels = new Set();

  // ignoreLabels.jsonの全カテゴリを集める
  for (const category in ignoreLabels) {
    ignoreLabels[category].forEach(label => {
      allIgnoredLabels.add(label.toLowerCase());
    });
  }

  // ラベルをフィルター（完全一致のみ）
  return labels.filter(label => {
    const normalized = label.toLowerCase().trim();
    return !allIgnoredLabels.has(normalized);
  });
}

/**
 * ラベル配列を正規化してキーを生成
 * 規則:
 * - 小文字化
 * - 空白トリミング
 * - ignoreLabels に含まれるものを除外
 * - アルファベット順にソート
 * - 重複を削除
 * - カンマ区切りにする
 * @param {Array} labels - Vision APIのラベル配列
 * @returns {string} 正規化されたキー
 */
function createLabelsKey(labels) {
  const filtered = filterIgnoredLabels(labels);

  const normalized = filtered
    .map(label => label.toLowerCase().trim())
    .filter(label => label.length > 0);

  // 重複を削除
  const unique = [...new Set(normalized)];

  // アルファベット順にソート
  unique.sort();

  // カンマ区切りで返す
  return unique.join(',');
}

/**
 * candidateRules.json から候補を生成
 * @param {Array} labels - Vision APIのラベル配列
 * @returns {Array} 候補リスト（重複削除済み）
 */
function generateCandidatesFromLabels(labels) {
  const candidateRulesPath = path.join(__dirname, 'candidateRules.json');
  const candidateRules = loadJsonFile(candidateRulesPath, []);

  const filtered = filterIgnoredLabels(labels);
  const normalizedLabels = new Set(
    filtered.map(label => label.toLowerCase().trim())
  );

  const matches = [];

  // candidateRules からマッチするルールを探す
  for (const rule of candidateRules) {
    const ruleLabels = rule.labels.map(l => l.toLowerCase());

    // すべてのルールラベルが含まれているか確認
    const allMatch = ruleLabels.every(ruleLabel =>
      Array.from(normalizedLabels).some(label =>
        label.includes(ruleLabel) || ruleLabel.includes(label)
      )
    );

    if (allMatch) {
      matches.push({
        candidates: rule.candidates,
        priority: rule.priority || 50,
      });
    }
  }

  // priority が高い順にソート
  matches.sort((a, b) => b.priority - a.priority);

  // 候補を集める（重複削除）
  const allCandidates = [];
  const candidateSet = new Set();

  for (const match of matches) {
    for (const candidate of match.candidates) {
      if (!candidateSet.has(candidate)) {
        candidateSet.add(candidate);
        allCandidates.push(candidate);
      }
    }
  }

  // 候補が0件の場合は、foodTranslation.json から生成
  if (allCandidates.length === 0) {
    for (const label of filtered) {
      const translated = foodTranslation[label.toLowerCase()];
      if (translated) {
        const foodName = translated.key;
        if (!candidateSet.has(foodName)) {
          candidateSet.add(foodName);
          allCandidates.push(foodName);
        }
      }
    }
  }

  // それでも候補がない場合は不明
  if (allCandidates.length === 0) {
    return ['不明'];
  }

  return allCandidates;
}

/**
 * learnedFoods.json から学習済み食品を検索
 * @param {Array} labels - Vision APIのラベル配列
 * @returns {Object|null} {correct_food, confidence} または null
 */
function findLearnedFood(labels) {
  const learnedFoodsPath = path.join(__dirname, 'learnedFoods.json');
  const learnedFoods = loadJsonFile(learnedFoodsPath, {});

  const key = createLabelsKey(labels);

  if (learnedFoods[key]) {
    return {
      correct_food: learnedFoods[key].correct_food,
      confidence: 0.9,
      source: 'learned',
    };
  }

  return null;
}

/**
 * ユーザー修正を学習して learnedFoods.json に保存
 * @param {Array} labels - Vision APIのラベル配列
 * @param {string} estimatedFood - AI推定食品名
 * @param {string} confirmedFood - ユーザー確認・修正食品名
 */
function updateLearnedFood(labels, estimatedFood, confirmedFood) {
  const learnedFoodsPath = path.join(__dirname, 'learnedFoods.json');
  const learnedFoods = loadJsonFile(learnedFoodsPath, {});

  const key = createLabelsKey(labels);
  const now = new Date().toISOString();

  if (!learnedFoods[key]) {
    learnedFoods[key] = {
      correct_food: confirmedFood,
      count: 1,
      last_used: now,
      examples: [],
    };
  } else {
    learnedFoods[key].count += 1;
    learnedFoods[key].correct_food = confirmedFood;
    learnedFoods[key].last_used = now;
  }

  // examples に追加（最大20件）
  learnedFoods[key].examples.push({
    estimated_food: estimatedFood,
    confirmed_food: confirmedFood,
    timestamp: now,
  });

  if (learnedFoods[key].examples.length > 20) {
    learnedFoods[key].examples = learnedFoods[key].examples.slice(-20);
  }

  // 保存
  if (saveJsonFile(learnedFoodsPath, learnedFoods)) {
    console.log(`✅ learnedFoods を更新しました: ${key} → ${confirmedFood}`);
  }
}

module.exports = {
  normalizeUserFoodName,
  loadJsonFile,
  saveJsonFile,
  filterIgnoredLabels,
  createLabelsKey,
  generateCandidatesFromLabels,
  findLearnedFood,
  updateLearnedFood,
};
