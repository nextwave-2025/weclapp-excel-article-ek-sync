// Hilfsfunktion: Zahl aus Weclapp-Feld robust parsen (String, Komma etc.)
function parseWeclappNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const s = String(value).replace('.', '').replace(',', '.'); // "685,00" → "685.00"
  const num = parseFloat(s);
  return isNaN(num) ? null : num;
}

// Hilfsfunktion: macht aus Bezugsquellen eine Map { articleId: { price, currency, date } }
async function buildSupplyPriceMap() {
  const ekMap = {};

  // Wir holen eine große Page – wenn du später viel mehr Artikel hast, kannst du paginieren
  const resp = await weclappGet('/articleSupplySource', {
    page: 1,
    pageSize: 1000
  });

  const sources = resp.result || resp.data || [];

  for (const src of sources) {
    const articleId = src.articleId || src.articleIdId || src.articleIdFk; // je nach Schema
    if (!articleId) continue;

    // Jetzt die eigentliche Einkaufspreisliste – das musst du mit deiner Debug-Struktur abgleichen
    const priceList = src.purchasePrices || src.prices || [];

    for (const p of priceList) {
      const priceValue = parseWeclappNumber(p.price || p.amount || p.purchasePrice);
      if (priceValue == null) continue;

      const currency =
        p.currencyName || p.currency || p.currencyCode || 'EUR';

      // Datum: was immer ihr habt – validFrom, startDate, changedDate …
      const dateString =
        p.validFrom || p.startDate || p.changedDate || null;

      const timestamp = dateString ? new Date(dateString).getTime() : 0;

      const existing = ekMap[articleId];

      // Wir nehmen immer den Eintrag mit dem "neueren" Datum
      if (!existing || timestamp > existing.timestamp) {
        ekMap[articleId] = {
          price: priceValue,
          currency,
          date: dateString,
          timestamp
        };
      }
    }
  }

  return ekMap;
}





// ============================================================
// Helper: Artikel-Kategorien (Warengruppen) aus weclapp holen
// ============================================================
let articleCategoryCache = null;

async function getArticleCategoryMap() {
  if (articleCategoryCache) {
    return articleCategoryCache;
  }

  const categoryResponse = await weclappGet('/articleCategory', {
    page: 1,
    pageSize: 500 // bei Bedarf erhöhen
  });

  const cats = categoryResponse?.result || categoryResponse?.data || [];
  const map = {};

  for (const c of cats) {
    map[c.id] = c.name || c.description || null;
  }

  articleCategoryCache = map;
  return map;
}


// ================================================
// Weclapp → Excel API
// Artikel mit Artikelnummer, VK-Preis & letztem EK
// ================================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

// ============================================================
// ENV Variablen (müssen in Railway gesetzt werden)
// ============================================================
const WECLAPP_BASE_URL = process.env.WECLAPP_BASE_URL;
const WECLAPP_API_KEY  = process.env.WECLAPP_API_KEY;

if (!WECLAPP_BASE_URL || !WECLAPP_API_KEY) {
  console.warn("⚠️  WARNUNG: WECLAPP_BASE_URL oder WECLAPP_API_KEY fehlt. Bitte in Railway setzen.");
}

// ============================================================
// Helper: GET-Request an Weclapp (mit Token)
// ============================================================
async function weclappGet(path, params = {}) {
  if (!WECLAPP_BASE_URL || !WECLAPP_API_KEY) {
    throw new Error('WECLAPP_BASE_URL oder WECLAPP_API_KEY ist nicht gesetzt');
  }

  const url = `${WECLAPP_BASE_URL}${path}`;

  const response = await axios.get(url, {
    headers: {
      'Content-Type': 'application/json',
      'AuthenticationToken': WECLAPP_API_KEY
    },
    params
  });

  return response.data;
}

