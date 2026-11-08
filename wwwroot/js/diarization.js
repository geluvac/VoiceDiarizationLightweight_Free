/*
 * diarization.js - UI for VoiceDiarizationLightweight.
 * One audio source (microphone or file) feeds an AnalyserNode. Every animation
 * frame the full pipeline is computed; each of the 7 stages has its own
 * Start/Stop (live vs frozen) and a "Fingerprint zone" overlay.
 */
(function () {
    "use strict";
    const DSP = window.VDL_DSP;

    // ---------------------------------------------------------------- config
    const FFT_SIZE = 2048;
    const N_MEL = 26;
    const N_MFCC = 14;            // c0..c13; the fingerprint uses c1..c13
    const F_MIN = 80, F_MAX = 8000;
    const SPEC_MAX_HZ = 11000;
    const ENV_SECONDS = 6;
    const MIN_UTT_FRAMES = 20;          // ≈ 0.33 s of voiced frames at 60 fps; shorter = discarded
    const MIN_NEW_SPEAKER_FRAMES = 45;  // ≈ 0.75 s; shorter samples cannot create a new speaker
    const MAX_UTT_MS = 4000;      // long monologues are cut into several samples
    const TIMELINE_SECONDS = 60;
    const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];
    const ACCENT = "#f5b301", GRID = "#e5e7eb", AXIS = "#9ca3af", TEXT = "#374151";

    // ---------------------------------------------------------------- state
    const S = {
        mode: "mic", file: null,
        ctx: null, analyser: null, srcNode: null, stream: null, audioEl: null, active: false,
        sr: 48000, filters: null,
        timeData: new Float32Array(FFT_SIZE), freqDb: new Float32Array(FFT_SIZE / 2),
        power: new Float32Array(FFT_SIZE / 2), mel: new Float32Array(N_MEL), mfcc: new Float32Array(N_MFCC),
        env: [],
        running: {}, hl: {}, view: {},
        utt: { active: false, frames: [], sum: new Array(N_MFCC - 1).fill(0), t0: 0, lastVoiced: 0, silence: 0 },
        model: new DSP.SpeakerModel(),
        segments: [], sessionT0: null, lastTs: null,
        mfccScale: 1, fpScale: 0.6
    };

    const $ = sel => document.querySelector(sel);
    const stages = [...document.querySelectorAll(".stage")].map(el => ({
        el, n: +el.dataset.stage, canvas: el.querySelector("canvas"),
        start: el.querySelector("[data-act=start]"), stop: el.querySelector("[data-act=stop]"),
        hl: el.querySelector("[data-act=hl]"), state: el.querySelector(".stage-state")
    }));
    const stage = n => stages.find(s => s.n === n);
    const vadTh = () => +$("#vadTh").value;
    const gapMs = () => +$("#gapMs").value;
    const now = () => performance.now() / 1000 - (S.sessionT0 ?? 0);
    const speakerColor = id => COLORS[(id - 1) % COLORS.length];

    // ---------------------------------------------------------------- audio
    async function ensureAudio() {
        if (S.active) return true;
        try {
            if (!S.ctx) {
                S.ctx = new (window.AudioContext || window.webkitAudioContext)();
                S.analyser = S.ctx.createAnalyser();
                S.analyser.fftSize = FFT_SIZE;
                S.analyser.smoothingTimeConstant = 0;
                S.analyser.minDecibels = -100;
                S.analyser.maxDecibels = -10;
                S.sr = S.ctx.sampleRate;
                S.filters = DSP.createMelFilterbank(N_MEL, FFT_SIZE, S.sr, F_MIN, Math.min(F_MAX, S.sr / 2 - 1));
                $("#srState").textContent = (S.sr / 1000).toFixed(1) + " kHz";
            }
            if (S.ctx.state === "suspended") await S.ctx.resume();

            if (S.mode === "mic") {
                // AGC / noise suppression off: they would distort the spectral envelope.
                S.stream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
                });
                S.srcNode = S.ctx.createMediaStreamSource(S.stream);
                S.srcNode.connect(S.analyser);
                $("#srcState").textContent = "microphone";
            } else {
                S.audioEl = new Audio(URL.createObjectURL(S.file));
                S.srcNode = S.ctx.createMediaElementSource(S.audioEl);
                S.srcNode.connect(S.analyser);
                S.srcNode.connect(S.ctx.destination);
                S.audioEl.addEventListener("ended", () => { $("#srcState").textContent = "file ended"; stopAll(); });
                await S.audioEl.play();
                $("#srcState").textContent = "file: " + S.file.name;
            }
            if (S.sessionT0 === null) S.sessionT0 = performance.now() / 1000;
            S.active = true;
            return true;
        } catch (err) {
            console.error(err);
            $("#srcState").textContent = S.mode === "mic" ? "microphone blocked" : "file error";
            return false;
        }
    }

    function releaseAudio() {
        if (!S.active) return;
        if (S.utt.active) finalizeUtterance();
        if (S.srcNode) S.srcNode.disconnect();
        if (S.stream) S.stream.getTracks().forEach(t => t.stop());
        if (S.audioEl) S.audioEl.pause();
        S.srcNode = S.stream = S.audioEl = null;
        S.active = false;
        if (!$("#srcState").textContent.includes("ended")) $("#srcState").textContent = "off";
    }

    // ---------------------------------------------------------------- stage control
    async function startStage(n) {
        if (!(await ensureAudio())) return;
        S.running[n] = true;
        refreshStageUi();
    }

    function stopStage(n) {
        S.running[n] = false;
        // Stopping the fingerprint stage closes the current voice sample immediately.
        if (n === 5 && S.utt.active) finalizeUtterance();
        if (!Object.values(S.running).some(Boolean)) releaseAudio();
        refreshStageUi();
    }

    async function startAll() {
        if (!(await ensureAudio())) return;
        stages.forEach(s => S.running[s.n] = true);
        refreshStageUi();
    }

    function stopAll() {
        stages.forEach(s => S.running[s.n] = false);
        releaseAudio();
        refreshStageUi();
    }

    function refreshStageUi() {
        for (const s of stages) {
            const run = !!S.running[s.n];
            s.el.classList.toggle("is-running", run);
            s.start.disabled = run;
            s.stop.disabled = !run;
            s.state.textContent = run ? "● live" : (S.view[s.n] ? "frozen" : "idle");
        }
    }

    // ---------------------------------------------------------------- pipeline
    const utteranceStagesOn = () => S.running[5] || S.running[6] || S.running[7];

    function processFrame(dtMs) {
        const a = S.analyser;
        a.getFloatTimeDomainData(S.timeData);
        a.getFloatFrequencyData(S.freqDb);
        DSP.dbToPower(S.freqDb, S.power);
        DSP.melLogEnergies(S.power, S.filters, S.mel);
        DSP.dct(S.mel, N_MFCC, S.mfcc);

        const t = now();
        const r = DSP.rms(S.timeData);
        const [lo, hi] = DSP.minMax(S.timeData);
        const voiced = r > vadTh();
        S.env.push({ t, lo, hi, rms: r, voiced });
        while (S.env.length && S.env[0].t < t - ENV_SECONDS) S.env.shift();

        if (S.running[1]) S.view[1] = { env: S.env.slice(), now: t };
        if (S.running[2]) S.view[2] = { db: Float32Array.from(S.freqDb) };
        if (S.running[3]) S.view[3] = { mel: Array.from(S.mel) };
        if (S.running[4]) S.view[4] = { mfcc: Array.from(S.mfcc) };

        if (utteranceStagesOn()) trackUtterance(voiced, t, dtMs);

        if (S.running[5]) {
            const u = S.utt;
            const v = S.view[5] || {};
            v.collecting = u.active ? u.frames.length : 0;
            v.partial = u.active && u.frames.length ? DSP.l2normalize(u.sum) : null;
            S.view[5] = v;
        }
        if (S.running[7]) S.view[7] = { segments: S.segments.slice(), now: t, inProgress: S.utt.active ? S.utt.t0 : null };
    }

    function trackUtterance(voiced, t, dtMs) {
        const u = S.utt;
        if (voiced) {
            if (!u.active) { u.active = true; u.frames = []; u.sum.fill(0); u.t0 = t; }
            const c = DSP.lifter(Array.from(S.mfcc).slice(1));   // drop c0 (loudness), lifter c_k·k
            u.frames.push(c);
            for (let i = 0; i < c.length; i++) u.sum[i] += c[i];
            u.lastVoiced = t;
            u.silence = 0;
            if ((t - u.t0) * 1000 > MAX_UTT_MS) finalizeUtterance();
        } else if (u.active) {
            u.silence += dtMs;
            if (u.silence >= gapMs()) finalizeUtterance();
        }
    }

    function finalizeUtterance() {
        const u = S.utt;
        u.active = false;
        if (u.frames.length < MIN_UTT_FRAMES) return;
        const fp = DSP.fingerprint(u.frames);              // mean of raw vectors, then L2
        const res = S.model.classify(fp, { allowNew: u.frames.length >= MIN_NEW_SPEAKER_FRAMES });
        const seg = { t0: u.t0, t1: Math.max(u.lastVoiced, u.t0 + 0.05), speakerId: res.speakerId,
                      isNew: res.isNew, tentative: res.tentative, dMin: res.dMin, theta: res.theta, frames: u.frames.length };
        S.segments.push(seg);
        if (S.running[5]) {
            const spk = S.model.speakers.find(s => s.id === res.speakerId);
            S.view[5] = { ...(S.view[5] || {}), fp, speakerId: res.speakerId, frames: u.frames.length,
                          centroid: spk.centroid.slice(), centroids: S.model.speakers.map(s => s.centroid.slice()) };
        }
        if (S.running[6]) S.view[6] = { res };
        updateSpeakerChips();
    }

    function updateSpeakerChips() {
        const box = $("#speakerChips");
        box.innerHTML = "";
        for (const s of S.model.speakers) {
            const chip = document.createElement("span");
            chip.className = "speaker-chip";
            chip.style.background = speakerColor(s.id);
            chip.textContent = `S${s.id} · ${s.count} utt.`;
            box.appendChild(chip);
        }
        S.model.computeTheta();
        $("#thetaVal").textContent = S.model.thetaInfo.value.toFixed(2);
        $("#thetaSrc").textContent = S.model.thetaInfo.source;
    }

    // ---------------------------------------------------------------- drawing helpers
    function fit(canvas) {
        const r = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
        const g = canvas.getContext("2d");
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, r.width, r.height);
        return { g, w: r.width, h: r.height };
    }

    function label(g, txt, x, y, opts = {}) {
        g.font = `${opts.bold ? "600 " : ""}${opts.size || 11}px system-ui, sans-serif`;
        g.fillStyle = opts.color || TEXT;
        g.textAlign = opts.align || "left";
        g.textBaseline = opts.base || "alphabetic";
        g.fillText(txt, x, y);
    }

    function empty(g, w, h, msg = "Press ▶ Start and speak") {
        label(g, msg, w / 2, h / 2, { align: "center", base: "middle", color: AXIS, size: 13 });
    }

    function dashedLine(g, x1, y1, x2, y2, color, width = 1.5) {
        g.save();
        g.setLineDash([5, 4]);
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        g.restore();
    }

    let hatch = null;
    function hatchPattern(g, color = "rgba(0,0,0,0.35)") {
        if (!hatch) {
            const c = document.createElement("canvas");
            c.width = c.height = 8;
            const x = c.getContext("2d");
            x.strokeStyle = color; x.lineWidth = 1.5;
            x.beginPath(); x.moveTo(0, 8); x.lineTo(8, 0); x.stroke();
            hatch = c;
        }
        return g.createPattern(hatch, "repeat");
    }

    // ---------------------------------------------------------------- stage renderers
    function drawWave(cv, v, hl) {
        const { g, w, h } = fit(cv);
        if (!v) return empty(g, w, h);
        const L = 8, R = 8, T = 8;
        const waveH = (h - 30) * 0.68, rmsTop = T + waveH + 8, rmsH = h - 22 - rmsTop;
        const cy = T + waveH / 2;
        const x = t => L + (1 - (v.now - t) / ENV_SECONDS) * (w - L - R);
        const colW = Math.max(2, (w - L - R) / (ENV_SECONDS * 60) + 1);
        const rmsMax = Math.max(0.08, vadTh() * 2.5);
        const ry = r => rmsTop + rmsH - Math.min(r / rmsMax, 1) * rmsH;

        if (hl) {
            g.fillStyle = "rgba(22,163,74,0.18)";
            for (const e of v.env) if (e.voiced) g.fillRect(x(e.t) - colW / 2, T, colW, h - 22 - T);
        }
        g.strokeStyle = GRID; g.lineWidth = 1;
        g.beginPath(); g.moveTo(L, cy); g.lineTo(w - R, cy); g.stroke();

        g.strokeStyle = "#334155";
        g.beginPath();
        for (const e of v.env) {
            const xx = x(e.t);
            g.moveTo(xx, cy - Math.max(-1, Math.min(1, e.hi)) * waveH / 2);
            g.lineTo(xx, cy - Math.max(-1, Math.min(1, e.lo)) * waveH / 2 + 0.5);
        }
        g.stroke();

        g.fillStyle = hl ? "#64748b" : "#94a3b8";
        for (const e of v.env) {
            const yy = ry(e.rms);
            g.fillRect(x(e.t) - colW / 2, yy, colW, rmsTop + rmsH - yy);
        }
        const thY = ry(vadTh());
        dashedLine(g, L, thY, w - R, thY, hl ? "#ea580c" : "#fdba74", hl ? 2 : 1);
        label(g, "RMS", L + 2, rmsTop + 10, { color: AXIS, size: 10 });
        if (hl) label(g, "VAD θ", w - R - 2, thY - 3, { align: "right", color: "#ea580c", size: 10, bold: true });
        label(g, `−${ENV_SECONDS} s`, L, h - 6, { color: AXIS, size: 10 });
        label(g, "now", w - R, h - 6, { color: AXIS, size: 10, align: "right" });
    }

    function drawSpectrum(cv, v, hl) {
        const { g, w, h } = fit(cv);
        if (!v) return empty(g, w, h);
        const L = 34, R = 8, T = 8, B = 20, pw = w - L - R, ph = h - T - B;
        const binHz = S.sr / FFT_SIZE;
        const fx = f => L + (f / SPEC_MAX_HZ) * pw;
        const dy = db => T + (1 - (Math.max(-100, Math.min(-10, db)) + 100) / 90) * ph;

        if (hl) {
            g.fillStyle = "rgba(37,99,235,0.08)";
            g.fillRect(fx(F_MIN), T, fx(F_MAX) - fx(F_MIN), ph);
            g.fillStyle = "rgba(37,99,235,0.20)";
            g.fillRect(fx(300), T, fx(3400) - fx(300), ph);
            label(g, "formants F1–F3", fx(1850), T + 12, { align: "center", color: "#1d4ed8", size: 10, bold: true });
            label(g, "mel range 80–8000 Hz", fx(5700), T + 12, { align: "center", color: "#1d4ed8", size: 10 });
        }
        g.strokeStyle = GRID; g.lineWidth = 1;
        for (let db = -90; db <= -10; db += 20) { g.beginPath(); g.moveTo(L, dy(db)); g.lineTo(w - R, dy(db)); g.stroke(); label(g, db, L - 4, dy(db) + 3, { align: "right", color: AXIS, size: 9 }); }
        for (let f = 0; f <= 10000; f += 2000) label(g, f ? `${f / 1000}k` : "0 Hz", fx(f), h - 6, { align: "center", color: AXIS, size: 10 });

        g.strokeStyle = "#0f172a"; g.lineWidth = 1.2;
        g.beginPath();
        const nMax = Math.min(v.db.length, Math.floor(SPEC_MAX_HZ / binHz));
        for (let i = 1; i < nMax; i++) {
            const X = fx(i * binHz), Y = dy(v.db[i]);
            i === 1 ? g.moveTo(X, Y) : g.lineTo(X, Y);
        }
        g.stroke();
    }

    function drawMel(cv, v, hl) {
        const { g, w, h } = fit(cv);
        if (!v) return empty(g, w, h);
        const L = 8, R = 8, T = 10, B = 22, pw = w - L - R, ph = h - T - B;
        const top = Math.max(...v.mel), bottom = top - 16;
        const bw = pw / N_MEL;
        const relevant = m => S.filters[m].center >= 250 && S.filters[m].center <= 4000;

        for (let m = 0; m < N_MEL; m++) {
            const val = Math.max(0, (v.mel[m] - bottom) / (top - bottom));
            const bh = val * ph;
            g.fillStyle = hl ? (relevant(m) ? ACCENT : "#cbd5e1") : "#64748b";
            g.fillRect(L + m * bw + 1, T + ph - bh, bw - 2, bh);
        }
        if (hl) {
            g.strokeStyle = "rgba(29,78,216,0.55)"; g.lineWidth = 1;
            for (let m = 0; m < N_MEL; m++) {
                const cx = L + (m + 0.5) * bw;
                g.beginPath();
                g.moveTo(cx - bw, T + ph); g.lineTo(cx, T + ph * 0.55); g.lineTo(cx + bw, T + ph);
                g.stroke();
            }
            label(g, "formant filters 250–4000 Hz", w - R, T + 8, { align: "right", color: "#92400e", size: 10, bold: true });
        }
        for (const m of [0, 6, 12, 18, 25]) {
            const c = S.filters[m].center;
            label(g, c >= 1000 ? `${(c / 1000).toFixed(1)}k` : `${Math.round(c)}`, L + (m + 0.5) * bw, h - 7, { align: "center", color: AXIS, size: 10 });
        }
    }

    function drawMfcc(cv, v, hl) {
        const { g, w, h } = fit(cv);
        if (!v) return empty(g, w, h);
        const L = 8, R = 8, T = 14, B = 22, pw = w - L - R, ph = h - T - B, cy = T + ph / 2;
        const curMax = Math.max(...v.mfcc.slice(1).map(Math.abs), 1e-6);
        S.mfccScale = Math.max(curMax, S.mfccScale * 0.97);
        const bw = pw / N_MFCC;
        g.strokeStyle = GRID;
        g.beginPath(); g.moveTo(L, cy); g.lineTo(w - R, cy); g.stroke();

        for (let k = 0; k < N_MFCC; k++) {
            const x0 = L + k * bw + 2, bwi = bw - 4;
            let val = v.mfcc[k] / S.mfccScale, clipped = false;
            if (Math.abs(val) > 1) { val = Math.sign(val); clipped = true; }
            const bh = val * ph / 2;
            if (k === 0) {
                g.fillStyle = hl ? hatchPattern(g) : "#94a3b8";
                g.fillRect(x0, Math.min(cy, cy - bh), bwi, Math.abs(bh));
                if (hl) { g.strokeStyle = "#64748b"; g.strokeRect(x0, Math.min(cy, cy - bh), bwi, Math.abs(bh)); }
            } else {
                g.fillStyle = hl ? ACCENT : "#475569";
                g.fillRect(x0, Math.min(cy, cy - bh), bwi, Math.abs(bh));
            }
            if (clipped) label(g, val > 0 ? "▲" : "▼", x0 + bwi / 2, val > 0 ? T - 3 : h - B + 9, { align: "center", color: AXIS, size: 8 });
            label(g, `c${k}`, x0 + bwi / 2, h - 6, { align: "center", color: k === 0 && hl ? "#9ca3af" : AXIS, size: 10 });
        }
        if (hl) {
            label(g, "c₀ = loudness · excluded", L + 2, T - 3, { color: "#6b7280", size: 10, bold: true });
            const x1 = L + bw + 2, x2 = w - R - 2;
            g.strokeStyle = "#b45309"; g.lineWidth = 1.5;
            g.beginPath(); g.moveTo(x1, T + 2); g.lineTo(x1, T - 2); g.lineTo(x2, T - 2); g.lineTo(x2, T + 2); g.stroke();
            label(g, "voiceprint: c₁ … c₁₃", (x1 + x2) / 2 + 40, T - 5, { align: "center", color: "#b45309", size: 10, bold: true });
        }
    }

    function drawFingerprint(cv, v, hl) {
        const { g, w, h } = fit(cv);
        if (!v || (!v.fp && !v.partial)) return empty(g, w, h, v && v.collecting ? "Collecting voiced frames…" : "Press ▶ Start and speak a sentence");
        const L = 8, R = 8, T = 22, B = 22, pw = w - L - R, ph = h - T - B, cy = T + ph / 2;
        const D = N_MFCC - 1, bw = pw / D;
        const peak = Math.max(...[v.fp, v.partial, v.centroid].filter(Boolean).flatMap(a => a.map(Math.abs)), 0.3);
        S.fpScale = Math.max(peak, S.fpScale * 0.98);
        const scale = S.fpScale * 1.05;
        const yv = val => cy - Math.max(-1, Math.min(1, val / scale)) * ph / 2;

        if (hl && v.centroids && v.centroids.length >= 2) {
            const varPerDim = [];
            for (let i = 0; i < D; i++) {
                const vals = v.centroids.map(c => c[i]);
                const m = vals.reduce((a, b) => a + b, 0) / vals.length;
                varPerDim.push({ i, v: vals.reduce((a, b) => a + (b - m) ** 2, 0) });
            }
            varPerDim.sort((a, b) => b.v - a.v).slice(0, 4).forEach(({ i }) => {
                g.fillStyle = "rgba(245,179,1,0.22)";
                g.fillRect(L + i * bw, T, bw, ph);
            });
        }
        g.strokeStyle = GRID;
        g.beginPath(); g.moveTo(L, cy); g.lineTo(w - R, cy); g.stroke();

        if (v.fp) {
            g.fillStyle = speakerColor(v.speakerId);
            for (let i = 0; i < D; i++) {
                const y = yv(v.fp[i]);
                g.fillRect(L + i * bw + 3, Math.min(cy, y), bw - 6, Math.abs(cy - y));
            }
        }
        if (v.partial) {
            g.strokeStyle = "#111827"; g.lineWidth = 1; g.setLineDash([3, 3]);
            for (let i = 0; i < D; i++) {
                const y = yv(v.partial[i]);
                g.strokeRect(L + i * bw + 3, Math.min(cy, y), bw - 6, Math.abs(cy - y));
            }
            g.setLineDash([]);
        }
        if (hl && v.centroid) {
            g.fillStyle = "#111827";
            for (let i = 0; i < D; i++) {
                g.beginPath(); g.arc(L + (i + 0.5) * bw, yv(v.centroid[i]), 3.5, 0, Math.PI * 2); g.fill();
            }
        }
        for (let i = 0; i < D; i++) label(g, `${i + 1}`, L + (i + 0.5) * bw, h - 6, { align: "center", color: AXIS, size: 10 });

        const parts = [];
        if (v.fp) parts.push(`last sample → S${v.speakerId} (${v.frames} frames)`);
        if (v.collecting) parts.push(`collecting… ${v.collecting} frames`);
        label(g, parts.join("   ·   "), L, 13, { size: 11, bold: true, color: v.fp ? speakerColor(v.speakerId) : TEXT });
        if (hl && v.centroids && v.centroids.length < 2) label(g, "needs ≥ 2 speakers to rank dimensions", w - R, 13, { align: "right", color: AXIS, size: 10 });
    }

    function drawDecision(cv, v, hl) {
        const { g, w, h } = fit(cv);
        if (!v) return empty(g, w, h, "Waiting for the first finished utterance…");
        const r = v.res;
        const L = 40, R = 14, T = 26, B = 22, pw = w - L - R, ph = h - T - B;
        const DMAX = 1.6;
        const dx = d => L + Math.min(d, DMAX) / DMAX * pw;

        if (hl) {
            g.fillStyle = "rgba(22,163,74,0.15)";
            g.fillRect(L, T, dx(r.theta) - L, ph);
            label(g, "same-speaker zone", L + 4, T + ph - 4, { color: "#15803d", size: 10, bold: true });
        }
        for (let d = 0; d <= DMAX + 1e-9; d += 0.4) label(g, d.toFixed(1), dx(d), h - 6, { align: "center", color: AXIS, size: 10 });

        const rows = r.distances.length ? r.distances : [];
        const rowH = rows.length ? Math.min(26, ph / rows.length) : 0;
        rows.forEach((x, i) => {
            const y = T + i * rowH + 3;
            const win = !r.isNew && x.id === r.speakerId;
            g.fillStyle = speakerColor(x.id);
            g.globalAlpha = win || !hl ? 1 : 0.45;
            g.fillRect(L, y, dx(x.d) - L, rowH - 6);
            g.globalAlpha = 1;
            if (hl && win) { g.strokeStyle = "#111827"; g.lineWidth = 2; g.strokeRect(L, y, dx(x.d) - L, rowH - 6); }
            label(g, `S${x.id}`, L - 6, y + (rowH - 6) / 2 + 4, { align: "right", size: 11, bold: true, color: speakerColor(x.id) });
            label(g, x.d.toFixed(2), dx(x.d) + 4, y + (rowH - 6) / 2 + 4, { size: 10, color: TEXT });
        });
        dashedLine(g, dx(r.theta), T - 4, dx(r.theta), T + ph, "#111827", 1.5);
        label(g, `θ = ${r.theta.toFixed(2)}`, dx(r.theta) + 3, T - 6, { size: 10, bold: true });

        let msg;
        if (!r.distances.length) msg = `first voiceprint → speaker S${r.speakerId} created`;
        else if (r.isNew) msg = `d_min ${r.dMin.toFixed(2)} > θ ${r.theta.toFixed(2)} → NEW speaker S${r.speakerId}`;
        else if (r.tentative) msg = `short sample → nearest S${r.speakerId} (voiceprint not updated)`;
        else msg = `d_min ${r.dMin.toFixed(2)} ≤ θ ${r.theta.toFixed(2)} → speaker S${r.speakerId}`;
        label(g, msg, w - R, 13, { align: "right", size: 11, bold: true, color: speakerColor(r.speakerId) });
    }

    function drawTimeline(cv, v, hl) {
        const { g, w, h } = fit(cv);
        if (!v) return empty(g, w, h);
        const L = 40, R = 10, T = 8, B = 20, pw = w - L - R, ph = h - T - B;
        const t1 = Math.max(v.now, TIMELINE_SECONDS), t0 = t1 - TIMELINE_SECONDS;
        const tx = t => L + (t - t0) / TIMELINE_SECONDS * pw;
        const nLanes = Math.max(1, S.model.speakers.length);
        const laneH = ph / nLanes;

        for (let i = 0; i < nLanes; i++) {
            g.fillStyle = i % 2 ? "#f3f4f6" : "#fafbfc";
            g.fillRect(L, T + i * laneH, pw, laneH);
            if (S.model.speakers[i]) label(g, `S${i + 1}`, L - 8, T + i * laneH + laneH / 2 + 4, { align: "right", bold: true, color: speakerColor(i + 1) });
        }
        for (let t = Math.ceil(t0 / 10) * 10; t <= t1; t += 10) {
            g.strokeStyle = GRID; g.beginPath(); g.moveTo(tx(t), T); g.lineTo(tx(t), T + ph); g.stroke();
            label(g, `${t}s`, tx(t), h - 6, { align: "center", color: AXIS, size: 10 });
        }
        for (const s of v.segments) {
            if (s.t1 < t0) continue;
            const y = T + (s.speakerId - 1) * laneH + 3;
            const x0 = Math.max(L, tx(s.t0)), x1 = tx(s.t1);
            g.fillStyle = speakerColor(s.speakerId);
            g.globalAlpha = s.tentative ? 0.4 : 1;
            g.fillRect(x0, y, Math.max(2, x1 - x0), laneH - 6);
            g.globalAlpha = 1;
            if (hl && !s.isNew && s.dMin !== null && s.dMin > 0.8 * s.theta) {
                g.fillStyle = hatchPattern(g);
                g.fillRect(x0, y, Math.max(2, x1 - x0), laneH - 6);
            }
            if (hl && s.isNew) label(g, "★", x0, y + laneH / 2 + 2, { align: "center", color: "#111827", size: 15 });
        }
        if (v.inProgress !== null && v.inProgress !== undefined) {
            g.fillStyle = "rgba(17,24,39,0.25)";
            g.fillRect(Math.max(L, tx(v.inProgress)), T, Math.max(2, tx(v.now) - tx(v.inProgress)), 4);
        }
        if (!S.model.speakers.length) label(g, "No utterances yet", L + pw / 2, T + ph / 2, { align: "center", color: AXIS, size: 12 });
    }

    const renderers = { 1: drawWave, 2: drawSpectrum, 3: drawMel, 4: drawMfcc, 5: drawFingerprint, 6: drawDecision, 7: drawTimeline };

    // ---------------------------------------------------------------- main loop
    function loop(ts) {
        const dt = S.lastTs === null ? 16 : ts - S.lastTs;
        S.lastTs = ts;
        if (S.active && S.analyser && S.filters) processFrame(dt);
        for (const s of stages) renderers[s.n](s.canvas, S.view[s.n], !!S.hl[s.n]);
        requestAnimationFrame(loop);
    }

    // ---------------------------------------------------------------- wiring
    for (const s of stages) {
        s.start.addEventListener("click", () => startStage(s.n));
        s.stop.addEventListener("click", () => stopStage(s.n));
        s.hl.addEventListener("click", () => {
            S.hl[s.n] = !S.hl[s.n];
            s.hl.classList.toggle("active", S.hl[s.n]);
            s.el.classList.toggle("show-hl", S.hl[s.n]);
        });
    }
    $("#btnStartAll").addEventListener("click", startAll);
    $("#btnStopAll").addEventListener("click", stopAll);
    $("#btnReset").addEventListener("click", () => {
        S.model.reset();
        S.segments = [];
        S.view[5] = S.view[6] = null;
        if (S.view[7]) S.view[7] = { segments: [], now: now(), inProgress: null };
        updateSpeakerChips();
        refreshStageUi();
    });
    $("#vadTh").addEventListener("input", e => $("#vadThVal").textContent = (+e.target.value).toFixed(3));
    $("#gapMs").addEventListener("input", e => $("#gapMsVal").textContent = `${e.target.value} ms`);
    $("#fileInput").addEventListener("change", async e => {
        const f = e.target.files[0];
        if (!f) return;
        stopAll();
        S.mode = "file"; S.file = f;
        $("#btnUseMic").classList.remove("d-none");
        e.target.value = "";
        await startAll();
    });
    $("#btnUseMic").addEventListener("click", () => {
        stopAll();
        S.mode = "mic"; S.file = null;
        $("#btnUseMic").classList.add("d-none");
    });

    // exposed for automated tests / debugging in the console
    window.VDL_STATE = S;

    refreshStageUi();
    requestAnimationFrame(loop);
})();
