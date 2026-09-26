# Backlog implementation progress

Aktualizováno: **2026-09-26 Europe/Prague**

## Aktuální checkpoint

- **Aktivní položka/fáze:** BL-006 `REVIEW`; BL-007 `DONE`.
- **Poslední runtime commit:** BL-006 `2ab4000`; BL-007 `43ec961`.
- **Worktree:** dirty implementace BL-006 nad resume checkpointem `c490a51`;
  parser, fixtures, testy, safe manual harness a aktivní docs jsou připravené.
- **Subagenti:** BL-006 review dokončeno bez nálezů; BL-007 reviewer diagnostikoval
  popup timing. Následuje jediný fixer pouze testu.
- **Autorizace:** uživatel v této session povolil nezbytné read-only živé LinkedIn
  validační běhy v izolovaném Playwright Chromium. Běžný Chrome nikdy nepoužívat
  ani nezavírat. Živý probe byl během BL-007 zakázán a neproběhl.
- **První další akce:** hlavní agent zkontroluje diff a vytvoří implementation
  checkpoint commit; pak nezávislé review a plná validace. Živý harness až po review.

| Pořadí | Položka | Stav | Zbývá |
| ---: | --- | --- | --- |
| 1 | BL-007 | DONE | Nic; uzavřené testy/review/docs |
| 2 | BL-006 | IMPLEMENTING | Parser/tests/docs, review, živá validace; plán schválen |
| 3 | BL-003 | NOT_STARTED | Nezávislé snapshoty/bundles |
| 4 | BL-005 | NOT_STARTED | Default fresh probe a opt-out |
| 5 | BL-001 | NOT_STARTED | Ověřená jména |
| 6 | BL-002 | NOT_STARTED | Lokální přílohy v bundle |
| 7 | BL-004 | NOT_STARTED | Research-only; neimplementovat funkci |

## BL-006 implementation handoff (2026-09-26)

- Body adapter čte jen body/messageBody/attributedBody/eventContent/content/commentary
  a nakonec explicitní text, bounded depth/visited. Subject a metadata se nepoužívají.
- Attachment adapter čte přímá explicitní attachment metadata a známé renderContent
  media hranice. Obecný renderer type/card title/tracking ID není příloha.
- Generic nested/id-less relevantní kandidáti započítávají miss; stejný wrapped
  objekt se nepočítá znovu jako standalone/nested. Included event s vlastní message
  i conversation identitou se počítá i mimo elements; profily/cards nikoli.
- Nová anonymní Dash InMail fixture a integrační quality gate ověřují exact text,
  ID, čas, inbound/outbound, přílohu, precedence, poison metadata, cyklus, fallback ID
  a subject-only partial bez změny úplného exportu. Žádný schema/policy/CLI upgrade.
- scripts/manual-tests obsahuje explicitní opt-in live test, standalone Vitest config
  a nezávislý counts-only InMail witness. Default test glob jej nespouští; typecheck
  jej kontroluje. Výjimky se převádějí na uzavřené kódy bez původního obsahu.
  Instrukce jsou v docs/OPERATIONS.md; živý test zatím NEPROBĚHL.
- Cílené ověření: typecheck PASS; parser/inmail/history/store/domain/witness
  72/72 PASS ve 6 souborech; git diff --check PASS (jen CRLF upozornění).
- Main full check zatím FAIL v tests/unit/network-diagnostics.test.ts: canary event
  s message URN bez conversation identity nově správně hlásí miss místo 0; ověřit
  očekávání a zachovat redakční assertions. Ostatní výsledky běhu se ještě sbírají.
  Audity znovu: produkce 0, full 2 známé moderate dev-only.
- Běh dokončen 183/184; jediná výše uvedená failure opravena pouze v diagnostickém
  testu, zachované všechny privacy assertions + přidané agregáty. Cíleně 3/3 PASS.
  Následuje opakovaný full check a nezávislé review; živý test stále neproběhl.
- Druhý full check 183/184: diagnostika PASS, nově FAIL popup selection test
  v probe-navigation.test.ts:377. Po pevných 100 ms assertSelectionSafe ještě
  neodmítl; žádný server-hit leak tímto výsledkem doložen není. BL-006 reviewer
  bez blokujících nálezů, nezávisle 22/22 PASS. Před živým během nutno read-only
  diagnostikovat timing popup testu vs skutečnou lifecycle chybu; žádný živý běh
  zatím nespouštět. Jde o nezbytný validační follow-up BL-007, ne další feature BL.
- Read-only diagnostika popupu: původní cílený test FAIL; 20 instrumentovaných
  cyklů vždy foreign server hits 0 a konečné popupPagesBlocked=1/hard=1. V 16/20
  hard událost přišla až po testových 100 ms (cca 96–170 ms po goto).
  Schválený minimální fix: pevný sleep nahradit bounded expect.poll na hard stav,
  zachovat rejection a nulové hity, doplnit kontrolu po cleanupu. Runtime bez změny.
  Potom cílené opakování, nezávislé re-review a plný check před live harness.
- Zbývá: main implementation commit, nezávislé review, opravy/re-review, plný check
  a oba audity, autorizovaný živý export. Obsah starých reálných exportů je nadále
  nedůvěryhodný, BL-006 není DONE. Otevřené findings: review ještě neproběhlo.

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

Přesný další krok: opravit/ověřit diagnostický test z plné validace, pak nezávislé
review, plná validace a nový autorizovaný živý běh. Parser již subject nečte;
staré skutečné exporty však zůstávají obsahově nedůvěryhodné. Živá validace musí
použít novou ignorovanou cestu (před BL-003 nesmí načíst starou baseline).
Obsahová validace pouze anonymními agregáty, žádné zprávy/jména/tokeny do kontextu.

Žádný známý technický blocker; při login/challenge zastavit podle uživatelského
pokynu. Nová session předpokládá, že starý subagent neběží.