// ============================================================
// Helper: letzten EK aus der PRIMÄREN Bezugsquelle holen
// - nutzt /articleSupplySource
// - filtert auf article.primarySupplySourceId
// - sucht in articlePrices den neuesten Eintrag (höchstes startDate)
// ============================================================
async function getLastPurchasePriceForArticle(article) {
  try {
    const articleId = article.id;
    const primarySupplySourceId = article.primarySupplySourceId || null;

    const supplyResponse = await weclappGet('/articleSupplySource', {
      page: 1,
      pageSize: 100,
      articleId: articleId
    });

    let supplySources = supplyResponse?.result || supplyResponse?.data || [];

    // Nur die primäre Bezugsquelle verwenden, falls vorhanden
    if (primarySupplySourceId) {
      supplySources = supplySources.filter(src => src.id === primarySupplySourceId);
    }

    const ekEntries = [];

    for (const src of supplySources) {
      const prices = src.articlePrices || [];
      for (const p of prices) {
        if (!p.price) continue;

        const startTs = p.startDate ?? null;

        ekEntries.push({
          price: Number(p.price),
          currency: p.currencyName || null,
          startTs: typeof startTs === 'number' ? startTs : null
        });
      }
    }

    if (ekEntries.length === 0) {
      return {
        lastPurchasePrice: null,
        lastPurchasePriceCurrency: null,
        lastPurchasePriceDate: null
      };
    }

    // Nach Startdatum sortieren (neuester zuerst)
    ekEntries.sort((a, b) => {
      const ta = a.startTs || 0;
      const tb = b.startTs || 0;
      return tb - ta;
    });

    const last = ekEntries[0];

    return {
      lastPurchasePrice: last.price,
      lastPurchasePriceCurrency: last.currency,
      lastPurchasePriceDate: last.startTs ? new Date(last.startTs).toISOString() : null
    };

  } catch (err) {
    console.error(
      `Fehler beim Laden der Bezugsquellen für Artikel ${article.id}:`,
      err.response?.data || err.message
    );

    return {
      lastPurchasePrice: null,
      lastPurchasePriceCurrency: null,
      lastPurchasePriceDate: null
    };
  }
}

// ============================================================
// API Endpoint für Excel (Power Query)
// ============================================================
// ============================================================
// API für Excel: Artikel + letzter EK direkt aus /article
// mit expliziten properties (damit Weclapp die Felder liefert)
// ============================================================
app.get('/api/weclapp/articles-with-last-ek', async (req, res) => {
  try {
    console.log('API-Call: /api/weclapp/articles-with-last-ek');

    // 1) Artikel mit expliziten Eigenschaften holen
    const articleResp = await weclappGet('/article', {
      page: 1,
      pageSize: 1000,
     // NEU (ohne ungültige Property)
properties: [
  'id',
  'articleNumber',
  'name',
  'articleType',
  'unitName',
  'articleCategoryId',
  'articlePrices',
  'lastPurchasePrice',
  'lastPurchasePriceDate'
].join(',')

    });

    const allArticles = articleResp.result || articleResp.data || [];

    // 2) Für Excel aufbereiten
    const mapped = allArticles.map(a => {
      // Verkaufspreis aus articlePrices (falls vorhanden)
      let salesPrice = null;
      let salesPriceCurrency = null;

      if (Array.isArray(a.articlePrices) && a.articlePrices.length > 0) {
        const p = a.articlePrices[0];
        salesPrice = p.price ? Number(p.price) : null;
        salesPriceCurrency = p.currencyName || p.currency || null;
      }

      return {
        articleId: a.id,
        articleNumber: a.articleNumber || a.number || null,
        name: a.name || '',
        articleType: a.articleType || '',
        unitName: a.unitName || '',
        categoryId: a.articleCategoryId || a.categoryId || null,
        categoryName: a.articleCategoryName || a.categoryName || '',
        salesPrice,
        salesPriceCurrency,
        lastPurchasePrice: a.lastPurchasePrice ?? null,
        lastPurchasePriceDate: a.lastPurchasePriceDate ?? null
      };
    });

    res.json({
      success: true,
      count: mapped.length,
      items: mapped
    });

  } catch (error) {
    console.error(
      'Fehler bei /api/weclapp/articles-with-last-ek:',
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      message: 'Fehler beim Laden der Artikel aus weclapp',
      error: error.message,
      weclappResponse: error.response?.data || null
    });
  }
});



// Nur zum Debuggen: Zeigt alle Bezugsquellen / Einkaufspreise für einen Artikel
app.get('/api/weclapp/debug-sources/:articleId', async (req, res) => {
  try {
    const articleId = req.params.articleId;

    console.log('Debug: Lade Bezugsquellen für Artikel', articleId);

    // Variante A: Bezugsquellen direkt am Artikel
    const sourcesResp = await weclappGet('/articleSupplySource', {
      articleId,
      page: 1,
      pageSize: 50
    });

    res.json({
      success: true,
      from: '/articleSupplySource',
      raw: sourcesResp
    });

  } catch (err) {
    console.error('Fehler in /api/weclapp/debug-sources:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      weclappResponse: err.response?.data || null
    });
  }
});




// ============================================================
// Server starten
// ============================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Weclapp EK API läuft auf Port ${PORT}`);
});
