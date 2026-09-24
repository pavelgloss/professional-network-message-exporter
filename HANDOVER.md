# Aktuální handover

Poslední review: **2026-09-24 Europe/Prague**

Stav: **funkční projekt dokončen; žádný blokující implementační úkol**

Poslední code baseline: **`b611a61`**

Tento soubor obsahuje pouze současný stav. Staré checkpointy, slepé cesty a jejich
dočasné `Next:` kroky jsou v `docs/history/HANDOVER_CHECKPOINTS.md` a nejsou aktivní.

## Kde začít

Nový agent má číst v tomto pořadí:

1. kořenový `AGENTS.md` s bezpečnostními pravidly;
2. tento handover;
3. `README.md` pro provoz;
4. `docs/ARCHITECTURE.md` pro výslednou implementaci;
5. `docs/DECISIONS.md` pro důvody a vývoj rozhodnutí;
6. `docs/README.md` pro rozlišení aktuálních a historických zdrojů.

Potom stačí před změnou přečíst jen relevantní zdrojové soubory a testy podle mapy v
architektuře; není nutné rekonstruovat projekt z celého zdrojového kódu.

## Ověřený stav

K 2026-09-24:

- `npm.cmd run check`: **PASS** — typecheck, build, 16 test files, 150/150 testů;
- `npm.cmd audit --omit=dev`: **0 vulnerabilities**;
- plný `npm.cmd audit`: **2 moderate** ve vývojovém řetězci
  `vitest`/`@vitest/mocker`; automatická oprava vyžaduje breaking upgrade na Vitest 5;
- Git byl před dokumentační úpravou čistý;
- od `b611a61` nebyla změněna implementace, pouze dokumentace;
- lokální ignorovaný `data/linkedin/messages.json` byl znovu schema-validován bez
  čtení nebo výpisu osobního obsahu.

Poslední živý LinkedIn export proběhl 2026-09-07, nikoli během tohoto review. Jeho
stále přítomný lokální výsledek má:

- `partial=false`;
- 100 nejnovějších konverzací a 193 zpráv;
- 100/100 historií označených kompletních;
- 0 parser missů;
- 0 duplicitních conversation ID a message ID.

Před finální promocí byl tehdejší hlavní export zachován jako lokální ignorovaný
`data/linkedin/messages.before-final-backup.json`. Reálná data, session i diagnostics
zůstávají mimo Git.

## Běžné použití

Pokud session expiruje:

```powershell
npm.cmd run login
```

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
- Otevření i již přečteného threadu má malé neodstranitelné server-side read-state
  riziko, proto je explicitní.

## Otevřené položky

Nic není blokující pro současné použití. Pouze volitelné budoucí práce:

1. Upgrade Vitest 3 na 5 v samostatné změně, poté celý test suite. Dnešní dvě moderate
   audit položky jsou pouze v dev dependency; produkční audit je čistý.
2. End-to-end ověření `--limit 200` jen po výslovném souhlasu uživatele.
3. Adaptace parseru/policy, pokud LinkedIn změní neveřejný kontrakt.

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
