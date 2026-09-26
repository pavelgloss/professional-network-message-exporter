# Backlog implementation progress

Aktualizováno: **2026-09-26 Europe/Prague**

Tento soubor je restartovatelný checkpoint pro implementaci `BACKLOG.md`. Není
náhradou požadavků ani historie; zaznamenává jen ověřený současný stav a přesnou další
akci. Při rozporu nejprve ověřte Git a pracovní strom podle `AGENTS.md`.

## Celkový stav

- **Fáze:** `REVIEW`
- **Aktivní položka:** BL-007
- **Poslední ověřený commit:** `b564546` (schválený plán); aktuálně dirty implementace BL-007
- **Worktree:** vlastní necommitnutý runtime/test/docs diff BL-007; ostatní BL beze změny
- **Aktivní subagenti:** žádný writer; implementer narazil na usage limit po předání
  runtime diffu. Následuje nový read-only reviewer.
- **Živá LinkedIn validace:** uživatel v promptu této session výslovně povolil nezbytné
  read-only běhy v izolovaném Chromium; history probe až po uzavření BL-007.

| Pořadí | Položka | Stav | Poznámka |
| ---: | --- | --- | --- |
| 1 | BL-007 | `REVIEW` | Implementace a první plný check PASS; čeká review a další validace |
| 2 | BL-006 | `NOT_STARTED` | Kritický blocker důvěryhodnosti textu |
| 3 | BL-003 | `NOT_STARTED` | Nezávislé snapshoty a bundle persistence |
| 4 | BL-005 | `NOT_STARTED` | Defaultní probe; blokováno BL-007 |
| 5 | BL-001 | `NOT_STARTED` | Ověřená participant/display names |
| 6 | BL-002 | `NOT_STARTED` | Lokální přílohy; závisí na bundle z BL-003 |
| 7 | BL-004 | `NOT_STARTED` | Research-only, bez automatické implementace |

## Poslední ověřený stav projektu

- Současná runtime implementace stále obsahuje BL-006; existující reálné exporty
  nejsou důvěryhodné pro obsahovou analýzu.
- Kontrola 2026-09-25 nad nezměněným runtime kódem: typecheck a build PASS, ale plný
  test run jednou selhal v race testu `keeps 30 zero-to-ten-millisecond selection
  races disjoint from the fresh target page`. V iteraci 25, delay 3 ms, dorazil na
  lokální server jeden cizí GET; guard snapshot přitom hlásil nula violations.
- Tři bezprostřední spuštění stejného cíleného testu prošla. Stejný intermittent
  průběh a endpoint už popisuje historický High nález `ZR-01`; proto je problém znovu
  otevřen jako BL-007. Následný celý rerun prošel 157/157; jednotlivý zelený rerun
  nedeterministický bezpečnostní nález neuzavírá.
- Produkční audit: 0 vulnerabilities.
- Plný audit: dvě známé moderate dev-only položky ve Vitest řetězci.
- Plán BL-007 je commitnutý; implementace, testy a aktivní docs jsou ve worktree.

## Přesná další akce

Implementace BL-007: lifetime deny HTTP/CONNECT proxy před první page; žádný
browserový fallback. Dokument/API/asset brokery kontrolují generation a ownership,
selection se synchronně revokuje před bounded drainem a target page. Dispose/close
zůstává kryté proxy; finální manifest a výsledek se kontrolují až po context.close.

Hotové důkazy: původní suite 38/38 PASS; rozšířená 44/44 PASS (včetně původní 30×
regrese a nové 55× source/timing matrix), další 2 cílené testy PASS pro queued
broker revocation před prvním sendem a hard audit po gate.dispose. Typecheck PASS.
První bypass test správně zastavil ještě starý CDP pattern, proto byl upraven na
unknownMessaging namespace mimo jeho patterny; nyní prokazuje >=2 proxy hitů
(HTTP loopback + CONNECT) a 0 server hitů, hard state blokuje target.

