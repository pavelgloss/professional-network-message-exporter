# Provozní poznámky a živé ověření

Stav: **aktuální k 2026-09-25 Europe/Prague**

Tento dokument zaznamenává skutečné lokální běhy a odvozené datové výstupy. Nejde o
architekturu ani o veřejná testovací data. Uvedené JSON soubory jsou ignorované
Gitem, obsahují soukromé zprávy a nesmějí se commitovat, sdílet ani vkládat do AI
kontextu. Níže jsou pouze anonymní agregáty.

> **Později zjištěná obsahová vada (BL-006):** Před opravou network parser u InMail
> eventů mohl vybrat top-level `subject` místo skutečného body. Oba níže popsané
> date-range soubory jsou proto historické diagnostické artefakty a nesmějí se použít
> pro obsahovou analýzu; jejich strukturální kontroly tuto sémantickou chybu nekryly.

## BL-006: připravené ověření, zatím bez nového živého výsledku

Nová anonymní fixture `inmail-body-integrity.json` zachovává Dash InMail tvar:
stejný subject, dva různé body, inbound/outbound, stabilní ID, časy a přílohu.
Quality gate porovnává přesné hodnoty po normalizaci a persistence; subject-only
kandidát musí vést na `.partial` a zachovat úplný JSON beze změny. Historický
minimální dopad zůstává 107/253 zpráv ve 28 konverzacích, není to úplný odhad.

Živá validace je záměrně mimo `npm test`/`npm run check`. Po review a s aktuálním
souhlasem vlastníka lze explicitně spustit:

```powershell
$env:LINKEDIN_LIVE_INMAIL_VALIDATION = '1'
npx.cmd vitest run --config scripts/manual-tests/vitest.config.ts
Remove-Item Env:LINKEDIN_LIVE_INMAIL_VALIDATION
```

Harness spustí standardní export `--with-history-probe --limit 100` s novou UUID
output cestou pod ignorovaným `data/linkedin/`; ověří nepřítomnost JSON i `.partial`.
Existující export tedy není baseline. Zachycené bodies porovná pouze v paměti přes
nezávislé explicitní referenční paths se skutečně uloženým exportem a stabilními ID.
Loguje jen počty/booleany a uzavřené error kódy; běžné log details, obsahové
diagnostics a původní výjimky nevypisuje. Potřebuje inbound i outbound InMail body,
alespoň jedno skutečné body odlišné od subjectu a reportuje počet attachment-only,
nulové neshody, chybějící/unsupported vzorky a nulové parser misses; žádné vzorky
není úspěch. `partial` kvůli coverage se reportuje odděleně od integrity textu.
AUTH_REQUIRED/AUTH_CHALLENGE nebo hard bezpečnostní chyba znamená zastavit;
policy se kvůli úspěchu testu nerozšiřuje. Běžný Chrome se nepoužívá ani nezavírá.

## 1. Co umí nativní CLI

BL-007 byl uzavřen 2026-09-26 výhradně syntetickými loopback servery: původní 30× timing race,
rozšířená 0–10ms source matrix, úmyslný Playwright route bypass, broker asset/history
happy path a pending selection GET drain. Runtime nově vyžaduje lifetime deny proxy
pro probe. Žádný nový živý LinkedIn běh není touto implementací deklarován; přesné
výsledky eviduje `BACKLOG_PROGRESS.md`: 5 samostatných procesů × 85 timing iterací,
kontroly po cleanupu a úmyslný bypass, všechny foreign/unread hity 0; tři plné
check běhy 165/165 PASS. Review P2 o post-cleanup assertion opraven a re-review
bez otevřených blokujících nálezů. Audity: produkce 0, full 2 známé moderate dev-only.

Nativní podporovaný export je:

```powershell
npm.cmd run export -- --limit 100 --with-history-probe
```

CLI vybírá nejnovější konverzace podle počtu `--limit`. Nemá přepínač `--since` ani
nativní date-range schema. Jeho autoritativní výstup validuje `ExportSchema` ze
`src/domain/schema.ts`; úplnost celého zvoleného rozsahu vyjadřuje `stats.partial`.

## 2. Odvozené exporty od 1. 5. 2026

**Stav těchto výstupů: obsahově vadné, po opravě BL-006 vytvořit znovu nezávislým
exportem; neopravovat incremental mergem.**

Soubory

- `data/linkedin/messages-since-2026-05-01.json`;
- `data/linkedin/messages-since-2026-05-01-updated.json`

nevytvořil přímo nativní `--since` režim. Vznikly následnou lokální transformací
pomocí `jq` nad nativními exporty. Mají vlastní top-level
`exportType: "linkedin-message-date-range"`, metadata `range` a jiné `stats`; kvůli
strict top-level schematu nejsou vstupem pro nativní `ExportSchema` ani pro
`export-store.ts`.

Transformace 2026-09-24 provedla:

1. převod hranice `2026-05-01T00:00:00+02:00` na
   `2026-04-30T22:00:00.000Z`;
2. ověření, že načtený seznam pokračuje alespoň k první konverzaci před hranicí;
3. výběr konverzací aktivních od hranice a zpráv se `sentAt` od hranice včetně;
4. kontrolu timestamps, unikátních ID, vazeb `message.conversationId` a pořadí;
5. pro jeden thread s neprokázanou úplnou starou historií důkaz, že jeho souvislé
   nejnovější okno začíná už v březnu 2024, tedy bezpečně před požadovanou hranicí.

