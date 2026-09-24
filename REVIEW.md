# Aktuální review projektu a dokumentace

Datum: **2026-09-24**

Review baseline: implementace `b611a61` + následné dokumentační změny

Verdikt: **PASS — projekt má aktuální předatelnou dokumentaci a jasně oddělenou historii**

## Rozsah review

Byly porovnány:

- původní zadání;
- všechny root dokumenty a jejich Git historie;
- současné CLI volby, konfigurace a návratové kódy;
- autentizace, browser isolation, request policy, exporter, probe, history reader,
  schema, merge, store a diagnostika;
- názvy a pokrytí unit/integration testů;
- lokální ignorovaný export pouze agregátně a přes runtime schema, bez výpisu zpráv.

## Napravené dokumentační problémy

1. Původní plán popisoval persistentní profil a starý `--allow-thread-open`. Byl
   přesunut do jasně označeného archivu; současný plán odkazuje na as-built návrh.
2. Chronologický code-review log začínal starým `NO-GO`, přestože končil `GO`. Aktivní
   `CODE_REVIEW.md` nyní obsahuje pouze platný verdikt a archiv je označen jako historie.
3. Handover míchal hotový stav se stovkami řádků starých `Next:` kroků. Aktivní
   handover je současný a pracovní log je archivovaný.
4. Chyběla výsledná architektura a mapa zdrojů. Byla doplněna v
   `docs/ARCHITECTURE.md` včetně lazy loadingu, completeness, snapshot recovery,
   persistence, privacy, návratových kódů a limitací.
5. Chyběl rozcestník a pravidlo autority dokumentů. Byly doplněny v `docs/README.md`.
6. Stará informace `npm audit: 0` byla nahrazena současným stavem: produkční audit 0,
   plný audit 2 moderate v dev-only Vitest řetězci.

## Ověření

- `npm.cmd run check`: PASS, 16 souborů / 150 testů, typecheck a build.
- `npm.cmd audit --omit=dev`: 0 vulnerabilities.
- `npm.cmd audit`: 2 moderate dev-only findings, major fix dostupný přes Vitest 5.
- Lokální export: schema validní, `partial=false`, 100 konverzací, 193 zpráv,
  100 kompletních historií, 0 parser missů a 0 duplicitních ID.
- Od `b611a61` do začátku tohoto review se změnily jen dokumenty.

## Zbytková omezení

- Review nespustilo nový živý LinkedIn export; poslední live důkaz je z 2026-09-07.
- Limit 200 je implementačně povolený, nikoli živě ověřený.
- LinkedIn UI lazy-loading a neveřejné endpointy zůstávají externě proměnlivé.
- Dokumentace umožní agentovi pochopit systém bez čtení celého kódu, ale před změnou
  musí agent vždy přečíst dotčený modul a jeho testy.

## Dokumentační DoD

Splněno:

- existuje jednoznačné pořadí čtení;
- aktivní dokumenty neodkazují na staré přepínače jako na současné;
- architektura odpovídá aktuálnímu source flow;
- omezení, rizika, audit a live evidence jsou datované;
- historie, slepé cesty a vývoj review zůstaly dohledatelné;
- historické `NO-GO` a `Next:` položky jsou zřetelně neaktivní.
