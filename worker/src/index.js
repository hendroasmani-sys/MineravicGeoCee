/**
 * MINERAVIX PULSE — Cloudflare Worker
 * Proxy aman untuk Anthropic API (Claude)
 * PT. Citra Eksplor Energi (GEOCEE)
 *
 * SOURCE OF TRUTH: this file in git (repo MineravicGeoCee, folder worker/).
 * Do not edit code in the Cloudflare dashboard, or git goes stale.
 *
 * DEPLOY (from worker/, see README.md):
 *   bash scripts/check.sh
 *   npx wrangler secret put CLAUDE_API_KEY   # first time / key rotation only
 *   npx wrangler deploy
 *
 * The Anthropic key lives ONLY as the Cloudflare secret CLAUDE_API_KEY.
 * Never hardcode it here and never commit .dev.vars.
 */

// SECURITY: locked to the app's real origin — no longer "*". Two layers here:
// 1. CORS headers (below) tell BROWSERS on other websites they may not read
//    responses from this Worker — stops other sites embedding our API in their
//    frontend and burning our Anthropic quota.
// 2. Active Origin check in fetch() (below) — requests whose Origin header is
//    missing or wrong get rejected with 403 BEFORE any Anthropic call is made.
// Honest limitation: a non-browser client (curl/Postman/script) can fake the
// Origin header, so this is a strong barrier against drive-by/website abuse but
// not against a determined attacker with a script. Hard quota enforcement would
// need server-side usage tracking (Cloudflare KV) — separate upgrade, discussed.
// NOTE: if the app later moves to a custom domain (e.g. mineravix.io), add it
// to this list — requests from the old origin keep working during transition.
const ALLOWED_ORIGINS = [
  "https://hendroasmani-sys.github.io",
];

function resolveOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

export default {
  async fetch(request, env) {

    // Active origin gate — reject anything not coming from the official app
    // BEFORE any work (and before any paid Anthropic call) happens.
    //
    // BUG FIX (found via real-world testing): this rejection response used to have
    // NO CORS headers at all. A response with no Access-Control-Allow-Origin header
    // is invisible to browser JS regardless of its actual HTTP status — the browser
    // blocks it as an opaque CORS failure, and fetch() in index.html rejects with a
    // generic network error instead of a readable 403. That error still SHOULD have
    // been caught by the outer try/catch and shown as a fallback message — but the
    // net effect observed was "Menganalisis..." stuck forever with nothing shown,
    // which is exactly the symptom of a response the browser refuses to hand to JS
    // at all. CORS headers only control who's allowed to READ a response, not who's
    // allowed to REACH the Worker — sending them here doesn't weaken the origin gate
    // (the 403 status and empty body still block real API access either way), it
    // just makes the rejection debuggable/visible instead of a silent black hole.
    const origin = resolveOrigin(request);
    if (!origin) {
      const requestOrigin = request.headers.get("Origin") || "";
      return new Response(JSON.stringify({ error: "Forbidden", reason: "origin_blocked" }), {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": requestOrigin || "null",
        },
      });
    }

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Hanya terima POST ke /analyze
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/analyze") {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: corsHeaders(origin),
      });
    }

    // Parse body dari Pulse app
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: corsHeaders(origin),
      });
    }

    // Validasi field wajib
    const required = ["lat", "lon", "scores", "formasi", "wiup", "hutan"];
    for (const field of required) {
      if (body[field] === undefined) {
        return new Response(
          JSON.stringify({ error: `Missing field: ${field}` }),
          { status: 400, headers: corsHeaders(origin) }
        );
      }
    }

    // Bangun prompt untuk Claude
    const prompt = buildPrompt(body);

    // API key comes only from the Cloudflare secret CLAUDE_API_KEY. Fail closed
    // (readable 500 with CORS headers) if it is missing, instead of sending an
    // unauthenticated request to Anthropic.
    const apiKey = env.CLAUDE_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Server misconfigured", reason: "missing_api_key" }),
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    // Panggil Anthropic API
    let anthropicRes;
    try {
      anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 4000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Gagal menghubungi AI. Coba lagi." }),
        { status: 502, headers: corsHeaders(origin) }
      );
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      // Distinguishes "Anthropic rejected the request" (bad/revoked API key, no credit,
      // rate limited, etc — needs Hendro to check console.anthropic.com) from the
      // origin_blocked case above (needs checking ALLOWED_ORIGINS) — both can surface
      // as a 403 to the client, but the fix for each is completely different, so the
      // client-side error message needs to tell them apart rather than showing "IA ERROR
      // (403)" for both indistinguishably.
      return new Response(
        JSON.stringify({ error: "API error", reason: "anthropic_error", detail: errText }),
        { status: anthropicRes.status, headers: corsHeaders(origin) }
      );
    }

    const data = await anthropicRes.json();
    const rawText = data.content?.[0]?.text ?? "";
    // "max_tokens" here means Claude's response got cut off mid-generation before it
    // could finish the JSON — a real, distinct failure mode from "malformed JSON",
    // worth telling apart so troubleshooting doesn't chase the wrong cause.
    const wasTruncated = data.stop_reason === "max_tokens";

   // Parse JSON dari response Claude — strip markdown code fence dulu (```json ... ```)
   // kalau ada, baru ambil isi di antara { pertama dan } terakhir. Kedua langkah ini
   // sekaligus lebih tahan banting daripada cuma salah satunya.
