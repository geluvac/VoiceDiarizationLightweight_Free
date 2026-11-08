/*
 * dsp.js - signal processing for lightweight speaker diarization.
 * Pure functions plus the nearest-centroid speaker model, no DOM access,
 * so the same file runs in the browser (window.VDL_DSP) and in Node (tests).
 *
 * Pipeline: FFT power spectrum -> mel filterbank -> log -> DCT (MFCC)
 *           -> mean of raw c1..c13 over voiced frames -> L2 normalisation
 *           -> nearest-centroid with adaptive threshold.
 */
(function (root) {
    "use strict";

    const hzToMel = f => 2595 * Math.log10(1 + f / 700);
    const melToHz = m => 700 * (Math.pow(10, m / 2595) - 1);

    /**
     * Triangular filters spaced uniformly on the mel scale.
     * Weights are evaluated at the centre frequency of each FFT bin.
     */
    function createMelFilterbank(nFilters, fftSize, sampleRate, fMin, fMax) {
        const nBins = fftSize / 2;
        const binHz = sampleRate / fftSize;
        const melMin = hzToMel(fMin), melMax = hzToMel(fMax);
        const points = [];
        for (let i = 0; i < nFilters + 2; i++) {
            points.push(melToHz(melMin + (melMax - melMin) * i / (nFilters + 1)));
        }
        const filters = [];
        for (let m = 0; m < nFilters; m++) {
            const lo = points[m], c = points[m + 1], hi = points[m + 2];
            const startBin = Math.max(0, Math.floor(lo / binHz));
            const endBin = Math.min(nBins - 1, Math.ceil(hi / binHz));
            const weights = [];
            for (let b = startBin; b <= endBin; b++) {
                const f = b * binHz;
                let w = 0;
                if (f > lo && f <= c) w = (f - lo) / (c - lo);
                else if (f > c && f < hi) w = (hi - f) / (hi - c);
                weights.push(w);
            }
            filters.push({ lo, center: c, hi, startBin, weights });
        }
        return filters;
    }

    /** dB values from AnalyserNode.getFloatFrequencyData -> linear power. */
    function dbToPower(dbArray, out) {
        for (let i = 0; i < dbArray.length; i++) {
            const db = Number.isFinite(dbArray[i]) ? dbArray[i] : -160;
            out[i] = Math.pow(10, db / 10);
        }
        return out;
    }

    /** Natural-log energy of each mel filter. */
    function melLogEnergies(power, filters, out) {
        for (let m = 0; m < filters.length; m++) {
            const f = filters[m];
            let e = 0;
            for (let k = 0; k < f.weights.length; k++) e += f.weights[k] * power[f.startBin + k];
            out[m] = Math.log(Math.max(e, 1e-12));
        }
        return out;
    }

    /** DCT-II: c_k = sum_n logE_n * cos(pi/M * (n + 0.5) * k), k = 0..nCoeffs-1. */
    function dct(logE, nCoeffs, out) {
        const M = logE.length;
        for (let k = 0; k < nCoeffs; k++) {
            let s = 0;
            for (let n = 0; n < M; n++) s += logE[n] * Math.cos(Math.PI / M * (n + 0.5) * k);
            out[k] = s;
        }
        return out;
    }

    function rms(timeData) {
        let s = 0;
        for (let i = 0; i < timeData.length; i++) s += timeData[i] * timeData[i];
        return Math.sqrt(s / timeData.length);
    }

    function minMax(timeData) {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < timeData.length; i++) {
            const v = timeData[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        return [lo, hi];
    }

    function norm(v) {
        let s = 0;
        for (let i = 0; i < v.length; i++) s += v[i] * v[i];
        return Math.sqrt(s);
    }

    function l2normalize(v) {
        const n = norm(v) || 1;
        return Array.from(v, x => x / n);
    }

    function meanVector(vectors) {
        const d = vectors[0].length;
        const m = new Array(d).fill(0);
        for (const v of vectors) for (let i = 0; i < d; i++) m[i] += v[i];
        for (let i = 0; i < d; i++) m[i] /= vectors.length;
        return m;
    }

    function euclid(a, b) {
        let s = 0;
        for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
        return Math.sqrt(s);
    }

    /**
     * Cepstral liftering c_k -> k * c_k (k = 1..13). Without it c1 (spectral tilt)
     * dominates the vector and the finer vocal-tract detail in c4..c13 is lost after
     * L2 normalisation. Linear per frame, so "average first, then normalise" still holds.
     */
    function lifter(c1to13) {
        return Array.from(c1to13, (v, i) => v * (i + 1));
    }

    /** Fingerprint of an utterance: average the RAW vectors, then normalise. */
    function fingerprint(frames) {
        return l2normalize(meanVector(frames));
    }

    /**
     * Nearest-centroid speaker model with the adaptive threshold from the article:
     *   θ0 = 0.7 before calibration (0.5 in the article; the liftered space is wider),
     *   θ  = d_inter / 2 once two speakers exist (closest pair of centroids),
     *   θ  = max(3·σ_intra, 0.15) once a speaker has K0 = 5 utterances.
     * When both calibrations are available the smaller value is used, and θ is
     * capped at thetaMax, so the threshold never swallows a second speaker.
     */
    class SpeakerModel {
        constructor(opts = {}) {
            this.theta0 = opts.theta0 ?? 0.7;
            this.thetaMax = opts.thetaMax ?? 0.8;
            this.K = opts.K ?? 10;        // fingerprints kept per centroid
            this.K0 = opts.K0 ?? 5;       // utterances before intra-calibration
            this.maxSpeakers = opts.maxSpeakers ?? 6;
            this.reset();
        }

        reset() {
            this.speakers = [];
            this.thetaInfo = { value: this.theta0, source: "initial θ₀" };
        }

        _createSpeaker(fp) {
            const s = { id: this.speakers.length + 1, fps: [fp], centroid: fp.slice(), count: 1 };
            this.speakers.push(s);
            return s;
        }

        _update(s, fp) {
            s.fps.push(fp);
            if (s.fps.length > this.K) s.fps.shift();
            s.centroid = fingerprint(s.fps);   // re-normalised mean of the last K fingerprints
            s.count++;
        }

        computeTheta() {
            let inter = null, intra = null;
            if (this.speakers.length >= 2) {
                let dMin = Infinity;
                for (let i = 0; i < this.speakers.length; i++)
                    for (let j = i + 1; j < this.speakers.length; j++)
                        dMin = Math.min(dMin, euclid(this.speakers[i].centroid, this.speakers[j].centroid));
                inter = dMin / 2;
            }
            const sigmas = this.speakers
                .filter(s => s.fps.length >= this.K0)
                .map(s => s.fps.reduce((a, fp) => a + euclid(fp, s.centroid), 0) / s.fps.length);
            if (sigmas.length) {
                const sigma = sigmas.reduce((a, b) => a + b, 0) / sigmas.length;
                intra = Math.max(3 * sigma, 0.15);
            }
            if (inter !== null && intra !== null) {
                this.thetaInfo = intra <= inter
                    ? { value: intra, source: "max(3σ_intra, 0.15)" }
                    : { value: inter, source: "d_inter / 2" };
            } else if (intra !== null) {
                this.thetaInfo = { value: intra, source: "max(3σ_intra, 0.15)" };
            } else if (inter !== null) {
                this.thetaInfo = { value: inter, source: "d_inter / 2" };
            } else {
                this.thetaInfo = { value: this.theta0, source: "initial θ₀" };
            }
            if (this.thetaInfo.value > this.thetaMax) {
                this.thetaInfo = { value: this.thetaMax, source: "cap θ_max" };
            }
            return this.thetaInfo.value;
        }

        /**
         * Returns the decision plus everything the UI needs to explain it.
         * allowNew = false (short samples): never creates a speaker; the sample is
         * assigned to the nearest centroid without updating it (tentative).
         */
        classify(fp, opts = {}) {
            const allowNew = opts.allowNew ?? true;
            const theta = this.computeTheta();
            const distances = this.speakers.map(s => ({ id: s.id, d: euclid(fp, s.centroid) }));
            let best = null;
            for (const x of distances) if (!best || x.d < best.d) best = x;

            let speaker, isNew = false, tentative = false;
            if (!best || (best.d > theta && allowNew && this.speakers.length < this.maxSpeakers)) {
                speaker = this._createSpeaker(fp);
                isNew = true;
            } else if (!allowNew) {
                speaker = this.speakers.find(s => s.id === best.id);
                tentative = true;
            } else {
                speaker = this.speakers.find(s => s.id === best.id);
                this._update(speaker, fp);
            }
            const thetaAfter = this.computeTheta();
            return {
                speakerId: speaker.id, isNew, tentative, distances, theta,
                thetaAfter, dMin: best ? best.d : null, fp
            };
        }
    }

    const api = {
        hzToMel, melToHz, createMelFilterbank, dbToPower, melLogEnergies, dct,
        rms, minMax, norm, l2normalize, meanVector, euclid, lifter, fingerprint, SpeakerModel
    };

    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.VDL_DSP = api;
})(typeof window !== "undefined" ? window : globalThis);
