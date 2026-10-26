# tometa-ai-backend

ToMeta için yapay zekâ vekil sunucusu: Gemini (görsel/PDF → metin) ve Groq Whisper (ses/video → metin).
API anahtarları uygulamada değil, yalnızca burada (Render ortam değişkenleri) durur.

## Endpoint'ler
| Yöntem | Yol | Açıklama |
|---|---|---|
| GET | `/health` | Sağlık kontrolü |
| POST | `/api/gemini` | `file`, `mimeType`, `sourceType` (`image`/`document`) → `{success, text, model}` |
| POST | `/api/groq` | `file`, `language` → `{success, text, model}` |

Başlık: `x-app-secret: <APP_SECRET>` (zorunlu).

## Ortam değişkenleri
| Anahtar | Zorunlu | Açıklama |
|---|---|---|
| `APP_SECRET` | evet | Uygulamadaki `ApiService.Security.APP_SECRET` ile birebir aynı |
| `GROQ_API_KEY` | evet | Groq anahtarı |
| `GEMINI_API_KEY` | hayır* | Yoksa Gemini atlanır; görsel okuma yalnızca Groq vision'a düşer |
| `GEMINI_MODELS` | hayır | Virgülle ayrılmış; otomatik model seçimini ezer |
| `GROQ_VISION_MODELS`, `GROQ_WHISPER_MODELS` | hayır | Aynı mantık |

Model adları sık kapatılır; boş bırakırsan sunucu güncel modelleri API'den kendisi seçer (6 saat önbellek).

## Yerelde çalıştırma
```bash
npm install
APP_SECRET=test GROQ_API_KEY=xxx GEMINI_API_KEY=yyy npm start
curl localhost:3000/health
```
