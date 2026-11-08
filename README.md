# VoiceDiarizationLightweight - FREE - for [IT DAYS 2026](https://itdays.ro/)

**English** | [Română](README.ro.md)

An ASP.NET Core (MVC, .NET 8) app that shows, on a single screen, every stage of speaker identification from the article *Real-Time Speaker Diarization*:

| # | Stage | What the **◎ Fingerprint zone** button shows |
|---|-------|-----------------------------------------------|
| 1 | Waveform & voice activity | frames with RMS > the VAD threshold (green), the only ones that enter the fingerprint |
| 2 | FFT power spectrum | the 80–8,000 Hz band read by the mel filters and the 300–3,400 Hz formant zone |
| 3 | Mel filterbank (26 filters) | filters centred between 250 and 4,000 Hz and the triangular shape of the filters |
| 4 | MFCC c₀…c₁₃ | c₁–c₁₃ = the fingerprint; c₀ (loudness) is excluded |
| 5 | L2 fingerprint of the sample | the centroid of the matched speaker and the 4 dimensions that differ most between speakers |
| 6 | Nearest-centroid decision | the acceptance zone [0, θ] and the winning speaker |
| 7 | "Who spoke when" timeline | ★ = new speaker created; hatched = borderline decision; faded = short sample |

Each chart has its own **▶ Start / ■ Stop**. Start runs the chart live; Stop freezes it on the last sample. On stage 5, Stop immediately closes the current voice sample and classifies it. When no chart is running, the microphone is released.

All processing happens in the browser (Web Audio API). No audio is ever sent to the server.

## Running it

You need the .NET 8 SDK and Chrome or Edge.

```bash
cd VoiceDiarizationLightweight_Free
dotnet run --launch-profile https
```

Open https://localhost:7241 and allow microphone access. The microphone only works over HTTPS or on localhost. If the browser does not trust the development certificate, run `dotnet dev-certs https --trust` once.

From Visual Studio: open `VoiceDiarizationLightweightFree.csproj` and press F5.

## Usage

- **Start all / Stop all** start or stop every stage at once.
- **Reset speakers** clears the speakers and the timeline.
- **Audio file** analyzes a file instead of the microphone, and plays it through the speakers. `samples/` contains two test conversations:
  - `conv_male_female.wav`: one male and one female voice
  - `conv_two_males.wav`: two male voices, the hard case

  The files are also useful as a backup for a live demo.
- **VAD threshold** should be tuned to the room noise. The orange line in chart 1 should sit above the background noise and below speech.
- **Silence gap** is the pause after which a sample is considered finished.

For best results, speak in phrases of at least one second. Each speaker's first phrase creates their fingerprint.

## Pipeline and parameters

```
2048 samples (≈ 46 ms) → FFT (AnalyserNode, no smoothing)
→ 26 mel filters 80–8000 Hz → log → DCT → c0…c13
→ drop c0 → liftering k·c_k → mean of the sample's raw vectors → L2 normalization
→ nearest-centroid (centroid = L2 mean of the last 10 fingerprints)
```

The threshold θ:
- starts at θ₀ = 0.7;
- becomes d_inter / 2 once two speakers exist;
- becomes max(3σ_intra, 0.15) after 5 samples from the same speaker.

When both values are available, the smaller one is used. In all cases θ ≤ 0.8.

A few differences from the article, chosen after testing:

1. **Liftering k·c_k.** Without it, c₁ (the spectral tilt) dominates the vector. On two male voices, the minimum distance between speakers was 0.38 and the maximum distance within the same speaker was 0.44, so the ranges overlapped. With liftering, the distance between speakers starts at 0.93.
2. **θ₀ = 0.7 instead of 0.5**, because the liftered space is wider.
3. **Cap θ ≤ 0.8.** Without it, 3σ_intra reached 0.88 and the threshold "swallowed" the second speaker.
4. **Short samples** (under 0.75 s, e.g. the tail of a phrase cut at 4 s) cannot create a new speaker. They are assigned to the nearest speaker without changing that speaker's fingerprint.

Parameters are set in `wwwroot/js/diarization.js` (the constants at the top) and in `SpeakerModel` in `wwwroot/js/dsp.js`.

## Testing

The app was tested in headless Chrome with a simulated microphone, on the two conversations in `samples/`, for 75 seconds (the file plays almost twice):

- male + female: 2 speakers, 22 segments, all assigned correctly;
- two males: 2 speakers, 20 segments, all assigned correctly.

Also verified: Start/Stop on every stage, microphone release, file mode and reset.

`dsp.js` does not use the DOM, so it can also be tested in Node: `require("./wwwroot/js/dsp.js")`.

## Structure

```
Program.cs                    minimal ASP.NET pipeline + Permissions-Policy: microphone=(self)
Controllers/HomeController.cs
Views/Home/Index.cshtml       the 7 stages
wwwroot/js/dsp.js             mel, MFCC, liftering, L2, SpeakerModel (no DOM)
wwwroot/js/diarization.js     audio, processing loop, canvas charts, buttons
wwwroot/css/site.css
wwwroot/lib/bootstrap/        local Bootstrap 5.3.3 (works offline)
samples/                      test conversations
```