let parsed;
try {
  let cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/,'');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) throw new Error('No JSON object found');
  const clean = cleaned.slice(firstBrace, lastBrace + 1);
  parsed = JSON.parse(clean);
} catch (err) {
  // Carry real diagnostic info instead of a bare flag — visible in the browser's
  // Network tab (Response body) even without Cloudflare log access, so a repeat
  // failure can be root-caused directly instead of guessed at.
  parsed = {
    raw: rawText.slice(0, 500),
    parseError: true,
    wasTruncated,
    stopReason: data.stop_reason || null,
    parseErrorMessage: err.message
  };
}

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  },
};

// ─── System Prompt untuk Claude ───────────────────────────────────────────────
const SYSTEM_PROMPT = `Kamu adalah GEOCEE AI — asisten analisis geologi dan pertambangan untuk Mineravix Pulse, platform milik PT. Citra Eksplor Energi (GEOCEE).

Tugasmu: menganalisis data 5-pillar dari koordinat yang diberikan dan menghasilkan interpretasi dalam Bahasa Indonesia yang profesional, ringkas, dan kontekstual.

Kamu adalah "suara geologist" — bukan chatbot. Kamu hanya menganalisis data yang diberikan, tidak menjawab pertanyaan umum.

ATURAN MUTLAK — KONSISTENSI DATA:
Semua nilai dalam data (status, jumlah, jarak, kategori) sudah dihitung secara programatik dari database resmi (ESDM/P3GL/KLHK/WIUP 2024) dan 100% akurat pada saat analisis dijalankan. Tugasmu HANYA menjelaskan dan memberi konteks atas data tersebut — BUKAN menyimpulkan ulang, menebak, atau mengoreksi status berdasarkan sinyal lain (misal nama WIUP, jarak, atau komoditas).
- JANGAN PERNAH menulis interpretasi yang bertentangan dengan field "Status area" yang diberikan. Jika "Status area: Ada overlap WIUP", interpretasi WAJIB menyatakan ada overlap — dilarang keras memakai frasa seperti "bebas dari WIUP", "tidak ada overlap", atau "status bersih" untuk kondisi ini.
- Jika "Status area: Bebas dari WIUP aktif", interpretasi WAJIB menyatakan area bebas — dilarang menyiratkan ada overlap.
- Sebelum menulis pillar_lic, ulangi dalam kepalamu: apa isi persis field "Status area" di atas? Interpretasimu harus konsisten kata demi kata dengan itu.

OUTPUT: Selalu kembalikan JSON valid dengan struktur persis seperti yang diminta. Tidak ada teks di luar JSON. Tidak ada markdown backtick di luar JSON.

ATURAN FORMAT JSON — WAJIB DIPATUHI, ini penyebab paling umum output jadi rusak:
- Di dalam SEMUA field teks (interpretasi, ringkasan, dll), JANGAN PERNAH pakai tanda kutip dua (") untuk mengutip istilah/nama — pakai tanda kutip tunggal (') saja. Tanda kutip dua di dalam string JSON yang tidak di-escape akan merusak seluruh struktur JSON.
- Jangan pakai karakter backslash (\\) di dalam teks kecuali benar-benar perlu.
- Pastikan setiap kalimat interpretasi selesai dengan wajar — jangan terputus di tengah kalimat.`;

