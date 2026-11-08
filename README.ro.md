# VoiceDiarizationLightweight - FREE

[English](README.md) | **Română**

Aplicație ASP.NET Core (MVC, .NET 8) care arată, pe un singur ecran, toate etapele identificării vorbitorului din articolul *Real-Time Speaker Diarization*:

| # | Etapă | Ce arată butonul **◎ Fingerprint zone** |
|---|-------|------------------------------------------|
| 1 | Waveform & voice activity | cadrele cu RMS > pragul VAD (verde), adică singurele care intră în amprentă |
| 2 | FFT power spectrum | banda 80–8.000 Hz citită de filtrele mel și zona formanților 300–3.400 Hz |
| 3 | Mel filterbank (26 de filtre) | filtrele cu centrul între 250 și 4.000 Hz și forma triunghiulară a filtrelor |
| 4 | MFCC c₀…c₁₃ | c₁–c₁₃ = amprenta; c₀ (volumul) e exclus |
| 5 | Amprenta L2 a mostrei | centroidul vorbitorului găsit și cele 4 dimensiuni care diferă cel mai mult între vorbitori |
| 6 | Decizia nearest-centroid | zona de acceptare [0, θ] și vorbitorul câștigător |
| 7 | Timeline „cine a vorbit când” | ★ = vorbitor nou creat; hașurat = decizie la limită; estompat = mostră scurtă |

Fiecare grafic are **▶ Start / ■ Stop** propriu. Start pornește graficul live, iar Stop îl îngheață pe ultima mostră. La etapa 5, Stop închide imediat mostra de voce curentă și o clasifică. Când niciun grafic nu mai rulează, microfonul se eliberează.

Toată procesarea se face în browser (Web Audio API). Niciun sunet nu ajunge la server.

## Cum o pornești

Ai nevoie de .NET 8 SDK și de Chrome sau Edge.

```bash
cd VoiceDiarizationLightweight_Free
dotnet run --launch-profile https
```

Deschide https://localhost:7241 și permite accesul la microfon. Microfonul funcționează doar pe HTTPS sau pe localhost. Dacă browserul nu are încredere în certificatul de dezvoltare, rulează o dată `dotnet dev-certs https --trust`.

Din Visual Studio: deschizi `VoiceDiarizationLightweightFree.csproj` și apeși F5.

## Utilizare

- **Start all / Stop all** pornesc sau opresc toate etapele deodată.
- **Reset speakers** șterge vorbitorii și timeline-ul.
- **Audio file** analizează un fișier în loc de microfon, iar sunetul se aude în difuzoare. În `samples/` ai două conversații de test:
  - `conv_male_female.wav`: o voce de bărbat și una de femeie
  - `conv_two_males.wav`: două voci de bărbat, cazul greu

  Fișierele sunt utile ca backup la un demo live.
- **VAD threshold** se reglează după zgomotul din sală. Linia portocalie din graficul 1 trebuie să stea deasupra zgomotului de fond și sub vorbire.
- **Silence gap** e pauza după care o mostră se consideră încheiată.

Ca să meargă bine, vorbește fraze de cel puțin o secundă. Prima frază a fiecărui vorbitor îi creează amprenta.

## Pipeline și parametri

```
2048 eșantioane (≈ 46 ms) → FFT (AnalyserNode, fără smoothing)
→ 26 de filtre mel 80–8000 Hz → log → DCT → c0…c13
→ se elimină c0 → liftering k·c_k → media vectorilor bruți ai mostrei → normalizare L2
→ nearest-centroid (centroid = media L2 a ultimelor 10 amprente)
```

Pragul θ:
- începe la θ₀ = 0,7;
- devine d_inter / 2 când există doi vorbitori;
- devine max(3σ_intra; 0,15) după 5 mostre de la același vorbitor.

Când ambele valori sunt disponibile se folosește cea mai mică. În toate cazurile θ ≤ 0,8.

Câteva diferențe față de articol, alese după teste:

1. **Liftering k·c_k.** Fără el, c₁ (panta spectrală) domină vectorul. Pe două voci de bărbat, distanța minimă dintre vorbitori era 0,38, iar distanța maximă în interiorul aceluiași vorbitor 0,44, deci intervalele se suprapuneau. Cu liftering, distanța între vorbitori începe de la 0,93.
2. **θ₀ = 0,7 în loc de 0,5**, pentru că spațiul cu liftering e mai larg.
3. **Plafon θ ≤ 0,8.** Fără el, 3σ_intra ajungea la 0,88 și pragul „înghițea” al doilea vorbitor.
4. **Mostrele scurte** (sub 0,75 s, de exemplu cozile unei fraze tăiate la 4 s) nu pot crea un vorbitor nou. Sunt atribuite celui mai apropiat vorbitor, fără să-i modifice amprenta.

Parametrii se schimbă în `wwwroot/js/diarization.js` (constantele de la început) și în `SpeakerModel` din `wwwroot/js/dsp.js`.

## Testare

Aplicația a fost testată în Chrome headless, cu microfon simulat, pe cele două conversații din `samples/`, timp de 75 de secunde (fișierul rulează de aproape două ori):

- bărbat + femeie: 2 vorbitori, 22 de segmente, toate atribuite corect;
- doi bărbați: 2 vorbitori, 20 de segmente, toate atribuite corect.

Au mai fost verificate: Start/Stop pe fiecare etapă, eliberarea microfonului, modul fișier și resetarea.

`dsp.js` nu folosește DOM, deci se poate testa și în Node: `require("./wwwroot/js/dsp.js")`.

## Structură

```
Program.cs                    pipeline ASP.NET minim + Permissions-Policy: microphone=(self)
Controllers/HomeController.cs
Views/Home/Index.cshtml       cele 7 etape
wwwroot/js/dsp.js             mel, MFCC, liftering, L2, SpeakerModel (fără DOM)
wwwroot/js/diarization.js     audio, buclă de procesare, grafice canvas, butoane
wwwroot/css/site.css
wwwroot/lib/bootstrap/        Bootstrap 5.3.3 local (merge offline)
samples/                      conversații de test
```
