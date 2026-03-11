/**
 * ToMeta AI Proxy Backend
 *
 * Güvenli proxy: API key'leri sunucuda tutar, telefona göndermez.
 * Tüm istekler APP_SECRET ile doğrulanır.
 *
 * Desteklenen servisler:
 *  POST /api/gemini  → Google Gemini 2.0 Flash / Flash-Lite / Pro (fallback zinciri)
 *  POST /api/groq    → Groq Whisper Large v3 / v3 Turbo (fallback zinciri)
 *  GET  /health      → Sunucu sağlık kontrolü
 */

const express    = require('express');
const multer     = require('multer');
const axios      = require('axios');
const FormData   = require('form-data');
const fs         = require('fs');
const path       = require('path');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Ortam değişkenleri ───────────────────────────────────────────────────────
const APP_SECRET      = process.env.APP_SECRET;       // Uygulama ile paylaşılan gizli şifre
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;   // Google AI Studio
const GROQ_API_KEY    = process.env.GROQ_API_KEY;     // Groq Console

if (!APP_SECRET || !GEMINI_API_KEY || !GROQ_API_KEY) {
  console.error('❌ Eksik ortam değişkeni: APP_SECRET, GEMINI_API_KEY, GROQ_API_KEY gerekli');
  process.exit(1);
}

// ─── Gemini model fallback zinciri ────────────────────────────────────────────
// Ücretsiz limitler:
//   gemini-2.0-flash-lite : 1500 req/gün, 30 req/dk  ← ana model
//   gemini-2.0-flash      :  500 req/gün, 15 req/dk  ← yedek 1
//   gemini-1.5-flash      :  500 req/gün, 15 req/dk  ← yedek 2
const GEMINI_MODELS = [
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

// ─── Groq model fallback zinciri ─────────────────────────────────────────────
// Ücretsiz limitler:
//   whisper-large-v3-turbo : 20 req/dk, 7200 sn/saat  ← ana model (daha hızlı)
//   whisper-large-v3       : 20 req/dk, 7200 sn/saat  ← yedek
const GROQ_MODELS = [
  'whisper-large-v3-turbo',
  'whisper-large-v3',
];

// ─── Multer (dosya yükleme) ───────────────────────────────────────────────────
const upload = multer({
  dest: '/tmp/tometa_uploads/',
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max
});

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,      // 1 dakika
  max: 30,                   // IP başına 30 istek/dk
  message: { error: 'Çok fazla istek. Lütfen bekleyin.' },
});
app.use(limiter);

app.use(express.json({ limit: '25mb' }));

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
  const secret = req.headers['x-app-secret'] || req.body?.appSecret;
  if (!secret || secret !== APP_SECRET) {
    console.warn(`⛔ Yetkisiz erişim: ${req.ip} → ${req.path}`);
    return res.status(401).json({ error: 'Yetkisiz erişim.' });
  }
  next();
}

// ─── Yardımcı: dosyayı temizle ───────────────────────────────────────────────
function cleanupFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// ─── Sağlık kontrolü ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ToMeta AI Proxy',
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /api/gemini ─────────────────────────────────────────────────────────
/**
 * İstek (multipart/form-data):
 *   file       : Dosya (PDF, DOCX, JPG, PNG, WEBP, BMP, GIF)
 *   mimeType   : Dosyanın MIME tipi (örn. "application/pdf")
 *   sourceType : "image" | "document"  (prompt seçimi için)
 *
 * Header:
 *   x-app-secret : APP_SECRET değeri
 *
 * Yanıt:
 *   { success: true, text: "..." }
 *   { success: false, error: "..." }
 */
