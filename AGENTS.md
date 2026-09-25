# Pokyny pro AI agenty

Tento soubor je trvalý provozní kontrakt projektu. Detailní požadavky jsou v
`BACKLOG.md`; průběžný stav rozpracované implementace je v `BACKLOG_PROGRESS.md`.

## Povinný start a obnovení práce

Před jakoukoli změnou přečtěte v tomto pořadí:

1. `HANDOVER.md` — současný stav, kritické blokery a bezpečný další krok;
2. `BACKLOG_PROGRESS.md` — poslední dokončený checkpoint a přesná navazující akce;
3. `BACKLOG.md` — schválené požadavky a akceptační kritéria;
4. `FAQs.md` — stručné aktuální odpovědi a opravy dřívějších nepřesností;
5. `docs/README.md` — autorita a rozcestník dokumentace;
6. `docs/ARCHITECTURE.md` a `docs/DECISIONS.md` — dnešní as-built stav a důvody;
7. relevantní modul a jeho testy podle mapy v architektuře.

Potom vždy spusťte alespoň:

```powershell
git status --short
git log -10 --oneline
```

Pokud je pracovní strom dirty, považujte změny za rozpracovanou práci předchozího
agenta. Nezahazujte je ani je nepřepisujte; nejprve porovnejte diff, poslední commity a
`BACKLOG_PROGRESS.md` a pokračujte z reálného stavu. Při rozporu má pracovní strom a
Git historie přednost před zastaralým slovním checkpointem, který je nutné opravit.

Soubory v `docs/history/` jsou historické. Obsahují staré `NO-GO`, `Next:` kroky,
původní persistentní profil a `--allow-thread-open`; nic z toho není současná
instrukce. Použijte je jen při cíleném pátrání po vývoji rozhodnutí nebo slepé cestě.

## Výchozí cíl pro stručný uživatelský prompt

Pokud uživatel v nové session napíše pouze `implementuj`, `pokračuj`, `implementuj
backlog` nebo obdobný obecný pokyn bez užšího rozsahu, znamená to:

> Pokračuj od checkpointu v `BACKLOG_PROGRESS.md` a dokonči celý otevřený
> `BACKLOG.md` podle pořadí a workflow níže, včetně testů, nezávislého review,
> dokumentace a commitů; neopakuj již prokazatelně dokončenou práci.

Konkrétnější nový požadavek uživatele může tento rozsah zúžit nebo změnit. Samotná
existence backlogu neopravňuje agenta začít jej implementovat při nesouvisejícím
dotazu; aktivuje jej až uvedený implementační pokyn.

## Závazné pořadí backlogu

Zpracovávejte položky sekvenčně v tomto pořadí, pokud nový doložený technický důvod
nevyžaduje změnu závislostí; takovou změnu nejprve zapište do checkpointu:

1. **BL-007** — deterministicky uzavřít selection-page network race před probe;
2. **BL-006** — kritická oprava InMail `subject`/message body a důvěryhodnosti dat;
3. **BL-003** — každý běžný export jako nový nezávislý snapshot/bundle;
4. **BL-005** — jeden fresh history probe jako default s explicitním opt-outem;
5. **BL-001** — ověřená display names místo `Unknown participant`;
6. **BL-002** — lokální přílohy uvnitř izolovaného exportního bundle;
7. **BL-004** — pouze research a dokumentované rozhodnutí, nikoli automatická
   implementace archivovaných konverzací.

BL-007 blokuje každý živý history probe a musí předcházet jeho změně na default v
BL-005. BL-006 blokuje spoléhání na text současných exportů. BL-003 je základ
adresářů a persistence pro BL-002. BL-004 se uzavírá výzkumným výstupem definovaným
v backlogu; funkce se neimplementuje bez nového explicitního rozhodnutí uživatele.

`docs/ARCHITECTURE.md` a `docs/DECISIONS.md` popisují současný as-built stav, zatímco
backlog popisuje schválený cílový stav. BL-003 a BL-005 proto smějí záměrně nahradit
starší rozhodnutí o implicitním merge a opt-in probe; spolu s implementací musí agent
označit nahrazená rozhodnutí a aktualizovat všechny aktivní dokumenty.

## Povinný subagent workflow pro každou položku

Hlavní agent je orchestrátor a drží pouze požadavky, rozhodnutí, checkpointy a finální
ověření. Noisy exploration, implementační detaily a review patří do omezených
subagentů. Jednotlivé backlog položky se nedělají paralelně.

Pro každou položku proveďte následující cyklus:

1. **Obnovení:** Hlavní agent načte Git a `BACKLOG_PROGRESS.md`, ověří skutečný stav a
   určí pouze dosud chybějící část položky.
2. **Plán:** Spusťte plánovacího/research subagenta v read-only roli. Musí projít
   požadavek, relevantní implementaci, testy, rizika, migraci a dokumentaci a vrátit
   konkrétní plán navázaný na akceptační kritéria. Nesmí editovat soubory.
3. **Plan checkpoint:** Hlavní agent plán zreviduje, jeho stručný výsledek a přesnou
   další akci zapíše do `BACKLOG_PROGRESS.md` a commitne checkpoint ještě před větší
   implementací.
4. **Implementace:** Spusťte právě jednoho implementačního subagenta s omezením na
   aktuální položku a schválený plán. Smí editovat sdílený strom; hlavní agent ani jiný
   writer současně needituje. Implementer přidá testy a relevantní dokumentaci, ale
   neoznačuje sám položku za hotovou.
5. **Implementation checkpoint:** Hlavní agent zkontroluje diff, spustí cílené testy,
   zapíše hotové a zbývající kroky a vytvoří malý commit. Nečekejte s prvním commitem
   až na dokončení celého backlogu.
