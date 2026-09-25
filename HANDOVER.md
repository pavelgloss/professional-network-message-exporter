# Aktuální handover

Poslední review dokumentace: **2026-09-25 Europe/Prague**

Stav: **implementace existuje, ale důvěryhodný obsahový export blokuje kritická chyba
BL-006; conversation-level `isStarred` je samostatně implementováno a ověřeno**

Poslední commit měnící runtime implementaci: **`bcfa8b5`**; novější commity před tímto
handoverem byly dokumentační.

Tento soubor obsahuje pouze současný stav. Staré checkpointy, slepé cesty a jejich
dočasné `Next:` kroky jsou v `docs/history/HANDOVER_CHECKPOINTS.md` a nejsou aktivní.

## Kde začít

Nový agent má číst v tomto pořadí:

1. kořenový `AGENTS.md` s bezpečnostními pravidly;
2. tento handover;
3. `README.md` pro provoz;
4. `FAQs.md` pro konsolidované praktické otázky a opravu dřívějších nepřesností;
5. `docs/ARCHITECTURE.md` pro výslednou implementaci;
6. `docs/DECISIONS.md` pro důvody a vývoj rozhodnutí;
7. `docs/OPERATIONS.md` pro poslední živé běhy a odvozené date-range soubory;
8. `BACKLOG.md` pro explicitně požadované budoucí změny;
9. `docs/README.md` pro rozlišení aktuálních a historických zdrojů.

Potom stačí před změnou přečíst jen relevantní zdrojové soubory a testy podle mapy v
architektuře; není nutné rekonstruovat projekt z celého zdrojového kódu.

## Kritický blocker — začít zde

`BL-006` v `BACKLOG.md` blokuje důvěryhodný export textů zpráv. Funkce `textFrom()` v
`src/linkedin/network/response-parser.ts` přijímá top-level InMail `subject` dříve,
než projde skutečné body obálky; v date-range výstupu se proto u různých message ID,
časů a směrů opakuje například pracovní titulek `AI Architect @ČEPS` místo obsahu.

Anonymní kontrola `messages-since-2026-05-01-updated.json` našla nejméně 107 takto
silně podezřelých zpráv z 253 ve 28 konverzacích. Message ID duplicitní nejsou; vadný
text je už ve zdrojovém `.source.json.partial`, tedy před následným date-range merge.
Skutečný počet zasažených zpráv může být vyšší, protože jednoduchá kontrola odhalila
jen text opakovaný alespoň dvakrát v jednom threadu.

Dokud nebude BL-006 opraven, zrevidován a ověřen novým nezávislým živým exportem:

- nepoužívat existující reálné JSONy pro obsahovou analýzu zpráv;
- neoznačovat žádný dosavadní export za obsahově validní jen podle schema, ID nebo
  `partial=false`;
- neopravovat vadná data mergem se starším exportem;
- nezačínat nižší prioritní feature práci před opravou parseru a regresní fixture.

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

Tyto testy a strukturální kontroly **neověřovaly sémantickou správnost InMail textu**
a BL-006 jimi nebyl pokryt. Údaje níže jsou historické provozní agregáty, nikoli
aktuální potvrzení správného message contentu.

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

Ani starší hlavní export, ani `isStarred` validační export nebyl zpětně obsahově
prověřen proti BL-006. Ověření hvězdiček zůstává relevantní pouze pro conversation
metadata a nedokazuje správnost textů zpráv.

Před finální promocí byl tehdejší hlavní export zachován jako lokální ignorovaný
`data/linkedin/messages.before-final-backup.json`. Reálná data, session i diagnostics
zůstávají mimo Git.

### Provozní exporty od 1. 5. 2026

Po explicitně autorizovaných bězích vznikly dva ignorované odvozené soubory:

- `messages-since-2026-05-01.json`: 126 konverzací a 235 zpráv;
- `messages-since-2026-05-01-updated.json`: 133 konverzací a 253 zpráv.

**Oba soubory jsou nyní označené jako obsahově vadné/nevhodné k použití**, protože
BL-006 kontaminoval texty zpráv ještě před jejich datumovou filtrací. Počty, ID,
časování a provenience zůstávají diagnostickým historickým záznamem, nikoli důkazem
správného obsahu.

Nejde o nativní CLI `--since` — taková volba neexistuje. Soubory vytvořila lokální
`jq` filtrace a incremental merge a používají vlastní
`exportType: "linkedin-message-date-range"`. Aktualizace zachovala všechna dřívější
message ID a přidala 7 konverzací a 18 zpráv. Čerstvý běh 2026-09-25 požadoval limit
150, LinkedIn lazy-loading skončil na 120 a raw kandidát proto zůstal `.partial`;
samotný exportní proces trval 3:57.842 a transformace 0.562 s. Přesný význam
`range.complete`, hashes a anonymní důkazy jsou v `docs/OPERATIONS.md`.

## Běžné použití

Následující příkazy popisují aktuálně implementované CLI, ale do opravy BL-006 nemá
být jejich výstup použit jako důvěryhodný export zpráv.

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
- Parser aktuálně může zaměnit InMail `subject` za `Message.text`; viz kritický BL-006.
- Běžný opakovaný export do stejného `--output` dnes implicitně merguje předchozí
  výsledek a může použít snapshot recovery. Uživatel požaduje opačný default: každý
  běh jako nový izolovaný bundle, merge pouze explicitně; viz kritický BL-003.
- History probe je dnes opt-in `--with-history-probe`; požadovaný budoucí default je
  jeden fresh probe na každý export s explicitním opt-outem; viz BL-005.
- Přílohy se dnes lokálně nestahují, ukládají se jen metadata a URL; požadavek na
  defaultní download do adresáře konkrétního bundle je v BL-002.
- Archivované konverzace nejsou cíleně podporované ani ověřené; BL-004 je pouze
  volitelný research task.

## Otevřené položky a priorita

Autoritativní detaily jsou v `BACKLOG.md`; pořadí pro nový agent je:

1. **BL-006 (kritická):** opravit záměnu InMail subject/body, přidat regresní testy,
   review a teprve potom provést nový živý export s explicitním souhlasem.
2. **BL-003 (kritická změna produktu):** každý běžný export jako nový nezávislý
   snapshot/bundle; starší export použít pouze v explicitním incremental režimu.
3. **BL-005:** history probe zapnout pro nový export defaultně a nabídnout opt-out.
4. **BL-001:** doplnit ověřená jména místo `Unknown participant`.
5. **BL-002:** volitelný attachment flag, defaultní lokální download a izolace v
   adresáři konkrétního exportu.
6. **BL-004:** pouze research archivovaných konverzací; implementace není rozhodnutá.

Mimo backlog zůstává volitelný upgrade Vitest 3 na 5 (dvě moderate dev-only audit
položky), živé ověření `--limit 200` a případný nativní `--since`.

## Bezpečný start další práce

```powershell
git status --short
npm.cmd run check
npm.cmd audit --omit=dev
npm.cmd audit
```

Očekávaný stav po tomto dokumentačním commitu je čistý worktree. První implementační
úkol nové session je BL-006; existence 157 procházejících testů není důvod tento
blocker přeskočit, protože chybí reálnému InMail tvaru odpovídající fixture.

Při změně architektury, CLI, bezpečnostní politiky nebo persistence aktualizovat ve
stejném commitu `README.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` a relevantní
testy. Historické dokumenty slouží pro vysvětlení vývoje, ne jako pracovní návod.
