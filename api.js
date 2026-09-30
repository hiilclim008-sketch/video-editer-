/* ==========================================================================
   api.js: every network call to your local Python backend (via Ngrok).

   1. Paste your Ngrok URL into BACKEND_URL below.
   2. Leave it as "YOUR_NGROK_URL_HERE" to run the whole UI in demo mode
      (simulated progress, sample footage, no backend needed).

   Endpoint contract your Python server should implement
   -----------------------------------------------------
   GET  /api/health
        -> { "ok": true }

   POST /api/video/info            { url }
        -> { title, thumbnail, duration, channel }

   POST /api/video/upload          multipart/form-data, field "file"
        -> { video_id }

   POST /api/clips/generate        { source_type: "youtube"|"upload", url, video_id,
                                     aspect_ratio: "9:16"|"1:1"|"16:9",
                                     clip_duration: 15|30|60, count: 1|3|5|"auto" }
        -> { job_id }

   POST /api/clips/{clip_id}/tools/{tool}   { ...params }
        tool = dubbing | voice | captions | broll | sfx | studio | thumbnail
        -> { job_id }

   POST /api/clips/{clip_id}/export         { quality: "720p"|"1080p"|"4k",
                                              effects, include_thumbnail, aspect_ratio }
        -> { job_id }

   GET  /api/jobs/{job_id}
        -> { status: "queued"|"processing"|"done"|"error",
             progress: 0-100, stage?: "text shown under the percentage",
             error?: "message", result?: {...} }

   Job results
   - generate: { clips: [{ id, title, reason, viral_score, start, end,
                           video_url, thumbnail_url, words? }] }
       start/end are seconds inside video_url. If video_url is already the
       trimmed clip, send start: 0 and end: <clip length>.
   - tools:    { video_url?, duration?, thumbnail_url?,
                 words?: [{ start, end, text }]      (seconds from clip start)
                 broll?: [{ start, end, label }]
                 sfx?:   [{ t, e, label }] }         (e = emoji shown in the player)
   - export:   { video_url, thumbnail_url }

   CORS: enable it on the backend and allow the header
   "ngrok-skip-browser-warning" (FastAPI: CORSMiddleware with allow_headers=["*"]).
   ========================================================================== */

const BACKEND_URL = "your_backend_url";

// Sample footage used for the clips while in demo mode.
const DEMO_VIDEO_URL =
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

