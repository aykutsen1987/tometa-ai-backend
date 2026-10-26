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
// Render ters proxy arkasında çalışır: gerçek istemci IP'si için gerekli (rate-limit her kullanıcıyı ayrı saysın)
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const APP_SECRET     = process.env.APP_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;

if (!APP_SECRET || !GROQ_API_KEY) {
  console.error('❌ Eksik: APP_SECRET ve GROQ_API_KEY zorunlu');
  process.exit(1);
}

// ── Model listeleri ──────────────────────────────────────────────────────────
// Model adları sık değişir (gemini-1.5-*, gemini-2.0-*, llama-3.2-vision, llama-4-scout/maverick
// kapatıldı). Bu yüzden:
//   1) GEMINI_MODELS / GROQ_VISION_MODELS ortam değişkeni varsa (virgülle ayrılmış) o kullanılır,
//   2) yoksa API'nin model listesinden güncel Flash / vision modelleri otomatik seçilir,
//   3) o da başarısız olursa "latest" takma adlarına düşülür.
const GEMINI_FALLBACK = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const GROQ_WHISPER_MODELS = (process.env.GROQ_WHISPER_MODELS || 'whisper-large-v3-turbo,whisper-large-v3')
  .split(',').map(s => s.trim()).filter(Boolean);
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;
const GEMINI_MAX_OUTPUT = parseInt(process.env.GEMINI_MAX_OUTPUT || '32768', 10);

const modelCache = { gemini: { at: 0, list: [] }, groqVision: { at: 0, list: [] } };

function envList(name) {
  return (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
}

function versionOf(id) {
  const m = id.match(/gemini-(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

async function getGeminiModels() {
  const forced = envList('GEMINI_MODELS');
  if (forced.length) return forced;
  const c = modelCache.gemini;
  if (c.list.length && Date.now() - c.at < MODEL_CACHE_MS) return c.list;
  try {
    const r = await axios.get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': GEMINI_API_KEY }, timeout: 15000
    });
    const ids = (r.data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(id => /^gemini-[\d.]+-flash(-lite)?(-preview)?(-\d{2}-\d{4})?$/.test(id))
      .filter(id => !/(image|tts|live|audio|embedding|robotics|computer|omni|thinking)/.test(id));
    ids.sort((a, b) => {
      const dv = versionOf(b) - versionOf(a);
      if (dv) return dv;
      const pa = /preview/.test(a) ? 1 : 0, pb = /preview/.test(b) ? 1 : 0;   // kararlı önce
      if (pa !== pb) return pa - pb;
      return (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0);              // flash, lite'tan önce
    });
    const list = [...new Set(ids)].slice(0, 4);
    if (list.length) {
      modelCache.gemini = { at: Date.now(), list };
      console.log('🔎 Gemini modelleri:', list.join(', '));
      return list;
    }
  } catch (err) {
    console.warn('⚠️ Gemini model listesi alınamadı:', err.response?.status || err.message);
  }
  return c.list.length ? c.list : GEMINI_FALLBACK;
}

async function getGroqVisionModels() {
  const forced = envList('GROQ_VISION_MODELS');
  if (forced.length) return forced;
  const c = modelCache.groqVision;
  if (c.list.length && Date.now() - c.at < MODEL_CACHE_MS) return c.list;
  try {
    const r = await axios.get('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, timeout: 15000
    });
    const list = (r.data.data || []).map(m => m.id)
      .filter(id => /(vision|-vl|scout|maverick)/i.test(id) && !/(guard|whisper|tts|safeguard)/i.test(id))
      .slice(0, 3);
    if (list.length) {
      modelCache.groqVision = { at: Date.now(), list };
      console.log('🔎 Groq vision modelleri:', list.join(', '));
      return list;
    }
  } catch (err) {
    console.warn('⚠️ Groq model listesi alınamadı:', err.response?.status || err.message);
  }
  return c.list;
}

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
      : 'Bu belgenin (taranmış olabilir) TÜM sayfalarındaki metni sırayla çıkar. Paragrafları boş satırla ayır, ' +
        'başlıkları ayrı satırda yaz, tabloları satır satır ve hücreleri sekme (tab) ile ayırarak yaz. ' +
        'Hiçbir bölümü atlama, özetleme veya yorum ekleme. Sadece metni döndür.';

    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    // 1. Gemini
    if (GEMINI_API_KEY) {
      for (const model of await getGeminiModels()) {
        try {
          console.log(`🔄 Gemini deneniyor: ${model}`);
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

          const response = await axios.post(url, {
            contents: [{
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: base64Data } }
              ]
            }],
            generationConfig: { temperature: 0.1, topP: 0.95, maxOutputTokens: GEMINI_MAX_OUTPUT },
            systemInstruction: {
              parts: [{ text: 'Sen bir OCR ve belge okuma asistanısın. Türkçe karakterleri (ç, ğ, ı, İ, ö, ş, ü) doğru yaz. Sadece belgedeki metni döndür; yorum veya açıklama ekleme.' }]
            }
          }, {
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
            timeout: 120000,
            maxBodyLength: Infinity
          });

          const cand = response.data?.candidates?.[0];
          if (cand?.finishReason === 'MAX_TOKENS') console.warn(`⚠️ ${model}: çıktı MAX_TOKENS ile kesildi`);
          const text = parseGeminiResponse(response.data);
          if (!text || text.trim() === '') throw new Error('Gemini boş yanıt döndürdü.');
          console.log(`✅ Gemini başarılı (${model}): ${text.length} karakter`);
          return res.json({ success: true, text: text.trim(), model });

        } catch (err) {
          const status = err.response?.status;
          const msg = err.response?.data?.error?.message || err.message;
          console.warn(`⚠️ ${model} başarısız (${status}): ${String(msg).slice(0, 120)}`);
          // Model yok (404), kota (429), geçici hata (5xx) → sıradaki model; diğerlerinde çık
          if (![404, 429, 500, 503].includes(status)) break;
        }
      }
    }

    // 2. Groq Vision fallback
    console.log('🔄 Groq Vision fallback devreye giriyor...');
    const isImage = /^image\//.test(mimeType);
    for (const model of (isImage ? await getGroqVisionModels() : [])) {
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
        if (![404, 429, 503].includes(status)) break;
      }
    }

    return res.status(502).json({ success: false, error: 'Yapay zekâ servisleri şu an yanıt vermiyor (model/kota). Daha sonra tekrar deneyin.' });

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
