# MNEMOS Browser

Privāta MNEMOS Browser 0.1.0 pirmkoda kopija. Tajā ir Electron lietotne, Chromium darba telpas un profilu izolācija, Atomic Age saskarne, Council, Ollama integrācija, Frontier Bus, Perplexity un Gemini savienotāji un to testi.

## Izstrāde un Windows pakotne

Nepieciešams Node.js 24 vai jaunāks. Portatīvās pakotnes mērķis ir Windows x64.

```powershell
npm --prefix apps/browser ci
npm --prefix apps/browser test
npm --prefix apps/browser start
```

Pārlūks izmanto lietotāja AppData profilu. Atsevišķu profila mapi var norādīt ar `MNEMOS_BROWSER_PROFILE`. Lokālais Ollama pakalpojums nodrošina lokālos modeļus. Pilnai Core funkcionalitātei vajadzīgs atsevišķi palaists saderīgs MNEMOS Core. Pārlūka noklusējuma Core adrese ir `http://127.0.0.1:4320`, un to var mainīt ar `MNEMOS_BROWSER_CORE_ORIGIN`, izmantojot to pašu adresi ar atbilstošo portu. Šajā repozitorijā ir Browser izmantotie Frontier Bus un Windows DPAPI moduļi.

```powershell
npm --prefix apps/browser run package:portable
npm --prefix apps/browser run verify:portable
```

Pakotne un SHA‑256 manifests tiek izveidoti `apps/browser/dist`. Ar `MNEMOS_BROWSER_PACKAGE_ROOT` var norādīt citu mapi. Ja mērķa `portable` mape jau eksistē, būvēšanai jāizvēlas jauna mērķa mape.

## Izvēles savienotāji

Savienotāja konfigurācija, OAuth dati un DPAPI noslēpumi glabājas ārpus repozitorija. Windows noklusējuma mape ir `%LOCALAPPDATA%\MNEMOS Browser\connectors\perplexity`. Citu absolūto ceļu norāda ar `MNEMOS_CONNECTOR_ROOT`. Pēc akreditācijas datu izveides pakalpojums klausās tikai lokālajā adresē `127.0.0.1:8876`.

```powershell
node apps/browser/connectors/perplexity/provision.mjs
node apps/browser/connectors/perplexity/server.mjs
```

Attālinātajam Perplexity savienojumam un Gemini OAuth norādi savas instalācijas HTTPS adresi ar `MNEMOS_CONNECTOR_PUBLIC_ORIGIN`. Adresei jābūt bez ceļa vai vaicājuma parametriem. Gemini konfigurāciju izveido `node apps/browser/scripts/provision-gemini-oauth.mjs`. Tailscale un Windows plānotāja palīgskripti atrodas `apps/browser/connectors/perplexity` un ir palaižami pēc izvēles.

`npm --prefix apps/browser run test:release` palaiž arī Electron testus ar izolētiem profiliem un testa pakalpojumiem. Core integrācijas testam `npm --prefix apps/browser run test:platform:memory` norādi saderīga Core pirmkoda ceļu ar `MNEMOS_CORE_CHECKOUT`.

Šī kopija izveidota no Browser darba koka pie `cfa161c37a23b766f79164d1d2f3e2bca1b41473`, iekļaujot jaunākos lokālos avota failus. Profili, sesijas, piekļuves dati, žurnāli, iepriekšējā Git vēsture un konkrētās darbstacijas izvietošanas diagnostika paliek lokālajā vidē.
