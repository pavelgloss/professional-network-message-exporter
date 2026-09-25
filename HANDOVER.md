# Aktuální handover

Poslední review dokumentace: **2026-09-25 Europe/Prague**

Stav: **funkční projekt; conversation-level `isStarred` je implementováno,
nezávisle zrevidováno a živě ověřeno v izolovaném browseru**

Aktuální implementační baseline: **`bcfa8b5`**

Tento soubor obsahuje pouze současný stav. Staré checkpointy, slepé cesty a jejich
dočasné `Next:` kroky jsou v `docs/history/HANDOVER_CHECKPOINTS.md` a nejsou aktivní.

## Kde začít

Nový agent má číst v tomto pořadí:

1. kořenový `AGENTS.md` s bezpečnostními pravidly;
2. tento handover;
3. `README.md` pro provoz;
4. `docs/ARCHITECTURE.md` pro výslednou implementaci;
5. `docs/DECISIONS.md` pro důvody a vývoj rozhodnutí;
6. `docs/OPERATIONS.md` pro poslední živé běhy a odvozené date-range soubory;
7. `docs/README.md` pro rozlišení aktuálních a historických zdrojů.

Potom stačí před změnou přečíst jen relevantní zdrojové soubory a testy podle mapy v
architektuře; není nutné rekonstruovat projekt z celého zdrojového kódu.

## Ověřený stav

K 2026-09-24:

- `npm.cmd run check`: **PASS** — typecheck, build, 16 test files, 157/157 testů
  včetně změny `isStarred`;
- `npm.cmd audit --omit=dev`: **0 vulnerabilities**;
- plný `npm.cmd audit`: **2 moderate** ve vývojovém řetězci
  `vitest`/`@vitest/mocker`; automatická oprava vyžaduje breaking upgrade na Vitest 5;
- Git byl před dokumentační úpravou čistý;
- změna `isStarred` rozšiřuje parser, schema, normalizaci, merge a star/unstar guard;
- lokální ignorovaný `data/linkedin/messages.json` byl znovu schema-validován bez
  čtení nebo výpisu osobního obsahu.

Poslední úplný hlavní LinkedIn export proběhl 2026-09-07. Jeho stále přítomný lokální
výsledek má:

- `partial=false`;
- 100 nejnovějších konverzací a 193 zpráv;
- 100/100 historií označených kompletních;
- 0 parser missů;
- 0 duplicitních conversation ID a message ID.

Tento starší hlavní export vznikl před přidáním `isStarred`. Nová implementace byla
2026-09-24 dvakrát ověřena samostatným ignorovaným výstupem
`messages.starred-validation.json.partial` v izolovaném ephemeral Chromium contextu:
oba běhy daly 100 konverzací, 8 `true`, 92 `false`, 0 unknown/invalid hodnot,
0 duplicitních ID a 0 parser missů. Běhy skončily `partial` kvůli již známým limitům
úplnosti historie; to nepopírá conversation-list evidenci hvězdiček. Druhý běh
zablokoval 133 POST requestů před odesláním a hlavní export nezměnil.

Před finální promocí byl tehdejší hlavní export zachován jako lokální ignorovaný
`data/linkedin/messages.before-final-backup.json`. Reálná data, session i diagnostics
zůstávají mimo Git.

### Provozní exporty od 1. 5. 2026

Po explicitně autorizovaných bězích vznikly dva ignorované odvozené soubory:

- `messages-since-2026-05-01.json`: 126 konverzací a 235 zpráv;
- `messages-since-2026-05-01-updated.json`: 133 konverzací a 253 zpráv.

Nejde o nativní CLI `--since` — taková volba neexistuje. Soubory vytvořila lokální
`jq` filtrace a incremental merge a používají vlastní
`exportType: "linkedin-message-date-range"`. Aktualizace zachovala všechna dřívější
message ID a přidala 7 konverzací a 18 zpráv. Čerstvý běh 2026-09-25 požadoval limit
150, LinkedIn lazy-loading skončil na 120 a raw kandidát proto zůstal `.partial`;
samotný exportní proces trval 3:57.842 a transformace 0.562 s. Přesný význam
`range.complete`, hashes a anonymní důkazy jsou v `docs/OPERATIONS.md`.

## Běžné použití

