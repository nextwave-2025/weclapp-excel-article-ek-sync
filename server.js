// ================================================
// Minimalistische Weclapp → Excel API
// Artikel + letzter EK aus definierten Warengruppen
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
// Ziel-Warengruppen (kann später vom Nutzer angepasst werden)
// ============================================================
const TARGET_PRODUCT_GROUPS = [
  'BAREBONE Mini PC',
  'RUGGED TABLET',
  'CPU',
  'RAM',
  'SSD',
  'OS',
  'GRAFIKKARTE',
  'WIFI',
  'NETZTEILE',
  'ACESSOIRES'
];

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
// API Endpoint für Excel (Power Query)
// ============================================================
app.get('/api/weclapp/articles-with-last-ek', async (req, res) => {
  try {
    console.log('API-Call: /api/weclapp/articles-with-last-ek');

    // Bis zu 1000 Artikel auslesen (Weclapp-Beschränkung)
   const articleResponse = await weclappGet('/article', {
  page: 1,
  pageSize: 1000
});



    const allArticles = articleResponse?.result || articleResponse?.data || [];

    // ⚠️ Debug: vorerst KEIN Filter nach Warengruppe
const mapped = allArticles.map(a => a);




    res.json({
      success: true,
      count: mapped.length,
      items: mapped
    });

  } catch (err) {
  console.error('Fehler bei /api/weclapp/articles-with-last-ek:', err.response?.data || err.message);

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
