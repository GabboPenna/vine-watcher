"use strict";

const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  fs.mkdirSync(path.resolve(dirPath), { recursive: true });
}

function ensureDirForFile(filePath) {
  ensureDir(path.dirname(path.resolve(filePath)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function delayWithJitter(baseSeconds, jitterSeconds) {
  const jitter = Math.max(0, Number(jitterSeconds) || 0);
  const base = Math.max(1, Number(baseSeconds) || 1);
  return (base + randomInt(0, jitter)) * 1000;
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripDiacritics(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeTextForMatch(value) {
  return stripDiacritics(normalizeWhitespace(value))
    .toLowerCase()
    .replace(/[\u2019`]/g, "'")
    .replace(/[^\p{L}\p{N}+#.'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(title) {
  return normalizeTextForMatch(title)
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function truncate(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function extractAsinFromText(value) {
  const text = String(value || "");
  const direct = text.match(/(?:\/dp\/|\/gp\/product\/|asin[=/: ]|data-asin=["']?)([A-Z0-9]{10})/i);
  if (direct) {
    return direct[1].toUpperCase();
  }
  const likely = text.match(/\bB[0-9A-Z]{9}\b/i);
  return likely ? likely[0].toUpperCase() : "";
}

function canonicalizeAmazonUrl(value, baseUrl) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value, baseUrl || "https://www.amazon.it");
    const asin = extractAsinFromText(url.href);
    if (asin && /amazon\./i.test(url.hostname)) {
      return `${url.origin}/dp/${asin}`;
    }
    url.hash = "";
    return url.toString();
  } catch (_error) {
    return "";
  }
}

function canonicalizeUrl(value, baseUrl) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value, baseUrl || "https://www.amazon.it");
    url.hash = "";
    return url.toString();
  } catch (_error) {
    return "";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function identityKey(product) {
  if (product.asin) {
    return `asin:${product.asin}`;
  }
  if (product.url) {
    return `url:${product.url}`;
  }
  return `title:${product.normalized_title || normalizeTitle(product.title)}`;
}

function uniqueProducts(products) {
  const seen = new Set();
  const output = [];
  for (const product of products) {
    const key = identityKey(product);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(product);
  }
  return output;
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

module.exports = {
  canonicalizeAmazonUrl,
  canonicalizeUrl,
  delayWithJitter,
  ensureDir,
  ensureDirForFile,
  escapeCsv,
  extractAsinFromText,
  identityKey,
  normalizeTextForMatch,
  normalizeTitle,
  normalizeWhitespace,
  nowIso,
  safeJsonParse,
  sleep,
  truncate,
  uniqueProducts
};
