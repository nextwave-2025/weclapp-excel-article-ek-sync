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
// - nutzt NICHT mehr /articleSupplySource
// - liest direkt article.supplySources (so wie im Artikel-Reiter angezeigt)
// - bevorzugt lastPurchasePrice der Bezugsquelle
// - fallback: articlePrices der Bezugsquelle
// ============================================================
async function getLastPurchasePriceForArticle(article) {
  try {
    const primarySupplySourceId = article.primarySupplySourceId || null;

    // Bezugsquellen direkt vom Artikel (aus /article-Response)
    let supplySources = Array.isArray(article.supplySources)
      ? article.supplySources
      : [];

    if (!supplySources || supplySources.length === 0) {
      return {
        lastPurchasePrice: null,
        lastPurchasePriceCurrency: null,
        lastPurchasePriceDate: null
      };
    }

    // Wenn eine primäre Bezugsquelle gesetzt ist, diese bevorzugen
    if (primarySupplySourceId) {
      const primary = supplySources.find(src => src.id === primarySupplySourceId);
      if (primary) {
        supplySources = [primary];
      }
    }

    const ekEntries = [];

    for (const src of supplySources) {
      // 1) Direkt das Feld "letzter EK Preis" der Bezugsquelle, falls vorhanden
      if (src.lastPurchasePrice != null) {
        const tsDirect =
          typeof src.lastPurchasePriceDate === 'number'
            ? src.lastPurchasePriceDate
            : (typeof src.lastPurchaseDate === 'number'
                ? src.lastPurchaseDate
                : null);

        ekEntries.push({
          price: Number(src.lastPurchasePrice),
          currency: src.lastPurchasePriceCurrency || src.currencyName || null,
          ts: tsDirect
        });
      }

      // 2) Fallback: Preise aus articlePrices der Bezugsquelle (wie früher)
      const prices = src.articlePrices || [];
      for (const p of prices) {
        if (!p.price) continue;

        const tsPrice =
          typeof p.startDate === 'number'
            ? p.startDate
            : (typeof p.validFrom === 'number'
                ? p.validFrom
                : null);

        ekEntries.push({
          price: Number(p.price),
          currency: p.currencyName || src.currencyName || null,
          ts: tsPrice
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

    // Neuesten Eintrag nehmen (höchster Zeitstempel)
    ekEntries.sort((a, b) => {
      const ta = a.ts || 0;
      const tb = b.ts || 0;
      return tb - ta;
    });

    const last = ekEntries[0];

    return {
      lastPurchasePrice: last.price,
      lastPurchasePriceCurrency: last.currency,
      lastPurchasePriceDate: last.ts
        ? new Date(last.ts).toISOString()
        : null
    };

  } catch (err) {
    console.error(
      `Fehler beim Ermitteln des EK für Artikel ${article.id}:`,
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
app.get('/api/weclapp/articles-with-last-ek', async (req, res) => {
  try {
    console.log('API-Call: /api/weclapp/articles-with-last-ek');

    const articleResponse = await weclappGet('/article', {
      page: 1,
      pageSize: 1000
    });

    const allArticles = articleResponse?.result || articleResponse?.data || [];

    const mapped = await Promise.all(
      allArticles.map(async (a) => {
        const categoryMap = await getArticleCategoryMap();
        const hasPrices = Array.isArray(a.articlePrices) && a.articlePrices.length > 0;
        const firstPrice = hasPrices ? a.articlePrices[0] : null;

        // EK aus PRIMÄRER Bezugsquelle holen
        const ek = await getLastPurchasePriceForArticle(a);

        return {
          articleId: a.id ?? null,
          articleNumber: a.articleNumber ?? null,
          name: a.name ?? null,
          articleType: a.articleType ?? null,
          unitName: a.unitName ?? null,
          categoryId: a.articleCategoryId ?? null,
          categoryName: categoryMap[a.articleCategoryId] || null,


          // Verkaufspreis (z. B. NET1)
          salesPrice: firstPrice && firstPrice.price != null ? Number(firstPrice.price) : null,
          salesPriceCurrency: firstPrice && firstPrice.currencyName ? firstPrice.currencyName : null,

          // letzter Einkaufspreis aus primärer Bezugsquelle
          lastPurchasePrice: ek.lastPurchasePrice,
          lastPurchasePriceCurrency: ek.lastPurchasePriceCurrency,
          lastPurchasePriceDate: ek.lastPurchasePriceDate
        };
      })
    );

    res.json({
      success: true,
      count: mapped.length,
      items: mapped
    });

  } catch (err) {
    console.error(
      'Fehler bei /api/weclapp/articles-with-last-ek:',
      err.response?.data || err.message
    );

    res.status(500).json({
      success: false,
      message: 'Fehler beim Laden der Artikel aus weclapp',
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
