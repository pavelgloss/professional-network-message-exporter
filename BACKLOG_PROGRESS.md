# Backlog implementation progress

Aktualizováno: **2026-09-25 Europe/Prague**

Tento soubor je restartovatelný checkpoint pro implementaci `BACKLOG.md`. Není
náhradou požadavků ani historie; zaznamenává jen ověřený současný stav a přesnou další
akci. Při rozporu nejprve ověřte Git a pracovní strom podle `AGENTS.md`.

## Celkový stav

- **Fáze:** `NOT_STARTED`
- **Aktivní položka:** BL-007
- **Poslední dokončený baseline commit před založením workflow:** `5806359`
- **Očekávaný worktree po commitu tohoto checkpointu:** čistý
- **Aktivní subagenti:** žádní
- **Živá LinkedIn validace:** nepovolena samotným tímto souborem; vyžaduje explicitní
  souhlas uživatele v aktuální session

| Pořadí | Položka | Stav | Poznámka |
| ---: | --- | --- | --- |
| 1 | BL-007 | `NOT_STARTED` | Reopened selection teardown race; začít zde |
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
- Dokumentace, FAQ a backlog jsou commitnuté; žádná implementace backlogu ještě
  nezačala.

## Přesná další akce

1. Ověřit `git status --short` a poslední commity.
2. Spustit read-only plánovacího subagenta pouze pro BL-007.
3. Nechat jej zmapovat teardown selection stránky, CDP/network ordering, fresh target
   lifecycle, historický nález `ZR-01`, současný stress test a deterministickou
   server-hit-0 akceptaci.
4. Zrevidovaný stručný plán zapsat sem, nastavit fázi `PLANNING` a commitnout plan
   checkpoint před zahájením implementace.

## Dokončené checkpointy

- `8624438` — kritické integritní blockery a backlog zaznamenány v aktivních docs.
- `6168d73` — vytvořeno konsolidované FAQ.
- `5806359` — FAQ zkráceno na 15 hlavních témat se zaměřením na `isStarred`.

## Otevřené nálezy a blockery

- BL-007 je znovu otevřený kritický bezpečnostní nález a blokuje živý probe.
- BL-006 je otevřený kritický nález integrity obsahu.
- Žádný technický blocker zatím nebrání zahájení plánování a syntetické implementace.
- Živý history probe se nesmí spustit do uzavření BL-007; jakýkoli pozdější živý
  LinkedIn běh navíc vyžaduje nový explicitní souhlas uživatele.
