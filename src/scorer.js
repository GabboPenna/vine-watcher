"use strict";

const { normalizeTextForMatch } = require("./utils");

function hasKeyword(haystack, keyword) {
  const normalizedKeyword = normalizeTextForMatch(keyword);
  if (!normalizedKeyword) {
    return false;
  }
  return ` ${haystack} `.includes(` ${normalizedKeyword} `);
}

function addKeywordMatches({ haystack, keywords, points, label, reasons }) {
  let score = 0;
  let matches = 0;
  for (const keyword of keywords) {
    if (hasKeyword(haystack, keyword)) {
      score += points;
      matches += 1;
      reasons.push(`${label}: ${keyword}`);
    }
  }
  return {
    score,
    matches
  };
}

function containsAny(haystack, keywords) {
  return keywords.some((keyword) => hasKeyword(haystack, keyword));
}

function scoreProduct(product, keywordConfig) {
  const reasons = [];
  const text = normalizeTextForMatch([product.title, product.raw_text, product.section].filter(Boolean).join(" "));
  let score = 0;
  let positiveSignals = 0;
  let negativeSignals = 0;

  const highMatches = addKeywordMatches({
    haystack: text,
    keywords: keywordConfig.positiveKeywordsHigh,
    points: 10,
    label: "keyword high",
    reasons
  });
  score += highMatches.score;
  positiveSignals += highMatches.matches;

  const normalMatches = addKeywordMatches({
    haystack: text,
    keywords: keywordConfig.positiveKeywordsNormal,
    points: 5,
    label: "keyword normal",
    reasons
  });
  score += normalMatches.score;
  positiveSignals += normalMatches.matches;

  const negativeMatches = addKeywordMatches({
    haystack: text,
    keywords: keywordConfig.negativeKeywords,
    points: -10,
    label: "negative keyword",
    reasons
  });
  score += negativeMatches.score;
  negativeSignals += negativeMatches.matches;

  const brandMatches = addKeywordMatches({
    haystack: text,
    keywords: keywordConfig.knownBrandsBonus,
    points: 8,
    label: "brand",
    reasons
  });
  score += brandMatches.score;
  positiveSignals += brandMatches.matches;

  if (containsAny(text, keywordConfig.smartHomeKeywords)) {
    score += 5;
    positiveSignals += 1;
    reasons.push("bonus: smart home");
  }

  if (containsAny(text, keywordConfig.electronicsOrToolKeywords)) {
    score += 5;
    positiveSignals += 1;
    reasons.push("bonus: electronics or tool");
  }

  if (containsAny(text, keywordConfig.homeApplianceKeywords || [])) {
    score += 5;
    positiveSignals += 1;
    reasons.push("bonus: home appliance or household");
  }

  if (containsAny(text, keywordConfig.genericAccessoryKeywords)) {
    score -= 5;
    negativeSignals += 1;
    reasons.push("malus: generic accessory");
  }

  if (containsAny(text, keywordConfig.nicheReplacementKeywords)) {
    score -= 10;
    negativeSignals += 1;
    reasons.push("malus: replacement or niche item");
  }

  return {
    score,
    reasons,
    positiveSignals,
    negativeSignals
  };
}

module.exports = {
  scoreProduct
};
