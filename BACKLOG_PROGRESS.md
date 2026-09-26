# Backlog implementation progress

Aktualizováno: **2026-09-26 Europe/Prague**

## Aktuální checkpoint

- **Aktivní položka/fáze:** BL-006 `IMPLEMENTING`; BL-007 `DONE`.
- **Poslední runtime commit:** `43ec961`; P2 test fix `27b9fc4`.
- **Worktree:** ověřen čistý na `adfb919`; předchozí implementer před usage limitem
  neuložil žádnou změnu. Schválený plán se neopakuje.
- **Subagenti:** read-only `bl006_plan` dokončen; obnovuje se jediný `bl006_impl`.
- **Autorizace:** uživatel v této session povolil nezbytné read-only živé LinkedIn
  validační běhy v izolovaném Playwright Chromium. Běžný Chrome nikdy nepoužívat
  ani nezavírat. Živý probe byl během BL-007 zakázán a neproběhl.
- **První další akce:** implementovat commitnutý plán BL-006;
  neopakovat hotovou BL-007 implementaci ani její testy bez nové příčiny.

| Pořadí | Položka | Stav | Zbývá |
| ---: | --- | --- | --- |
| 1 | BL-007 | DONE | Nic; uzavřené testy/review/docs |
| 2 | BL-006 | IMPLEMENTING | Parser/tests/docs, review, živá validace; plán schválen |
| 3 | BL-003 | NOT_STARTED | Nezávislé snapshoty/bundles |
| 4 | BL-005 | NOT_STARTED | Default fresh probe a opt-out |
| 5 | BL-001 | NOT_STARTED | Ověřená jména |
| 6 | BL-002 | NOT_STARTED | Lokální přílohy v bundle |
| 7 | BL-004 | NOT_STARTED | Research-only; neimplementovat funkci |

## BL-007 uzavřené rozhodnutí a důkazy

Instalovaný Playwright při zániku frame může pokračovat přes Fetch.continueRequest
před aplikační Route; přesné CDP pořadí původního incidentu není zachyceno.
Probe-only lifetime loopback deny proxy nemá upstream a je instalovaná před první
page. Dokumenty/API/assets jdou izolovanými brokery bez redirectů. Selection
generation se revokuje synchronně a znovu kontroluje těsně před GETem; bounded drain
předchází target page. Finální hard audit vzniká po context.close.

Soubory: src/browser/probe-transport.ts, context.ts, src/linkedin/probe.ts,
probe-navigation.ts, tests/integration/probe-navigation.test.ts a aktivní docs.
CLI/data schema se nemění. Živá kompatibilita přísných asset pravidel se má ověřit
při BL-006; kvůli úplnosti nepovolovat nejasné endpointy/redirect/POST/WS/SW.

- Baseline 157/157 PASS.
- Po implementaci dva plné check běhy 165/165 PASS; po P2 test fixu třetí plný
  check 165/165 PASS včetně typecheck/build.
- Finálních 5 oddělených Vitest procesů po P2 opravě: všechny PASS; každý
  původních 30 + nových 55 timing iterací (fetch/keepalive/image/iframe/worker,
  0–10ms) a úmyslný route bypass HTTP loopback/HTTPS CONNECT.
  Foreign/unread server hits vždy 0 včetně cleanupu poslední iterace.
- Další testy: protected context, asset/history happy path, redirect denial,
  in-flight drain, queued generation revocation, audit po dispose.
- Nezávislé review: jeden P2 (chybějící post-cleanup assertion); opraven v
  `27b9fc4`, nezávislé re-review bez otevřených blokujících nálezů.
- Audity: prod 0; full 2 známé moderate dev-only Vitest položky, exit 1.
- git diff --check PASS; žádná auth/env/export/obsahová diagnostics v Gitu.

## BL-006: dosud chybějící práce

### Schválený plán (2026-09-26)

1. Omezený body adapter, dokumentovaná priorita body/messageBody/attributedBody/
   eventContent/content/commentary a explicitní text; pouze známé obálky a textová
   pole, bounded depth/visited. Subject/title/headline/names nikdy nejsou body.
   Subject do schema nepřidávat; schema v1 ponechat.
2. Uzavřít falešný attachment-only úspěch z libovolného renderContent.type,
   tracking ID nebo title karty. Zachovat známý content.file a skutečné explicitní
   attachments. Pouhý subject a obecný renderer musí být miss.
3. Prověřit wrapped/standalone/referenced i generic nested/id-less candidate misses;
   nevynechat subject-only event, nedvojit miss již zpracovaného objektu.
4. Anonymní InMail fixture: stejné subjecty, odlišné inbound/outbound bodies,
   ID/čas/směr/příloha. Quality gate až přes normalizaci a persistence; poison
   metadata, whitespace/unknown wrapper, precedence, fallback ID nezávislé na
   subjectu, skutečný body shodný se subjectem je validní. Subject-only způsobí
   partial a nezmění předchozí úplný JSON.
5. Aktivní docs popíší adapter, staré vadné exporty a známý minimální dopad.
   Žádná BL-003 persistence změna ani oprava starých exportů mergem.
6. Cílené parser/domain/history/store testy, implementation commit, nezávislé
   review, plný check/audity a opravy podle AGENTS.md.
7. Explicitní live validační harness mimo default test glob: wrapper skutečného
   parseru zachytí pouze v paměti očekávané body z nezávislých známých paths a
   srovná přes stabilní ID s výsledným exportem. Výstup jen anonymní agregáty,
   žádné bodies/jména/credentials/URL. Nová neexistující ignorovaná output cesta,
   žádná baseline; --with-history-probe --limit 100, bez diagnostics-content.
   Živý běh až po opravě/review; user autorizace platí. Zero InMail samples,
   neshody nebo nepodporované relevantní eventy nejsou důkaz opravy. Login/challenge
   či skutečný hard safety blocker vyžaduje zastavení. Partial kvůli page coverage
   vyhodnotit odděleně od správnosti textu.

Přesný další krok: jediný implementer provede body/miss/attachment opravu, fixtures,
quality gate, docs a safe live harness; sám živý test nespouští a neoznačuje DONE.

Parser stále přijímá top-level subject jako Message.text. Staré skutečné exporty
jsou obsahově nedůvěryhodné. Planner má mapovat přesné podporované body wrappers,
subject-only parser misses/completeness, anonymní inbound/outbound/attachment
regresi a quality gate. Po implementaci a review nový nezávislý živý export do
nové ignorované cesty (před BL-003 ještě nesmí načíst starou baseline).
Obsahová validace pouze anonymními agregáty, žádné zprávy/jména/tokeny do kontextu.

Žádný známý technický blocker; při login/challenge zastavit podle uživatelského
pokynu. Nová session předpokládá, že starý subagent neběží.
