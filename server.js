/**
 * ToMeta AI Proxy Backend v3
 *
 * POST /api/gemini  → Google SDK ile Gemini (ScanMeta yöntemi) → Groq Vision fallback
 * POST /api/groq    → Groq Whisper (ses→TXT)
 * GET  /health      → Sağlık kontrolü
 */

const express    = require('express');
const multer     = require('multer');
const axios      = require('axios');
const FormData   = require('form-data');
const fs         = require('fs');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

const APP_SECRET     = process.env.APP_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;

if (!APP_SECRET || !GROQ_API_KEY) {
  console.error('❌ Eksik: APP_SECRET ve GROQ_API_KEY zorunlu');
  process.exit(1);
}

// ── Model listeleri ──────────────────────────────────────────────────────────
// ScanMeta'da çalışan Gemini modelleri (Google SDK formatı)
const GEMINI_MODELS = [
  'models/gemini-1.5-flash',
  'models/gemini-2.0-flash-lite',
  'models/gemini-2.0-flash',
  'models/gemini-1.5-pro',
];

// Groq Vision — görsel okuma (Gemini başarısız olursa)
const GROQ_VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'llama-3.2-90b-vision-preview',
  'llama-3.2-11b-vision-preview',
];

// Groq Whisper — ses transkripsiyon
const GROQ_WHISPER_MODELS = [
  'whisper-large-v3-turbo',
  'whisper-large-v3',
];

const upload = multer({ dest: '/tmp/tometa_uploads/', limits: { fileSize: 25 * 1024 * 1024 } });
const limiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Çok fazla istek.' } });
app.use(limiter);
app.use(express.json({ limit: '25mb' }));

function requireSecret(req, res, next) {
  const secret = req.headers['x-app-secret'] || req.body?.appSecret;
  if (!secret || secret !== APP_SECRET) {
    console.warn(`⛔ Yetkisiz: ${req.ip}`);
    return res.status(401).json({ error: 'Yetkisiz erişim.' });
  }
  next();
}

function cleanupFile(fp) {
  if (fp && fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch(_) {} }
}

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ToMeta AI Proxy v3', gemini: !!GEMINI_API_KEY, groq: !!GROQ_API_KEY });
});

// ── POST /api/gemini ─────────────────────────────────────────────────────────
app.post('/api/gemini', requireSecret, upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'Dosya bulunamadı.' });

    const mimeType   = req.body.mimeType   || 'image/jpeg';
    const sourceType = req.body.sourceType || 'image';
    const prompt = sourceType === 'image'
      ? 'Bu görseldeki tüm metni aynen çıkar. Sadece metni döndür, açıklama ekleme.'
      : 'Bu belgeden tüm metni çıkar. Orijinal paragraf ve satır düzenini koru. Sadece metni döndür.';

    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    // 1. Gemini — Google SDK formatında (ScanMeta yöntemi)
    if (GEMINI_API_KEY) {
      for (const model of GEMINI_MODELS) {
        try {
          console.log(`🔄 Gemini deneniyor: ${model}`);

          // SDK'nın kullandığı endpoint formatı (v1beta, model adı prefix'li)
          const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${GEMINI_API_KEY}`;

          const response = await axios.post(url, {
            contents: [{
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: base64Data } }
              ]
            }],
            generationConfig: {
              temperature: 0.1,
              topP: 0.95,
              maxOutputTokens: 8192
            },
            systemInstruction: {
              parts: [{ text: 'Gelişmiş OCR asistanısın. Karakter hatalarını düzelt. Sadece temiz metni döndür.' }]
            }
          }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 90000
          });

          const text = parseGeminiResponse(response.data);
          if (!text || text.trim() === '') throw new Error('Gemini boş yanıt döndürdü.');
          console.log(`✅ Gemini başarılı (${model}): ${text.length} karakter`);
          return res.json({ success: true, text: text.trim(), model });

        } catch (err) {
          const status = err.response?.status;
          const msg = err.response?.data?.error?.message || err.message;
          console.warn(`⚠️ ${model} başarısız (${status}): ${msg.slice(0, 100)}`);
          // 429 ve 503'te sonraki modeli dene, diğer hatalarda çık
          if (status !== 429 && status !== 503 && status !== 500) break;
        }
      }
    }

    // 2. Groq Vision fallback
    console.log('🔄 Groq Vision fallback devreye giriyor...');
    for (const model of GROQ_VISION_MODELS) {
      try {
        console.log(`🔄 Groq Vision: ${model}`);
        const response = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
              ],
            }],
            temperature: 0,
            max_tokens: 8192,
          },
          {
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 90000
          }
        );

        const text = response.data?.choices?.[0]?.message?.content || '';
        if (!text.trim()) throw new Error('Groq Vision boş yanıt.');
        console.log(`✅ Groq Vision başarılı (${model}): ${text.length} karakter`);
        return res.json({ success: true, text: text.trim(), model: `groq:${model}` });

      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.error?.message || err.message;
        console.warn(`⚠️ Groq Vision ${model} (${status}): ${msg.slice(0, 80)}`);
        if (status !== 429 && status !== 503) break;
      }
    }

    return res.status(502).json({ success: false, error: 'Gemini ve Groq Vision başarısız.' });

  } catch (err) {
    console.error('Genel hata:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    cleanupFile(filePath);
  }
});

// ── POST /api/groq — Whisper ─────────────────────────────────────────────────
app.post('/api/groq', requireSecret, upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'Dosya bulunamadı.' });
    const language = req.body.language || 'tr';
    let lastError = null;

    for (const model of GROQ_WHISPER_MODELS) {
      try {
        console.log(`🔄 Groq Whisper: ${model}`);
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
          { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() }, timeout: 120000 }
        );

        const text = typeof response.data === 'string' ? response.data : response.data?.text || '';
        if (!text.trim()) throw new Error('Groq boş transkripsiyon.');
        console.log(`✅ Groq Whisper başarılı (${model}): ${text.length} karakter`);
        return res.json({ success: true, text: text.trim(), model });

      } catch (err) {
        const status = err.response?.status;
        lastError = err.response?.data?.error?.message || err.message;
        console.warn(`⚠️ ${model} (${status}): ${lastError}`);
        if (status !== 429 && status !== 503 && status !== 500) break;
      }
    }

    return res.status(502).json({ success: false, error: `Groq başarısız: ${lastError}` });
  } catch (err) {
    console.error('Groq hata:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    cleanupFile(filePath);
  }
});

function parseGeminiResponse(data) {
  let result = '';
  for (const c of (data.candidates || []))
    for (const p of (c?.content?.parts || []))
      if (p.text) result += p.text;
  return result;
}

app.use((req, res) => res.status(404).json({ error: 'Endpoint bulunamadı.' }));
app.use((err, req, res, _next) => { console.error('Sunucu hatası:', err); res.status(500).json({ error: 'Sunucu hatası.' }); });

app.listen(PORT, () => {
  console.log(`🚀 ToMeta AI Proxy v3 → port ${PORT}`);
  console.log(`   Gemini: ${GEMINI_API_KEY ? '✅' : '⚠️ yok'} | Groq: ✅`);
});