Výsledek měl 126 konverzací, 235 zpráv, 0 neznámých `isStarred` a SHA-256
`eb9ade297ebd2891ce80cfcdf0b7277e3e24a67d3c9639d473b27d926c0d5863`.

Aktualizace 2026-09-25 použila incremental postup:

1. čerstvé konverzace měly přednost podle stabilního conversation ID;
2. z předchozího date-range souboru se zachovaly konverzace, které už nebyly v
   čerstvém lazy-loaded okně;
3. zprávy se znovu omezily hranicí, sekvence přepočítaly a celý výsledek se
   strukturálně ověřil;
4. kontrola našla 7 nových konverzací, 18 nových zpráv a 0 chybějících dříve
   exportovaných zpráv.

Aktualizovaný výsledek má 133 konverzací, 253 zpráv, validní boolean `isStarred` u
všech 133 konverzací a SHA-256
`e211ad71dac33e7eb8c53fd69c41477edca638d250201b97598965a19f8672fe`.

Následná anonymní kontrola našla v aktualizovaném souboru nejméně 107 z 253 zpráv ve
28 konverzacích se silně podezřelým opakováním stejného pracovního subjectu přes
různá message ID, časy a směry. Duplicitní message ID nebyla nalezena; vada byla už
ve `.source.json.partial`, a nevznikla tedy až následným date-range mergem.

### Důležitá hranice tvrzení o úplnosti

První date-range soubor prokazatelně překročil datumovou hranici v jednom načteném
seznamu. Aktualizovaný soubor používá předchozí kompletní date-range baseline a
čerstvé okno 120 nejnovějších konverzací. `range.complete=true` proto znamená
„kompletní podle tohoto incremental date-range postupu“, nikoli nativní
`ExportSchema` důkaz `partial=false` pro globální LinkedIn seznam. Fresh okno samo
2026-09-25 skončilo u aktivity 2026-05-19 a datum 1. 5. nepřekročilo.

Pokud se date-range workflow má stát opakovaně podporovanou funkcí, je potřeba
samostatně implementovat a otestovat nativní `--since` nebo verzovaný transformační
nástroj. Do té doby se ad-hoc `jq` výstup nesmí vydávat za nativní CLI formát.

## 3. Živé běhy a měření

### 2026-09-24

- pokus `--limit 500`: LinkedIn UI načetlo 180 konverzací, 368 zpráv a skončilo na
  list timeoutu; 178 historií bylo úplných a dvě nebyly potvrzené;
- opakování s `--limit 130`: samotný běh zpracoval 130 historií, 129 úplně a jednu
  neúplně; list dosáhl limitu, ale výsledek zůstal `.partial` kvůli jednomu threadu;
- po date-range důkazu vznikl první odvozený soubor 126/235.

### 2026-09-25

- příkaz požadoval `--limit 150`, UI lazy-loading však skončil na 120 konverzacích;
- načteno bylo 254 raw zpráv, 119/120 historií mělo úplný full-history důkaz a jedna
  selhala až při parsování starší stránky; její nejnovější 20zprávové okno sahalo do
  března 2024 a obsahovalo dvě zprávy od požadované hranice;
- raw výsledek správně skončil exit kódem 5 jako `.partial`;
- přesný wall-clock čas jediného `npm.cmd run export` procesu byl
  **00:03:57.842** (`237842 ms`);
- následná `jq` filtrace a incremental merge trvaly **00:00:00.562** (`562 ms`);
- čas LLM uvažování ani následná validační kontrola nejsou v těchto hodnotách.

## 4. Session lifecycle

`.auth/linkedin-storage-state.json` je snapshot cookies a local storage z posledního
`npm.cmd run login`. Je to samostatná LinkedIn session vytvořená v Playwright
Chromium; cookies běžného Chrome ani jeho otevřené taby se nepoužívají.

Současný export storage state pouze načte. Případné cookies obnovené serverem během
exportu používá v aktuálním contextu a jeho přímém request contextu, ale neukládá je
zpět do `.auth/linkedin-storage-state.json`. Snapshot proto může expirovat. Výsledek
je bezpečný `AUTH_REQUIRED`; náprava je znovu spustit `npm.cmd run login`.

Běžné odhlášení jedné relace v normálním Chrome je oddělené. „Odhlásit všechny
relace“, ruční ukončení Playwright relace, bezpečnostní revokace nebo změna hesla s
vynuceným novým přihlášením mohou invalidovat i uložený storage state.

## 5. Co guardy zaručují a co ne

Browser stránka může vytvořit POST nebo WebSocket pokus, ale Playwright guard jej
zachytí před odesláním na síť. Service workery se v exportním contextu nespouštějí.
Neznamená to, že každý blokovaný POST by měnil účet; v živých bězích šlo z velké části
pravděpodobně o telemetrii. Blokace je defense-in-depth proti nejasným nebo omylem
vyvolaným mutacím, nikoli tvrzení, že pouhé čtení běžně hvězdičkuje, reaguje nebo
odesílá zprávy.

Guardy nejsou stealth ani anti-detection mechanismus. LinkedIn může automatizaci
poznat podle navigace, rychlosti a vzoru povolených GET požadavků. Projekt negarantuje
neviditelnost a blokováním telemetrie ji nepředstírá.
