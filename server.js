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
// Helper: letzten EK aus Bezugsquellen holen
// - nutzt /articleSupplySource
// - sucht über alle articlePrices den neuesten (höchstes startDate)
// ============================================================
async function getLastPurchasePriceForArticle(articleId) {
  try {
    const supplyResponse = await weclappGet('/articleSupplySource', {
      page: 1,
      pageSize: 100,
      articleId: articleId
    });

    const supplySources = supplyResponse?.result || supplyResponse?.data || [];

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

    // nach Startdatum sortieren (neuester zuerst)
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
      `Fehler beim Laden der Bezugsquellen für Artikel ${articleId}:`,
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

    // Alle Artikel parallel mit EK anreichern
    const mapped = await Promise.all(
      allArticles.map(async (a) => {
        const hasPrices = Array.isArray(a.articlePrices) && a.articlePrices.length > 0;
        const firstPrice = hasPrices ? a.articlePrices[0] : null;

        // EK aus Bezugsquelle holen
        const ek = await getLastPurchasePriceForArticle(a.id);

        return {
          articleId: a.id ?? null,
          articleNumber: a.articleNumber ?? null,
          name: a.name ?? null,
          articleType: a.articleType ?? null,
          unitName: a.unitName ?? null,

          // Verkaufspreis (z. B. NET1)
          salesPrice: firstPrice && firstPrice.price != null ? Number(firstPrice.price) : null,
          salesPriceCurrency: firstPrice && firstPrice.currencyName ? firstPrice.currencyName : null,

          // letzter Einkaufspreis aus Bezugsquellen
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
