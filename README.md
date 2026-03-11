# ToMeta AI Proxy

Gemini ve Groq API key'lerini güvenli şekilde saklayan proxy sunucusu.

## Kurulum

### 1. GitHub'a yükle
```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/KULLANICI_ADIN/tometa-ai-proxy.git
git push -u origin main
```

### 2. Render'da aç
1. https://render.com → New → Web Service
2. GitHub repo'nu bağla
3. Free planı seç
4. **Environment Variables** bölümüne ekle:

| Key | Value |
|-----|-------|
| `APP_SECRET` | En az 32 karakterli güçlü şifre |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `GROQ_API_KEY` | https://console.groq.com/keys |

### 3. Android uygulamasına ekle
`ApiService.kt` dosyasında:
```kotlin
const val AI_PROXY_URL = "https://tometa-ai-proxy.onrender.com/"
const val APP_SECRET   = "buraya_render_deki_secret_yaz"
```

## Endpoint'ler

### POST /api/gemini
PDF, DOCX, görsel → metin çıkarma

**Header:** `x-app-secret: APP_SECRET`

**Form-data:**
- `file` — Dosya
- `mimeType` — MIME tipi (örn. `application/pdf`)
- `sourceType` — `image` veya `document`

### POST /api/groq
Ses/Video → metin transkripsiyon

**Header:** `x-app-secret: APP_SECRET`

**Form-data:**
- `file` — Ses/video dosyası
- `language` — Dil kodu (varsayılan: `tr`)

### GET /health
Sunucu durumu

## Model Fallback Zinciri

**Gemini** (sırayla denenir):
1. `gemini-2.0-flash-lite` — 1500 req/gün ücretsiz
2. `gemini-2.0-flash` — 500 req/gün ücretsiz
3. `gemini-1.5-flash` — 500 req/gün ücretsiz

**Groq** (sırayla denenir):
1. `whisper-large-v3-turbo` — 20 req/dk, daha hızlı
2. `whisper-large-v3` — 20 req/dk, daha doğru