app.post('/api/gemini', requireSecret, upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Dosya bulunamadı.' });
    }

    const mimeType   = req.body.mimeType   || 'application/octet-stream';
    const sourceType = req.body.sourceType || 'document';

    const prompt = sourceType === 'image'
      ? 'Bu görseldeki tüm metni aynen çıkar. Sadece metni döndür, açıklama ekleme.'
      : 'Bu belgeden tüm metni çıkar. Orijinal paragraf ve satır düzenini koru. Sadece metni döndür.';

    // Dosyayı base64'e çevir
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    const requestBody = {
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data,
            },
          },
        ],
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8192,
      },
    };

    // Model fallback zinciri
    let lastError = null;
    for (const model of GEMINI_MODELS) {
      try {
        console.log(`🔄 Gemini deneniyor: ${model}`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        const response = await axios.post(url, requestBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 90000, // 90 saniye
        });

        const text = parseGeminiResponse(response.data);
        if (!text || text.trim() === '') {
          throw new Error('Gemini boş yanıt döndürdü.');
        }

        console.log(`✅ Gemini başarılı (${model}): ${text.length} karakter`);
        return res.json({ success: true, text: text.trim(), model });

      } catch (err) {
        const status = err.response?.status;
        lastError = err.response?.data?.error?.message || err.message;
        console.warn(`⚠️ ${model} başarısız (${status}): ${lastError}`);

        // 429 (rate limit) veya 503 → bir sonraki modeli dene
        // Diğer hatalar → direkt başarısız say
        if (status !== 429 && status !== 503 && status !== 500) break;
      }
    }

    return res.status(502).json({
      success: false,
      error: `Tüm Gemini modelleri başarısız: ${lastError}`,
    });

  } catch (err) {
    console.error('Gemini genel hata:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    cleanupFile(filePath);
  }
});

// ─── POST /api/groq ───────────────────────────────────────────────────────────
/**
 * İstek (multipart/form-data):
 *   file     : Ses/Video dosyası (mp3, mp4, wav, avi, flac, ogg, webm, m4a)
 *   language : Dil kodu (varsayılan: "tr")
 *
 * Header:
 *   x-app-secret : APP_SECRET değeri
 *
 * Yanıt:
 *   { success: true, text: "..." }
 *   { success: false, error: "..." }
 */
app.post('/api/groq', requireSecret, upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Dosya bulunamadı.' });
    }

    const language = req.body.language || 'tr';

    // Model fallback zinciri
    let lastError = null;
    for (const model of GROQ_MODELS) {
      try {
        console.log(`🔄 Groq deneniyor: ${model}`);

        const form = new FormData();
        form.append('file', fs.createReadStream(filePath), {
          filename: req.file.originalname || 'audio.mp3',
          contentType: req.file.mimetype || 'application/octet-stream',
        });
        form.append('model', model);
        form.append('response_format', 'text');
        form.append('language', language);

        const response = await axios.post(
          'https://api.groq.com/openai/v1/audio/transcriptions',
          form,
          {
            headers: {
              'Authorization': `Bearer ${GROQ_API_KEY}`,
              ...form.getHeaders(),
            },
            timeout: 120000, // 2 dakika
          }
        );

        const text = typeof response.data === 'string'
          ? response.data
          : response.data?.text || '';

        if (!text || text.trim() === '') {
          throw new Error('Groq boş transkripsiyon döndürdü.');
        }

        console.log(`✅ Groq başarılı (${model}): ${text.length} karakter`);
        return res.json({ success: true, text: text.trim(), model });

      } catch (err) {
        const status = err.response?.status;
        lastError = err.response?.data?.error?.message || err.message;
        console.warn(`⚠️ ${model} başarısız (${status}): ${lastError}`);

        if (status !== 429 && status !== 503 && status !== 500) break;
      }
    }

    return res.status(502).json({
      success: false,
      error: `Tüm Groq modelleri başarısız: ${lastError}`,
    });

  } catch (err) {
    console.error('Groq genel hata:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    cleanupFile(filePath);
  }
});

// ─── Gemini yanıt ayrıştırıcı ────────────────────────────────────────────────
function parseGeminiResponse(data) {
  try {
    const candidates = data.candidates || [];
    let result = '';
    for (const candidate of candidates) {
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        if (part.text) result += part.text;
      }
    }
    return result;
  } catch (e) {
    throw new Error(`Gemini yanıtı ayrıştırılamadı: ${e.message}`);
  }
}

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint bulunamadı.' });
});

// ─── Global hata handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('Sunucu hatası:', err);
  res.status(500).json({ error: 'Sunucu hatası.' });
});

// ─── Başlat ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 ToMeta AI Proxy başlatıldı → port ${PORT}`);
  console.log(`   Gemini modeller: ${GEMINI_MODELS.join(' → ')}`);
  console.log(`   Groq modeller:   ${GROQ_MODELS.join(' → ')}`);
});
