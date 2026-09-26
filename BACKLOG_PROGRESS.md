# Backlog implementation progress

Aktualizováno: **2026-09-26 Europe/Prague**

## Aktuální checkpoint

- **Aktivní položka/fáze:** BL-006 `REVIEW`; BL-007 `DONE`.
- **Poslední runtime commit:** BL-006 `2ab4000`; BL-007 `43ec961`.
- **Worktree:** čistý na `5cd8359` před tímto checkpointem.
- **Subagenti:** žádný; diagnostické review dokončeno bez blokujících nálezů.
- **Autorizace:** uživatel v této session povolil nezbytné read-only živé LinkedIn
  validační běhy v izolovaném Playwright Chromium. Běžný Chrome nikdy nepoužívat
  ani nezavírat. Živý probe byl během BL-007 zakázán a neproběhl.
- **První další akce:** read-only diagnostika bezpečně odmítnutého asset brokeru
  při živém validačním běhu; další live až po vysvětlení příčiny bez oslabení policy.

| Pořadí | Položka | Stav | Zbývá |
| ---: | --- | --- | --- |
| 1 | BL-007 | DONE | Nic; uzavřené testy/review/docs |
| 2 | BL-006 | REVIEW | Implementace/review/check PASS; zbývá živý obsahový důkaz a closure |
| 3 | BL-003 | NOT_STARTED | Nezávislé snapshoty/bundles |
| 4 | BL-005 | NOT_STARTED | Default fresh probe a opt-out |
| 5 | BL-001 | NOT_STARTED | Ověřená jména |
| 6 | BL-002 | NOT_STARTED | Lokální přílohy v bundle |
| 7 | BL-004 | NOT_STARTED | Research-only; neimplementovat funkci |

## BL-006 implementation handoff (2026-09-26)

**Živý pokus 2026-09-26 16:22:45Z–16:22:57Z:** explicitní harness FAIL
READ_POLICY_BLOCK. Redigovaná evidence: selectionPreflight=1/navigation=1,
targetPreflight=0/threadNavigations=0, transportDenied=0, hard=1,
reason blocked-subrequest:asset-broker, list rows/conversations=0.
Žádný obsahový důkaz ani export nevznikl. Není doložen transport escape ani login;
broker nezaznamenal svůj konkrétní bezpečný failure enum. Nový read-only follow-up
BL-007 reviewer navrhne nejmenší diagnostiku/status/timeout/MIME bez osobních dat.
Nepovolovat redirect/nový endpoint ani běžný Chrome. BL-006 zůstává nedokončený.

Schválená diagnostická oprava po read-only review: asset větev zahazuje existující
proxied.failure. Přidat assetProxyFailures do snapshotu/manifestu jako uzavřené
status-NNN/redirect/content-type/declared-size/body-size/generation-retired/timeout/
request-error + pevný resource typ, případně MIME kategorii. Žádná raw URL/header/
exception/body. Timeout rozlišit errors.TimeoutError. Zachovat hard failure a
všechny síťové hranice. Jeden fixer, syntetické status/redirect/MIME/timeout canary
testy, nezávislé review a full check před jedním dalším autorizovaným live pokusem.

Diagnostická oprava hotová: assetProxyFailures nese pouze resource enum a failure
enum; uloží se do manifestu jako probe-asset-proxy-failure. Žádná změna policy.
Main full check PASS188/188 + typecheck/build; čtyři nové status/redirect/MIME/
5s timeout testy včetně privacy canary a post-cleanup hit0. Fixer narazil na limit
po runtime/test části; main doplnil docs. Commit5cd8359 nezávisle zrevidován bez
nálezů; nyní jeden další autorizovaný counts-only live pokus beze změny policy.

Druhý live pokus 2026-09-26 16:38:14Z–16:38:27Z: opět bezpečně odmítnut před
targetem, transportDenied0/targetnav0; konkrétní příčina **script:body-size**.
Sdílený 16MiB API limit odmítl rozbalený statický JS, nikoli endpoint/redirect/login.
Následuje read-only plán odděleného omezeného script limitu; API/doc limity zůstávají.
Další live až po implementaci, syntetické velikostní regresi a nezávislém review.

Schválený plán po read-only review: script asset cap32MiB pro declared i actual
bytes; API/ostatní assets16MiB, dokument8MiB beze změny. Size failures smějí nést
pouze numeric actualBytes nebo declaredBytes + limitBytes, žádné raw hodnoty.
Testy17MiB script execute,17MiB API deny,script>32 deny včetně gzip/decompressed
limitu a canary redakce. Playwright stále bufferuje; cap je limit přijetí, nikoli
tvrdý RAM limit. 32MiB nemusí živý zdroj pokrýt; další změna jen podle evidence.

Fixer nad `7f2cba1` dokončil script-only 32MiB cap, numeric size diagnostics,
manifest a aktivní docs. Typecheck PASS; čtyři nové integrační testy PASS:17MiB
script execute +17MiB API deny,33MiB declared/gzip script deny,17MiB stylesheet deny.
Canary absence a post-cleanup foreign hits0 ověřeny. Worktree dirty pouze tato
koherentní změna; žádný live/fullcheck/commit/DONE fixer neprovedl. Následuje main
diff/implementation commit, nezávislé review a full check; fixer již neběží.

**Nejnovější validace:** HEAD `93b18cd`, `npm.cmd run check` PASS 184/184,
typecheck/build PASS. Nezávislé BL-006 review bez nálezů (22/22 vlastních testů).
Oba popup testové timing nálezy opraveny (`8b63737`, `93b18cd`), každý s cílenými
opakovanými procesy a nezávislým re-review bez nálezů; runtime beze změny.
Audity: prod 0, full 2 známé moderate dev-only. Live test začne až po tomto commitu.

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
  Instrukce jsou v docs/OPERATIONS.md; první živý test skončil bezpečně před targetem
  (viz aktuální evidence výše), obsahová validace stále chybí.
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
- Po opravě selection popupu (`8b63737`, re-review bez nálezů) fullcheck183/184
  našel obdobný testový race u target=_blank popupu ř.629: snapshot hard=0 byl
  přečten před async assertTargetSafe, které už správně odmítlo READ_POLICY_BLOCK.
  Žádný doložený server leak. Před live nutno opravit i tento test na konečný
  pozorovaný stav, ponechat server-hit-0 a nezávisle zrevidovat.
- Test-only follow-up nad `590d1c3`: target=_blank fixture vždy kliká link; test nyní
  bounded poll čeká na hard state (2 s), vyžaduje rejection a právě jednu target
  navigaci. Nulové unread/target server hity ověřuje i po context cleanupu.
  Tři samostatné cílené procesy selection location/popup + target popup PASS 3/3
  každý. Runtime beze změny; dirty pouze tento checkpoint a probe-navigation test.
  Fixer skončil; main následuje kontrolou diffu/commitem, re-review a full checkem.
- Test-only fixer nad `df6a968`: selection location/popup nyní čeká přes
  `expect.poll` nejvýše 2 s na hard state; rejection zůstává a po dispose/context.close
  ověřuje nulový unread server count i nepřítomný target hit. Dispose toleruje již
  uzavřený context stejně jako afterEach (popup fail-closed jej může zavřít sám).
  Tři samostatné cílené Vitest procesy PASS 2/2 každý. Runtime se neměnil.
  Worktree dirty pouze test a tento checkpoint; fixer skončil. Další akce: main
  zkontroluje diff, commitne test checkpoint, nezávislé re-review a full check.
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
