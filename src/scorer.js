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
  for (const keyword of keywords) {
    if (hasKeyword(haystack, keyword)) {
      score += points;
      reasons.push(`${label}: ${keyword}`);
    }
  }
  return score;
}

function containsAny(haystack, keywords) {
  return keywords.some((keyword) => hasKeyword(haystack, keyword));
}

function scoreProduct(product, keywordConfig) {
  const reasons = [];
  const text = normalizeTextForMatch([product.title, product.raw_text, product.section].filter(Boolean).join(" "));
  let score = 0;

  score += addKeywordMatches({
    haystack: text,
    keywords: keywordConfig.positiveKeywordsHigh,
    points: 10,
    label: "keyword high",
    reasons
  });

  score += addKeywordMatches({
    haystack: text,
    keywords: keywordConfig.positiveKeywordsNormal,
    points: 5,
    label: "keyword normal",
    reasons
  });

  score += addKeywordMatches({
    haystack: text,
    keywords: keywordConfig.negativeKeywords,
    points: -10,
      label: "negative keyword",
    reasons
  });

  score += addKeywordMatches({
    haystack: text,
    keywords: keywordConfig.knownBrandsBonus,
    points: 8,
    label: "brand",
    reasons
  });

  if (containsAny(text, keywordConfig.smartHomeKeywords)) {
    score += 5;
    reasons.push("bonus: smart home");
  }

  if (containsAny(text, keywordConfig.electronicsOrToolKeywords)) {
    score += 5;
    reasons.push("bonus: electronics or tool");
  }

  if (containsAny(text, keywordConfig.genericAccessoryKeywords)) {
    score -= 5;
    reasons.push("malus: generic accessory");
  }

  if (containsAny(text, keywordConfig.nicheReplacementKeywords)) {
    score -= 10;
    reasons.push("malus: replacement or niche item");
  }

  return {
    score,
    reasons
  };
}

module.exports = {
  scoreProduct
};