// ─── Builder Prompt ────────────────────────────────────────────────────────────
function buildPrompt(d) {
  const radiusKm = d.radius ?? 10;
  return `Analisis lokasi tambang berikut dan kembalikan JSON interpretasi 5-pillar.

DATA LOKASI:
- Koordinat: ${d.lat.toFixed(6)}, ${d.lon.toFixed(6)}
- Wilayah: ${d.wilayah ?? "Tidak diketahui"}

PULSE SCORE 5-PILLAR:
1. Geological Potential: ${d.scores.geo}/100
2. Licence Status: ${d.scores.lic}/100
3. Forest Area Risk: ${d.scores.for}/100
4. Infrastructure: ${d.scores.inf}/100
5. Adjacent IUP Context: ${d.scores.iup}/100
Total Score: ${d.scores.total}/100

DATA GEOLOGI (dari ESDM/P3GL):
- Nama Formasi: ${d.formasi.nama ?? "Tidak teridentifikasi"}
- Kode Formasi: ${d.formasi.kode ?? "-"}
- Litologi: ${d.formasi.lithologi ?? "Tidak diketahui"}
- Jenis Batuan: ${d.formasi.jenis ?? "Tidak diketahui"}
- Komoditas Terkait: ${d.formasi.komoditas ?? "Tidak diketahui"}

DATA WIUP (radius pencarian ${radiusKm}km — CATATAN: ini radius pencarian kandidat, BUKAN jarak WIUP terdekat; jarak sebenarnya ada di field "Jarak WIUP terdekat" di bawah):
- Jumlah WIUP ditemukan dalam radius: ${d.wiup.jumlah ?? 0}
- Status area (GROUND TRUTH — jangan dikontradiksi): ${d.wiup.status ?? "Bebas (tidak ada WIUP overlap)"}
- WIUP terdekat: ${d.wiup.terdekat ?? "Tidak ada"}
- Jarak WIUP terdekat: ${d.wiup.jarak_terdekat_km != null ? d.wiup.jarak_terdekat_km + " km" : "Tidak ada data jarak"}
- Kegiatan terdekat: ${d.wiup.kegiatan ?? "-"}
- Komoditas WIUP: ${d.wiup.komoditas ?? "-"}

DATA KAWASAN HUTAN:
- Status: ${d.hutan.status ?? "APL"}
- Kategori: ${d.hutan.kategori ?? "Area Penggunaan Lain"}
- Risiko overlap: ${d.hutan.risiko ?? "Rendah"}

DATA INFRASTRUKTUR:
- Estimasi akses: ${d.infrastruktur ?? "Data infrastruktur belum tersedia"}

Kembalikan HANYA JSON berikut, tidak ada teks lain:
{
  "pillar_geo": {
    "label": "Geological Potential",
    "score": ${d.scores.geo},
    "status": "SATU KATA: Tinggi/Sedang/Rendah/Sangat Rendah",
    "interpretasi": "3-4 kalimat interpretasi geologi profesional dalam Bahasa Indonesia. Sebut nama formasi, litologi, jenis batuan, dan implikasi komoditas. Sertakan konteks Cekungan atau regional jika relevan."
  },
  "pillar_lic": {
    "label": "Licence Status",
    "score": ${d.scores.lic},
    "status": "SATU KATA: Bersih/Terbatas/Overlap/Kritis",
    "interpretasi": "3-4 kalimat tentang status WIUP dan perizinan, WAJIB konsisten dengan field 'Status area' di atas kata demi kata — jangan menyimpulkan status sendiri dari nama/jarak/komoditas WIUP. Jika status = ada overlap, jelaskan implikasi overlap tersebut (risiko sengketa klaim, perlu negosiasi/akuisisi). Jika status = bebas, jelaskan peluang pengajuan IUP baru. Sebut nama WIUP terdekat dan jaraknya sebagai konteks tambahan, bukan sebagai penentu status."
  },
  "pillar_for": {
    "label": "Forest Area Risk",
    "score": ${d.scores.for},
    "status": "SATU KATA: Aman/Monitor/Berisiko/Kritis",
    "interpretasi": "3-4 kalimat tentang status kawasan hutan, konsisten dengan field 'Status' dan 'Kategori' di atas. Sebut kategori hutan (HL/HK/HP/HPT/HPK/APL) dan implikasinya untuk perizinan tambang. Apakah perlu IPPKH? Apa konsekuensi hukumnya?"
  },
  "pillar_inf": {
    "label": "Infrastructure",
    "score": ${d.scores.inf},
    "status": "SATU KATA: Baik/Cukup/Terbatas/Kritis",
    "interpretasi": "3-4 kalimat tentang aksesibilitas dan infrastruktur. Estimasi jarak ke jalan utama, pelabuhan, atau fasilitas logistik. Implikasi capex infrastruktur untuk operasi tambang skala menengah."
  },
  "pillar_iup": {
    "label": "Adjacent IUP Context",
    "score": ${d.scores.iup},
    "status": "SATU KATA: Kuat/Sedang/Lemah/Tidak Ada",
    "interpretasi": "3-4 kalimat tentang konteks IUP yang berdekatan. Apakah formasi yang sama sudah terbukti produktif di IUP terdekat? Sebutkan nama perusahaan dan komoditas sebagai analog. Apa yang bisa dipelajari dari IUP tetangga?"
  },
  "ringkasan": "Satu paragraf (5-6 kalimat) ringkasan eksekutif yang mengintegrasikan semua 5 pillar. Mulai dengan potensi terkuat, sebutkan risiko utama, dan berikan rekomendasi next step yang spesifik (bukan generik). Gunakan bahasa profesional yang bisa dimengerti investor non-teknis. Ringkasan ini juga WAJIB konsisten dengan field 'Status area' WIUP — jangan menyebut area 'bersih'/'bebas' jika Status area menyatakan ada overlap.",
  "rekomendasi": "SATU dari tiga pilihan: PROCEED / MONITOR / AVOID — berdasarkan skor total dan kombinasi pillar. Tambahkan satu kalimat alasan singkat.",
  "generated_at": "${new Date().toISOString()}"
}`;
}

// ─── Helper CORS Headers ───────────────────────────────────────────────────────
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}