Orchestrátor ověřil diff a první plný `npm.cmd run check`: PASS 165/165,
typecheck/build PASS. Implementer doložil první oddělený stress proces PASS;
dokončení dalších čtyř není po jeho usage limitu prokázáno. Logger counter ověřen
správný. Matrix zatím kontroluje server count před cleanupem; review má prověřit
i explicitní assertion po cleanupu.

Přesná další akce: commit tohoto implementation checkpointu, nový read-only review,
dokončit doložené oddělené stress procesy, druhý plný check a audity.
Položka není DONE; živý probe stále zakázán. Ostatní BL čekají.

### Schválený plán BL-007 (po read-only plánování)

- Doložená cesta v instalovaném Playwright `coreBundle.js`: zaniklý frame vede
  přímo k `Fetch.continueRequest` před aplikačním Route; page.close také přeskakuje
  handlery. Přesné CDP pořadí původního incidentu není zachyceno. Page-scoped fence
  a drain aplikačních routes proto neprokazují izolaci.
- Přidat lifetime loopback deny proxy pouze pro probe context, instalovanou před
  první page; HTTP/CONNECT nikdy neforwarduje. Gate odmítne nechráněný context.
  Ověřit v testu i Chromium loopback bypass a úmyslný route bypass.
- Povolené dokumenty/API/assets zobrazovat pouze přes izolované GET/HEAD brokery,
  maxRedirects=0, omezené originy/resource typy, bezpečné hlavičky a omezené timeouty.
  Žádné nové POST/WS/SW, žádný přímý browserový fallback.
- Closing synchronně revokuje selection generation, broker kontroluje generation
  před sítí, drain dokončí pending operace; teprve pak zavřít selection a vytvořit
  target. Ownership frames/workers se nesmí přenést do target politiky.
- Každý zásah deny proxy je redigovaný hard stav; na skutečném cizím serveru stále 0.
- Zachovat původní 30× race regresi a přidat 0–10ms matrix fetch/keepalive/assets,
  iframe/worker a pending GET; happy path ověří skutečný script i history GET.
- Validace: nejméně 5 oddělených stress procesů a 2 plné check běhy, oba audity,
  nezávislé review; živý probe až po uzavření BL-007.
- Soubory: nový src/browser/probe-transport.ts, context.ts, probe.ts,
  probe-navigation.ts, integrační testy; README/HANDOVER/FAQs/ARCHITECTURE/
  DECISIONS/OPERATIONS. Bez migrace dat nebo CLI. Riziko: omezené assets mohou
  způsobit fail-closed živý probe; politika se kvůli úplnosti nesmí uvolnit.
- Baseline validace v této session: npm.cmd run check PASS 157/157 + build/typecheck;
  audit --omit=dev 0; plný audit 2 známé moderate dev-only (exit 1).
- Přesný další krok: jediný implementer provede tento plán, neoznačí BL DONE ani
  nespustí živý LinkedIn; potom orchestrátor diff/test/implementation checkpoint.

## Dokončené checkpointy

- `8624438` — kritické integritní blockery a backlog zaznamenány v aktivních docs.
- `6168d73` — vytvořeno konsolidované FAQ.
- `5806359` — FAQ zkráceno na 15 hlavních témat se zaměřením na `isStarred`.

## Otevřené nálezy a blockery

- BL-007 je znovu otevřený kritický bezpečnostní nález a blokuje živý probe.
- BL-006 je otevřený kritický nález integrity obsahu.
- Žádný otevřený technický blocker syntetické implementace; nezávislé review ještě
  neproběhlo. Živá kompatibilita přísného asset allowlistu není zatím prokázána.
- Živý history probe se nesmí spustit do uzavření BL-007; souhlas s nezbytnými
  pozdějšími živými běhy již byl udělen v aktuálním uživatelském promptu.
