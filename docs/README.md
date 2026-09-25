# Rozcestník dokumentace

Stav dokumentace byl naposledy ověřen 2026-09-25 proti aktuálnímu pracovnímu stromu.
Tento soubor určuje, co je současný zdroj pravdy a co je pouze historický záznam.

## Doporučené pořadí pro nového agenta

1. [`../AGENTS.md`](../AGENTS.md) — automatické bezpečnostní a pracovní pokyny pro AI;
2. [`../HANDOVER.md`](../HANDOVER.md) — současný stav, ověřené výsledky, limity a
   bezpečný další krok.
3. [`../README.md`](../README.md) — instalace a provozní příkazy.
4. [`ARCHITECTURE.md`](ARCHITECTURE.md) — autoritativní as-built architektura,
   datový tok, bezpečnostní invariants, persistence a návratové kódy.
5. [`DECISIONS.md`](DECISIONS.md) — proč byla zvolena současná řešení a které starší
   návrhy byla opuštěny.
6. [`OPERATIONS.md`](OPERATIONS.md) — aktuální živé běhy, date-range postprocessing,
   časování a session lifecycle.
7. [`../CODE_REVIEW.md`](../CODE_REVIEW.md) a [`../REVIEW.md`](../REVIEW.md) —
   současný stručný stav code review a celkového review projektu.

Po přečtení těchto souborů má agent dost kontextu k nalezení relevantního modulu;
před změnou musí zkontrolovat jen dotčený zdrojový kód a jeho testy, nikoli pročítat
celý repozitář.

## Aktuální dokumenty

| Dokument | Účel | Autorita |
| --- | --- | --- |
| `AGENTS.md` | Automatické instrukce a bezpečnostní hranice pro AI | Aktuální |
| `README.md` | Uživatelský návod a bezpečné spuštění | Aktuální |
| `HANDOVER.md` | Stav předání, evidence a otevřené položky | Aktuální |
| `docs/ARCHITECTURE.md` | Výsledná technická architektura | Aktuální |
| `docs/DECISIONS.md` | Rozhodnutí a jejich vývoj | Aktuální |
| `docs/OPERATIONS.md` | Živé běhy a odvozené lokální výstupy | Aktuální |
| `PLAN.md` | Současný maintenance plán; žádná skrytá rozpracovaná implementace | Aktuální |
| `REVIEW.md` | Poslední celkové review | Aktuální |
| `CODE_REVIEW.md` | Platný stručný výsledek code review | Aktuální |
| `zadani.md` | Původní uživatelské zadání a rozsah | Původní specifikace |

Při rozporu dokumentace s implementací platí v tomto pořadí:

1. bezpečnostní invariants v `docs/ARCHITECTURE.md`;
2. runtime validace a fail-closed chování zdrojového kódu;
3. aktuální dokumentace uvedená výše;
4. historické dokumenty.

Rozpor se nesmí tiše obejít. Dokumentaci a testy je nutné opravit společně se změnou
implementace.

## Historické dokumenty

Adresář [`history/`](history/) je archiv. Obsahuje cenné slepé cesty, původní návrhy a
kompletní review stopu, ale žádný jeho příkaz `Next:` není aktivní úkol:

- [`history/IMPLEMENTATION_PLAN_ORIGINAL.md`](history/IMPLEMENTATION_PLAN_ORIGINAL.md)
  — původní plán před implementací; obsahuje později opuštěný persistentní profil a
  starý přepínač `--allow-thread-open`;
- [`history/REQUIREMENTS_REVIEW_ORIGINAL.md`](history/REQUIREMENTS_REVIEW_ORIGINAL.md)
  — původní interpretace zadání;
- [`history/CODE_REVIEW_LOG.md`](history/CODE_REVIEW_LOG.md) — chronologická série
  nálezů, oprav, `NO-GO` a následných re-review až po finální `GO`;
- [`history/HANDOVER_CHECKPOINTS.md`](history/HANDOVER_CHECKPOINTS.md) — průběžný
  pracovní deník, experimenty, slepé cesty a runtime checkpointy.

Historii používejte při zkoumání důvodu rozhodnutí nebo regresí. Pro současné příkazy,
přepínače a architekturu ji nepoužívejte.

## Pravidla aktualizace

- Každá změna datového toku, bezpečnostní politiky, CLI nebo persistence musí ve
  stejném commitu aktualizovat `ARCHITECTURE.md`, `README.md` a relevantní testy.
- `HANDOVER.md` udržujte krátký a pouze současný. Průběžné experimenty patří do
  nového datovaného záznamu v `docs/history/`, pokud mají budoucí hodnotu.
- Staré výsledky nemažte, ale výrazně je označte datem, baselinem a jako historické.
- Nikdy necommitujte `.auth/`, `.env`, reálné exporty, screenshoty ani diagnostiku s
  osobními daty.
