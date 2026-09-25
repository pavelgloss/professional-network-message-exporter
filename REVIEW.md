# Aktuální review projektu a dokumentace

Aktualizováno: **2026-09-25 Europe/Prague**

Dokumentační handover: **PASS**. Runtime připravenost: **NO-GO pro živý probe
(BL-007) a obsahově důvěryhodný export (BL-006)**.

## Zdroj pravdy

Nový vývojář nebo agent má číst `AGENTS.md`, `HANDOVER.md`,
`BACKLOG_PROGRESS.md`, `BACKLOG.md`, `README.md`, `FAQs.md` a potom relevantní části
`docs/`. `docs/README.md` vysvětluje autoritu dokumentů; `docs/history/` je pouze
archiv vývoje a slepých cest.

## Současný ověřený stav

- Poslední runtime commit je `bcfa8b5`; novější změny před tímto review byly
  dokumentační.
- Baseline 2026-09-24 prošel `npm.cmd run check` se 157/157 testy.
- Nový plný běh 2026-09-25 jednou reprodukoval selection teardown race BL-007:
  cizí messaging GET dosáhl lokálního serveru bez guard violation. Tři cílené reruny
  a následný celý rerun 157/157 prošly, a proto je nález evidovaný jako intermittent,
  nikoli uzavřený.
- BL-006 potvrzuje, že dosavadní schema-validní export může mít u InMail zpráv
  `subject` místo skutečného body. Reálné exporty se nesmějí používat k obsahové
  analýze, dokud nevznikne opravený a nově ověřený snapshot.
- Produkční audit má 0 vulnerabilities; plný audit má dvě známé moderate dev-only
  položky ve Vitest řetězci.
- Conversation-level `isStarred` je implementované a živě agregátně ověřené: dva
  izolované běhy daly 8 `true`, 92 `false` a 0 unknown hodnot. To nepotvrzuje
  správnost textů ani úplnost historie.

## Dokumentační DoD

Splněno:

- existuje jednoznačné pořadí čtení a stručné aktuální FAQ;
- `BACKLOG_PROGRESS.md` ukládá restartovatelnou fázi, výsledky testů a přesnou další
  akci pro případ usage limitu nebo nového chatu;
- `AGENTS.md` definuje planner → implementation → independent review workflow,
  sekvenční writers, malé Git checkpointy a pravidla obnovy dirty worktree;
- as-built architektura je oddělena od budoucího cíle v backlogu;
- kritické vady, limity, živá evidence a audit jsou datované;
- historie a nahrazená rozhodnutí zůstávají dohledatelné, ale nejsou prezentované
  jako aktivní instrukce.

## Přesná další práce

Začít BL-007 podle checkpointu, poté BL-006, BL-003, BL-005, BL-001, BL-002 a
research-only BL-004. Živý history probe je do opravy BL-007 zakázaný; jakýkoli
pozdější živý LinkedIn test navíc vyžaduje explicitní souhlas uživatele v aktuálním
promptu.