const ClipApi = (() => {
  "use strict";

  const isDemo = () => !BACKEND_URL || BACKEND_URL.includes("YOUR_NGROK_URL_HERE");
  const base = () => BACKEND_URL.replace(/\/+$/, "");

  class ApiError extends Error {
    constructor(message) { super(message); this.name = "ApiError"; }
  }
  class CancelError extends Error {
    constructor() { super("Cancelled"); this.name = "CancelError"; }
  }

  const abs = (url) => {
    if (!url) return "";
    return /^(https?:|blob:|data:)/i.test(url) ? url : base() + (url.startsWith("/") ? "" : "/") + url;
  };

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new CancelError());
      const id = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(id); reject(new CancelError()); }, { once: true });
    });

  /* ---------- low-level request ---------- */
  async function request(path, { method = "GET", json, body, signal } = {}) {
    const headers = { "ngrok-skip-browser-warning": "true" };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(base() + path, {
        method,
        headers,
        body: json !== undefined ? JSON.stringify(json) : body,
        signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw new CancelError();
      throw new ApiError("Can't reach the backend. Check that your Python server and Ngrok tunnel are running.");
    }
    if (!res.ok) {
      let detail = "";
      try { const d = await res.json(); detail = d.detail || d.error || ""; } catch (_) { /* not json */ }
      throw new ApiError(typeof detail === "string" && detail ? detail : `The backend returned an error (${res.status}).`);
    }
    return res.json();
  }

  /* ---------- jobs ---------- */
  async function pollJob(jobId, onProgress, signal, intervalMs = 900) {
    for (;;) {
      const job = await request(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
      if (typeof job.progress === "number") onProgress?.(job.progress, job.stage);
      if (job.status === "done") { onProgress?.(100, job.stage); return job.result || {}; }
      if (job.status === "error") throw new ApiError(job.error || "The job failed on the backend.");
      await sleep(intervalMs, signal);
    }
  }

  // Demo mode: eased 0-100% over `ms` milliseconds.
  async function simulate(onProgress, ms, signal) {
    const start = performance.now();
    for (;;) {
      await sleep(110, signal);
      const t = Math.min(1, (performance.now() - start) / ms);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      onProgress?.(Math.round(eased * 100));
      if (t >= 1) break;
    }
  }

  async function runJob(path, payload, onProgress, signal) {
    const { job_id } = await request(path, { method: "POST", json: payload, signal });
    if (!job_id) throw new ApiError("The backend didn't return a job id.");
    return pollJob(job_id, onProgress, signal);
  }

  /* ---------- health ---------- */
  async function checkHealth() {
    if (isDemo()) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try { await request("/api/health", { signal: ctrl.signal }); return true; }
    catch (_) { return false; }
    finally { clearTimeout(timer); }
  }

  /* ---------- source video ---------- */
  async function getVideoInfo(url) {
    if (!isDemo()) return request("/api/video/info", { method: "POST", json: { url } });
    // Demo mode: YouTube's public oEmbed gives us a real title.
    try {
      const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url));
      if (r.ok) {
        const d = await r.json();
        return { title: d.title, channel: d.author_name, thumbnail: d.thumbnail_url };
      }
    } catch (_) { /* offline or blocked: fall back to defaults */ }
    return {};
  }

  function uploadVideo(file, onProgress, signal) {
    if (isDemo()) return Promise.resolve({ video_id: "demo-upload" });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", base() + "/api/video/upload");
      xhr.setRequestHeader("ngrok-skip-browser-warning", "true");
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (_) { reject(new ApiError("The backend sent an unexpected reply to the upload.")); }
        } else reject(new ApiError(`Upload failed (${xhr.status}).`));
      };
      xhr.onerror = () => reject(new ApiError("Upload failed. Is the backend running?"));
      xhr.onabort = () => reject(new CancelError());
      signal?.addEventListener("abort", () => xhr.abort(), { once: true });
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  }

  /* ---------- clips ---------- */
  function normalizeClip(c, i = 0) {
    const start = Number(c.start ?? 0);
    const end = Number(c.end ?? start + Number(c.duration || 30));
    return {
      id: String(c.id ?? `clip_${i + 1}`),
      title: c.title || `Clip ${i + 1}`,
      reason: c.reason || "",
      viralScore: Math.round(Number(c.viral_score ?? c.viralScore ?? 80)),
      start,
      end,
      videoUrl: abs(c.video_url ?? c.videoUrl),
      thumbnailUrl: abs(c.thumbnail_url ?? ""),
    };
  }

  const MOCK_TITLES = [
    "The mistake nobody warns you about",
    "Why the first year feels impossible",
    "The one habit that changed everything",
    "What I'd do differently, starting today",
    "The honest truth about overnight success",
    "Stop waiting for the perfect moment",
  ];
  const MOCK_REASONS = [
    "Bold claim in the first three seconds",
    "Emotional story with a clear payoff",
    "Contrarian take that invites comments",
    "Concrete, quotable advice",
    "Strong pacing and a laugh at the end",
    "Tension builds, then resolves cleanly",
  ];

  function mockClips({ source, clipDuration, count }) {
    const n = count === "auto" ? 6 : Math.min(6, Number(count));
    const total = Math.max(Number(source.duration) || 596, clipDuration * n + 10);
    const slot = (total - clipDuration) / n;
    const scores = Array.from({ length: n }, () => 72 + Math.floor(Math.random() * 27)).sort((a, b) => b - a);
    return scores.map((score, i) => {
      const start = Math.floor(slot * i + Math.random() * Math.max(1, slot * 0.6));
      return normalizeClip({
        id: `demo_${Date.now()}_${i}`,
        title: MOCK_TITLES[i % MOCK_TITLES.length],
        reason: MOCK_REASONS[i % MOCK_REASONS.length],
        viral_score: score,
        start,
        end: Math.min(total, start + clipDuration),
        video_url: source.playbackUrl || DEMO_VIDEO_URL,
      }, i);
    });
  }

  async function generateClips(params, onProgress, signal) {
    const { source, videoId, aspectRatio, clipDuration, count } = params;
    if (isDemo()) {
      await simulate(onProgress, 5200, signal);
      return mockClips({ source, clipDuration, count });
    }
    const result = await runJob("/api/clips/generate", {
      source_type: source.type,
      url: source.url || null,
      video_id: videoId || null,
      aspect_ratio: aspectRatio,
      clip_duration: clipDuration,
      count,
    }, onProgress, signal);
    return (result.clips || []).map(normalizeClip);
  }

  /* ---------- pro tools ---------- */
  const DEMO_TOOL_MS = { dubbing: 5600, voice: 3400, captions: 4400, broll: 5800, sfx: 3200, studio: 4000, thumbnail: 3600 };

  function normalizeToolResult(r = {}) {
    return {
      videoUrl: r.video_url ? abs(r.video_url) : null,
      duration: typeof r.duration === "number" ? r.duration : null,
      thumbnailUrl: r.thumbnail_url ? abs(r.thumbnail_url) : null,
      words: Array.isArray(r.words) ? r.words : null,
      broll: Array.isArray(r.broll) ? r.broll : null,
      sfx: Array.isArray(r.sfx) ? r.sfx : null,
    };
  }

  async function applyTool(clipId, tool, params, onProgress, signal) {
    if (isDemo()) {
      await simulate(onProgress, DEMO_TOOL_MS[tool] || 4000, signal);
      return normalizeToolResult();
    }
    const result = await runJob(
      `/api/clips/${encodeURIComponent(clipId)}/tools/${encodeURIComponent(tool)}`,
      params, onProgress, signal
    );
    return normalizeToolResult(result);
  }

  /* ---------- export ---------- */
  async function exportClip(clipId, options, onProgress, signal) {
    if (isDemo()) {
      await simulate(onProgress, 6000, signal);
      return normalizeToolResult();
    }
    const result = await runJob(`/api/clips/${encodeURIComponent(clipId)}/export`, {
      quality: options.quality,
      effects: options.effects,
      include_thumbnail: options.includeThumbnail,
      aspect_ratio: options.aspectRatio,
    }, onProgress, signal);
    return normalizeToolResult(result);
  }

  // Saves a file to disk. Fetches remote files as blobs so the Ngrok header is sent.
  async function downloadFile(url, filename) {
    const a = document.createElement("a");
    a.download = filename;
    if (/^(data|blob):/i.test(url)) {
      a.href = url;
    } else {
      try {
        const res = await fetch(url, { headers: { "ngrok-skip-browser-warning": "true" } });
        if (!res.ok) throw new Error("bad status");
        a.href = URL.createObjectURL(await res.blob());
        const objectUrl = a.href;
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      } catch (_) {
        window.open(url, "_blank", "noopener");
        return;
      }
    }
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return {
    isDemo, checkHealth, getVideoInfo, uploadVideo, generateClips,
    applyTool, exportClip, downloadFile, ApiError, CancelError, DEMO_VIDEO_URL,
  };
})();