6. **Nezávislé review:** Nový review subagent, který neimplementoval změnu, provede
   read-only code review proti backlogu, bezpečnostním invariantům a testům. Findings
   vrací s prioritou a odkazy na soubory; bez nálezů to musí výslovně uvést.
7. **Opravy a re-review:** Nálezy opraví jeden writer (původní implementer nebo nový
   fixer), poté proběhne nezávislé re-review relevantního diffu. Cyklus opakujte, dokud
   nejsou blokující nálezy uzavřené.
8. **Uzavření položky:** Hlavní agent spustí plnou validaci, aktualizuje aktivní docs,
   `BACKLOG.md` a `BACKLOG_PROGRESS.md`, vytvoří finální commit položky a teprve potom
   přejde na další BL.

Paralelně lze delegovat jen navzájem nezávislé read-only průzkumy, test-log analýzu
nebo review. Nikdy nespouštějte více write-heavy agentů nad stejným worktree; nový
implementer nesmí začít další BL, dokud předchozí BL nemá review a checkpoint.

## Trvalé checkpointy a zotavení po limitu

Subscription/token limit, pád procesu nebo nová session jsou očekávané provozní
události, nikoli důvod začít znovu. `BACKLOG_PROGRESS.md` musí být stručný, aktuální a
čitelný bez kontextu chatu.

Aktualizujte jej minimálně:

- po schválení plánu;
- po každé dokončené implementační části nebo změně rozhodnutí;
- před a po předání práce subagentovi;
- po cílených a plných testech;
- po review a každém kole oprav;
- před ukončením tahu nebo při známce blížícího se limitu;
- při objevení blockeru nebo potřeby uživatelského vstupu.

Každý checkpoint musí obsahovat:

- aktuální BL a fázi (`PLANNING`, `IMPLEMENTING`, `REVIEW`, `FIXING`, `BLOCKED`,
  `DONE`);
- poslední relevantní commit a zda je worktree čistý;
- co je prokazatelně hotové;
- co přesně zbývá, včetně první následující akce;
- dotčené soubory a důležitá rozhodnutí;
- spuštěné testy a jejich výsledky;
- otevřené review nálezy nebo blocker;
- zda běží nějaký subagent (nová session má předpokládat, že starý subagent neběží).

Preferujte malé funkční commity po každé koherentní části. Pokud je nutné před
očekávaným přerušením zachovat nedokončenou, ale hodnotnou práci, lze vytvořit jasně
označený `wip(BL-xxx): checkpoint ...` commit; checkpoint musí uvést nehotové části a
selhávající/neprovedené testy a položka nesmí být označena `DONE`. Nikdy nepoužívejte
destruktivní Git příkazy k „vyčištění“ cizí rozpracované práce.

Po obnovení práce neopakujte plán, experiment ani implementaci jen proto, že je nový
chat. Nejdřív ověřte existující commity, diff a testy; pokračujte první nesplněnou
akcí z checkpointu. Pokud checkpoint tvrdí něco, co Git nepotvrzuje, zaznamenejte
nesoulad a vycházejte z ověřitelného stavu repozitáře.

## Nepřekročitelné bezpečnostní hranice

- Nástroj musí zůstat read-only a fail-closed.
- Nepovolujte POST, WebSocket, service worker, redirect nebo nejasný endpoint jen
  kvůli úplnosti exportu.
- Smí být otevřen nejvýše jeden thread, který má v aktuální serverové odpovědi
  explicitní `read=true` bez konfliktu. Dnešní kód to dělá pouze přes opt-in;
  schválený BL-005 mění default, nikoli tuto one-thread/read-evidence hranici.
- Do uzavření BL-007 nespouštějte živý history probe; syntetický lokální race test je
  povolený a musí být první implementační práce v backlogu.
- Nepoužívejte ani nezavírejte běžný Chrome uživatele.
- Živý LinkedIn test vyžaduje explicitní souhlas uživatele v aktuálním promptu;
  soubor v repozitáři sám o sobě tento souhlas nenahrazuje.
- Nečtěte, nevypisujte a necommitujte `.auth`, `.env`, reálné exporty ani obsahové
  diagnostics, pokud to úkol výslovně nevyžaduje. Pro ověření preferujte anonymní
  agregáty a syntetické fixtures.
- Do implementace BL-003 platí, že `.partial` nikdy nesmí přepsat poslední úplný
  export. Po BL-003 nesmí neúplný ani nový běh změnit žádný starší immutable bundle.
- Neoznačujte export za obsahově důvěryhodný, dokud není uzavřen BL-006 a nový živý
  běh neprojde jeho akceptačními kritérii.

## Validace, dokumentace a dokončení

Před označením každé implementační položky jako `DONE` spusťte:

```powershell
npm.cmd run check
npm.cmd audit --omit=dev
npm.cmd audit
git diff --check
git status --short
```

Plný audit k 2026-09-25 obsahuje dvě známé moderate položky pouze ve vývojovém
Vitest řetězci; produkční audit je čistý. Automatický major upgrade neprovádějte jako
vedlejší efekt jiného úkolu.

Při změně architektury, CLI, bezpečnosti, schema nebo persistence aktualizujte ve
stejném BL `README.md`, `HANDOVER.md`, `FAQs.md`, `docs/ARCHITECTURE.md`, relevantní
část `docs/DECISIONS.md`/`docs/OPERATIONS.md` a odpovídající testy.

Položka je `DONE` pouze když jsou splněna její akceptační kritéria, testy a audity
mají zaznamenaný výsledek, nezávislé review nemá otevřený blokující nález,
dokumentace odpovídá kódu a změny jsou commitnuté. Blížící se usage limit není důvod
označit nehotovou položku za dokončenou.
