# Aktuální stav code review

Aktualizováno: **2026-09-25 Europe/Prague**

Poslední runtime commit: **`bcfa8b5`**

Verdikt:

- **NO-GO pro živý history probe** do uzavření BL-007;
- **NO-GO pro důvěryhodný obsahový export** do uzavření BL-006;
- conversation-level `isStarred` zůstává samostatně **GO**.

## Otevřené blokující nálezy

### BL-007 — intermittent selection teardown network race

Plný `npm.cmd run check` 2026-09-25 jednou selhal v integračním testu `keeps 30
zero-to-ten-millisecond selection races disjoint from the fresh target page`. V
iteraci 25 s delay 3 ms zasáhl lokální server jeden GET na cizí
`/voyager/api/messagingV2/conversations/UNREAD/events`; guard snapshot přitom hlásil
nula violations a target navigace se neprovedla.

Tři bezprostřední cílená opakování prošla. To odpovídá historickému High nálezu
`ZR-01` v `docs/history/CODE_REVIEW_LOG.md`, který měl stejný endpoint, nulové
countery a následné zelené reruny. Nález je proto znovu otevřen, ne označen za flaky.

### BL-006 — InMail subject místo message body

Parser může vybrat top-level `subject` dříve než skutečný nested body. Unikátní ID,
schema validita ani `partial=false` tuto sémantickou záměnu neodhalí. Známý
date-range výstup proto není obsahově důvěryhodný; přesný dopad a akceptace jsou v
`BACKLOG.md`.

## Co z předchozího review zůstává platné

- Export používá fresh Playwright context ze storage state a nesahá na běžný Chrome.
- POST, WebSocket a service worker cesty jsou blokované a testované.
- One-thread target vyžaduje aktuální network evidence `read=true` bez konfliktu.
- History GET a pagination jsou omezené na rozpoznaný target/kontrakt a při
  nejasnosti mají selhat uzavřeně.
- Parser miss nebo nedokázaná list/history completeness nemají vytvořit tichý úplný
  export.
- `isStarred` je optional boolean konverzace, čtený pouze z trusted `categories[]`;
  star/unstar operace zůstávají blokované. Dva izolované běhy 2026-09-24 shodně
  získaly 8 starred a 92 unstarred konverzací bez unknown hodnot.

Tato tvrzení neruší BL-007 ani BL-006: první ukazuje timingovou mezeru před target
fází, druhý chybějící sémantickou validaci message body.

## Automatická evidence

- Baseline 2026-09-24: `npm.cmd run check` PASS, 16 souborů a 157/157 testů.
- Běh 2026-09-25: typecheck a build PASS, 1/157 testů FAIL na BL-007.
- Tři následné cílené reruny race testu: PASS; nedeterministický nález tím není
  uzavřen.
- Následný celý rerun: PASS, 16 souborů a 157/157 testů; ani jeden zelený full run
  dříve reprodukovaný timingový únik neuzavírá.
- `npm.cmd audit --omit=dev`: 0 vulnerabilities.
- Plný `npm.cmd audit`: 2 moderate ve vývojovém řetězci Vitest; oprava vyžaduje
  breaking upgrade a není součástí aktuálních blockerů.

## Pořadí nápravy

Pokračovat z `BACKLOG_PROGRESS.md`: BL-007, BL-006, BL-003, BL-005, BL-001, BL-002 a
research-only BL-004. Každá položka vyžaduje oddělený plán, implementaci, nezávislé
review, testy, dokumentaci a commitnutý checkpoint podle `AGENTS.md`.

## Historická stopa

Původní nálezy, dočasné verdikty, opravy a re-review jsou zachované v
`docs/history/CODE_REVIEW_LOG.md`. Je to historický zdroj pro cílené pátrání, ne
aktuální pracovní návod.