Pokud session expiruje:

```powershell
npm.cmd run login
```

Storage state je samostatná Playwright session a export jej na disku neobnovuje.
Běžné odhlášení pouze v Chrome ji obvykle neukončí; globální odhlášení, změna hesla
nebo bezpečnostní revokace ano.

Bezpečný výchozí export bez otevření threadu:

```powershell
npm.cmd run export -- --limit 100
```

Praktický úplný export s výslovným one-read-thread opt-in:

```powershell
npm.cmd run export -- --limit 100 --with-history-probe
```

Tento opt-in smí otevřít nejvýše jeden thread s aktuálním network důkazem
`read=true`. Hlavní historie se pak načítají read-only GET requesty, nikoli
proklikáváním všech vláken.

## Nepřekročitelné bezpečnostní hranice

- Nespouštět automatizaci nad běžným Chrome profilem a nezavírat uživatelův Chrome.
- Nepovolovat POST, WebSocket, service worker ani mutační/nejednoznačný endpoint jen
  kvůli úplnosti.
- Guardy jsou defense-in-depth, nikoli stealth; LinkedIn může skript poznat z GET
  provozu a část blokovaných POSTů je pravděpodobně pouze telemetrie.
- Neotvírat unread nebo neověřený thread; starý lokální export není důkaz read stavu.
- `.partial` nikdy nepovýšit na hlavní export bez schema a completeness validace.
- Necommitovat ani nevypisovat `.auth`, `.env`, reálné JSON exporty, screenshots,
  HTML diagnostics, cookies nebo zprávy.
- Živý LinkedIn test provést jen s explicitním souhlasem vlastníka účtu.

## Známá omezení

- Živě je ověřeno 100 konverzací. CLI podporuje 200 a maximálně 500, ale 200 nebylo
  na tomto účtu end-to-end ověřeno.
- LinkedIn UI někdy nevydá older-page persisted operaci. Reader umí bezpečně odvodit
  ověřený anchored kontrakt, ale fresh dlouhá historie bez použitelného kontraktu nebo
  předchozího úplného snapshotu může skončit exit 5 a `.partial`.
- Pokud je požadovaný limit vyšší než skutečný počet dostupných konverzací, současný
  konzervativní důkaz úplnosti seznamu může rovněž skončit `.partial`.
- Neveřejný LinkedIn endpoint nebo DOM se může změnit; očekávané chování je fail-closed.
- Recruiter klasifikace je heuristika.
- `isStarred` je volitelné conversation-level pole. `true`/`false` vzniká jen z
  dobře utvořeného `categories[]` na důvěryhodném list objektu; chybějící či
  malformed evidence nechá hodnotu neznámou a merge zachová starší explicitní stav.
- Otevření i již přečteného threadu má malé neodstranitelné server-side read-state
  riziko, proto je explicitní.
- CLI nemá `--since`; date-range JSON je nyní pouze odvozený, strict
  `ExportSchema`-nekompatibilní artefakt popsaný v `docs/OPERATIONS.md`.
- `messages-since-2026-05-01-updated.json` používá incremental baseline, protože
  čerstvý list 2026-09-25 nepřekročil hranici 1. 5. Jeho `range.complete` není totéž
  co nativní globální `partial=false`.

## Otevřené položky

Změna `isStarred` je uzavřená. Ostatní položky jsou volitelné:

1. Upgrade Vitest 3 na 5 v samostatné změně, poté celý test suite. Dnešní dvě moderate
   audit položky jsou pouze v dev dependency; produkční audit je čistý.
2. End-to-end ověření `--limit 200` jen po výslovném souhlasu uživatele.
3. Adaptace parseru/policy, pokud LinkedIn změní neveřejný kontrakt.
4. Pouze pokud bude date-range export opakovaná funkce: navrhnout nativní `--since`
   nebo verzovaný transformační nástroj se schematem a testy.

## Bezpečný start další práce

```powershell
git status --short
npm.cmd run check
npm.cmd audit --omit=dev
npm.cmd audit
```

Při změně architektury, CLI, bezpečnostní politiky nebo persistence aktualizovat ve
stejném commitu `README.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` a relevantní
testy. Historické dokumenty slouží pro vysvětlení vývoje, ne jako pracovní návod.
