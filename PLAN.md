# Aktuální plán a maintenance backlog

Stav k 2026-09-24: **původní zadání je implementované a není zde žádná rozpracovaná
blokující změna**.

Výsledná architektura je v `docs/ARCHITECTURE.md`, současné předání v `HANDOVER.md` a
důvody rozhodnutí v `docs/DECISIONS.md`. Původní předimplementační plán je zachován v
`docs/history/IMPLEMENTATION_PLAN_ORIGINAL.md`; není zdrojem aktuálních příkazů ani
architektury.

## Volitelná budoucí práce

### 1. Upgrade Vitest

Plný `npm audit` 2026-09-24 hlásí dvě moderate položky ve vývojové závislosti
`vitest`/`@vitest/mocker`; produkční audit je čistý. Oprava vyžaduje major upgrade na
Vitest 5. Provést jako samostatnou změnu, zkontrolovat migration notes, lockfile a
spustit všech 150 testů. Nepoužívat automaticky `npm audit fix --force` bez review.

### 2. Ověření limitu 200

CLI rozsah 1–500 podporuje, ale živě bylo ověřeno 100. Test 200 vyžaduje explicitní
souhlas uživatele, platnou session a stejný read-only režim. Výsledek musí být
schema-validní, `partial=false`, bez duplicit a s prokázanou úplností všech historií.

### 3. Budoucí LinkedIn změny

Při parser/policy regresi nejprve zkoumat redigovaný manifest a anonymizovat nový tvar
do fixture. Nerozšiřovat allowlist ani nepovolovat POST/redirect pouze proto, aby běh
prošel. Změna musí mít negativní bezpečnostní test a aktualizaci architektury.

## Definition of Done pro každou změnu

- `npm.cmd run check` projde;
- produkční audit zůstane čistý a plný audit je zdokumentovaný;
- Git neobsahuje session, export ani obsahovou diagnostiku;
- `README.md`, `HANDOVER.md` a `docs/ARCHITECTURE.md` si neodporují;
- živý LinkedIn běh se neprovádí bez výslovného souhlasu;
- změna je lokálně commitnutá s jasným popisem.
