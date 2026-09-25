# Backlog

Tento soubor obsahuje požadované budoucí změny, které nejsou součástí aktuálního
hotového baseline. Položka se smí označit jako dokončená až po implementaci, testech,
review a odpovídající aktualizaci dokumentace.

## BL-001 — Doplnit skutečná jména místo `Unknown participant`

- **Stav:** TODO
- **Priorita:** vysoká
- **Požadavek uživatele:** Ve zprávách a účastnících exportu získat zobrazované jméno,
  které je vidět v LinkedIn Messages, místo současného `Unknown participant`.

### Kontext

Historie zpráv často obsahuje stabilní sender/participant ID, ale ne display name ve
stejném objektu. LinkedIn UI jméno zná z conversation-list, profile nebo included
entity dat. Současný enrichment je doplní jen při bezpečné jednoznačné shodě; při
nejistotě správně ponechá `Unknown participant`. Živý běh 2026-09-25 zaznamenal
`DOM_PREVIEW_NAME_AMBIGUOUS`. Neznámé jméno se může objevit i u vlastní odchozí
zprávy, přestože identita účtu je známá.

### Požadované řešení

1. Zmapovat všechny důvěryhodné zdroje jména v aktuálních list/history/profile
   network odpovědích a propojit je přes stabilní person/profile ID nebo URN.
2. Propagovat ověřené jméno do `Participant.name` a `Message.senderName` ve všech
   zprávách stejné identity.
3. Pro vlastní sender ID vždy použít ověřené jméno exportovaného účtu.
4. DOM enrichment ponechat pouze jako bezpečný fallback s jednoznačnou vazbou na
   conversation ID; jméno nikdy nehádat z podpisu, textu zprávy nebo pořadí řádků.
5. Při konfliktu zdrojů zachovat fail-closed `Unknown participant` a uložit pouze
   redigovaný diagnostický důvod.

### Akceptační kritéria

- Jméno viditelné v LinkedIn Messages a dostupné v zachycených důvěryhodných datech
  se objeví u odpovídajícího participant ID i všech jeho zpráv.
- Vlastní odchozí zprávy nepoužívají `Unknown participant`, pokud je účet bezpečně
  identifikovaný.
- Stejné jméno se nesmí přiřadit jiné osobě pouze podle textu, preview nebo podpisu.
- Group konverzace, stejné preview texty, chybějící profilová entita a konfliktní
  evidence mají samostatné testy.
- Parser, normalizace a merge mají unit testy; integrační fixture ověří oddělenou
  profile entity a propagaci jména do historie.
- Read-only politika se nemění: žádné nové POSTy, WebSockety, service workery ani
  otevírání dalších threadů.
- Živá validace se provede jen s explicitním souhlasem uživatele a porovná anonymní
  počty `Unknown participant` před/po bez logování jmen nebo textů zpráv.
- `npm.cmd run check`, nezávislé code review a relevantní dokumentace projdou před
  uzavřením položky.

### Pravděpodobně dotčené oblasti

- `src/linkedin/network/response-parser.ts`
- `src/linkedin/exporter.ts`
- `src/linkedin/dom/conversation-list.ts`
- `src/domain/normalize.ts`
- anonymní parser/domain/integration fixtures v `tests/`

## BL-002 — Volitelné lokální stažení příloh do adresáře konkrétního exportu

- **Stav:** TODO
- **Priorita:** vysoká
- **Požadavek uživatele:** CLI export má vedle metadat příloh ukládat i jejich
  skutečný obsah lokálně. Stahování má být výchozí chování, ale uživatel je musí moci
  pro konkrétní běh vypnout. Každý běh musí mít vlastní jednoznačný adresář, aby se
  soubory z různých exportů nemíchaly ani nepřepisovaly.

### Kontext

Současný `AttachmentSchema` uchovává pouze volitelné `id`, `name`, `type` a LinkedIn
`url`; žádná data příloh se nestahují. Browser context má záměrně vypnuté browserové
downloady. Implementace proto nesmí pouze povolit nekontrolované UI downloady, ale má
použít samostatný, auditovatelný read-only tok pro ověřené attachment GET endpointy.

### Požadované řešení

1. Přidat jednoznačný CLI opt-out, například `--no-download-attachments`; bez něj se
   přílohy stahují. Stejný default a případnou env konfiguraci popsat v uživatelské
   dokumentaci.
2. Každému exportnímu běhu vytvořit nový collision-resistant run/bundle adresář
   odvozený od UTC času a náhodného run ID. JSON a/nebo jeho attachment root musí
   tento adresář jednoznačně identifikovat. Opakovaný export do stejného `--output`
   nesmí použít adresář minulého běhu ani přepsat jeho přílohy.
3. Přílohy stahovat streamovaně pouze pomocí povoleného autentizovaného `GET` přes
   explicitní allowlist originů a cest. Zachovat fail-closed pravidla: žádný POST,
   WebSocket, service worker, automatický redirect ani neověřený endpoint. Browserové
   downloady zůstanou vypnuté.
4. Rozšířit verzované exportní schema tak, aby u každé přílohy bylo bez hádání vidět,
   zda byla stažena, a úspěšný záznam obsahoval relativní `localPath`, počet bajtů,
   skutečný content type a SHA-256. Nestáhnutá nebo chybová příloha musí mít explicitní
   stav a redigovaný důvod; nesmí předstírat existující lokální soubor.
5. Vztah musí být dohledatelný přímo z JSON: konkrétní
   `conversationId` → `message.id` → attachment `id` (nebo deterministický fallback)
   → právě jeden soubor uvnitř attachment rootu daného běhu. Stejná příloha opakovaná
   v jednom výsledku se může uložit jednou, ale všechny odkazy musí mířit na stejnou
   ověřenou cestu.
6. Název souboru vytvořit z bezpečně sanitizovaného původního jména a stabilního
   ID/hash suffixu. Odstranit path separátory, řídicí znaky, `.`/`..`, Windows reserved
   names a koncové tečky/mezery; omezit délku a ověřit příponu vůči skutečnému typu.
   Výsledná absolutní cesta musí po resolve zůstat uvnitř run adresáře a nesmí
   procházet symlinkem.
7. Použít dočasný soubor a atomické dokončení až po kontrole limitu velikosti,
   skutečného počtu bajtů a hashe. Kolize názvů řešit deterministickým suffixem, nikdy
   přepsáním existujícího souboru. Přerušený běh nesmí vydávat torzo za úspěšnou
   přílohu ani poškodit dřívější exportní bundle.

### Akceptační kritéria

- `npm.cmd run export -- --limit N` se pokusí stáhnout všechny podporované přílohy ve
  výsledném exportu; explicitní opt-out nestáhne žádné bajty a zachová jejich síťová
  metadata v JSON.
- Dva po sobě jdoucí exporty, včetně běhů se stejným `--output`, vytvoří dva různé
  run adresáře. Žádný soubor ani JSON reference z prvního běhu se nepřepíše druhým.
- Každý úspěšný `localPath` je relativní, přenositelný a po resolve ukazuje na
  existující soubor uvnitř správného run adresáře; uložená délka a SHA-256 odpovídají
  skutečným bajtům.
- Dvě přílohy se stejným názvem, příloha bez názvu i nebezpečné názvy typu
  `../CON.pdf` dostanou bezpečné a nekolidující cesty. Testy pokryjí také velmi dlouhé
  Unicode jméno, case-insensitive kolizi a opakovaný attachment ID.
- Redirect, nepovolený origin/path, HTML/login odpověď místo souboru, nesoulad typu či
  délky, překročení konfigurovaného size limitu a přerušený stream skončí fail-closed.
  JSON uvede redigovaný neúspěch a CLI nesmí oznámit plný úspěch požadovaného
  attachment exportu; poslední úplný bundle zůstane nedotčený.
- Download log ani diagnostics neobsahují signed query, cookies, tokeny, názvy příloh
  nebo lokální cesty s osobními údaji. Výchozí i vlastní attachment adresáře jsou
  pokryté `.gitignore` nebo výrazným varováním u umístění mimo `data/linkedin/`.
- Unit testy pokryjí CLI default/opt-out, schema, sanitizaci, containment, deduplikaci
  a collision handling. Integrační test s lokálním HTTP serverem pokryje streamovaný
  GET, autentizační hlavičky bez úniku, odmítnutí redirectu/chybné odpovědi, atomický
  zápis a izolaci dvou běhů.
- Před uzavřením položky projdou `npm.cmd run check`, oba audity, nezávislé code
  review a aktualizace `README.md`, `HANDOVER.md`, `docs/ARCHITECTURE.md` a
  `docs/DECISIONS.md`. Živá LinkedIn validace proběhne jen s explicitním souhlasem
  uživatele a bez použití či zavření jeho běžného Chrome.

### Pravděpodobně dotčené oblasti

- `src/config.ts`, `src/cli.ts`
- nový izolovaný attachment downloader v `src/linkedin/network/` nebo `src/io/`
- `src/linkedin/exporter.ts`
- `src/domain/schema.ts`, normalizace a merge
- `src/io/export-store.ts`, `.gitignore`
- unit a integrační testy v `tests/`

## BL-003 — Každé běžné spuštění vytvoří nezávislý exportní snapshot

- **Stav:** TODO
- **Priorita:** kritická
- **Požadavek uživatele:** Běžné spuštění CLI musí vždy vytvořit úplně nový export
  obsahující pouze data získaná v daném běhu. Nesmí automaticky načíst, mergovat ani
  jinak použít žádný dřívější export. Inkrementální skládání musí být samostatný,
  vědomě zvolený režim.

### Kontext

Současné výchozí chování používá opakovaně `data/linkedin/messages.json`, načte
existující validní export a sloučí jej s novým výsledkem. Snapshot recovery navíc může
za přísných podmínek převzít starší historii stejného threadu. To neodpovídá očekávané
semantice „spustím export dnes a za měsíc dostanu nový nezávislý snapshot“ a může v
novém souboru zachovat záznamy, které aktuální běh vůbec nenačetl.

### Požadované řešení

1. Každé běžné spuštění bez zvláštního merge přepínače vytvoří nový collision-resistant
   run/bundle adresář a nový JSON soubor, například pomocí UTC času a náhodného run ID.
   Výstup jiného běhu se nikdy automaticky nepoužije jako vstup.
2. Výchozí snapshot obsahuje výhradně konverzace a zprávy načtené a ověřené během
   aktuálního běhu a zvoleného scope. Starší nepřekrývající se záznamy se nesmějí
   přenášet jen proto, že existují v předchozím souboru.
3. Explicitní `--output` nesmí potichu přepsat ani sloučit existující bundle. Při kolizi
   má CLI bezpečně selhat nebo vytvořit jednoznačně nový run podle jasně dokumentované
   volby; žádné chování nesmí záviset na skrytém automatickém merge.
4. Zachování nebo rozšíření předchozí historie bude dostupné pouze přes explicitní
   režim, například `--incremental-from <export.json>`. Výstup musí v audit metadatech
   uvést incremental režim, identitu/hash baseline a oddělit fresh a převzaté počty.
5. `.partial` a další pracovní soubory musí patřit právě jednomu runu. Nesmějí se stát
   automatickým vstupem pozdějšího nezávislého exportu; případné resume stejného běhu
   musí mít samostatnou explicitní a auditovatelnou semantiku.
6. Snapshot recovery z předchozího `messages.json` odstranit z defaultní cesty. Pokud
   zůstane podporovaný, smí se aktivovat pouze uvnitř explicitního incremental/resume
   režimu a musí zachovat současné fail-closed důkazy úplnosti.
7. Sladit návrh s BL-002: JSON i stažené přílohy jednoho běhu patří do stejného
   izolovaného bundle adresáře a další export je nikdy nepřepíše.

### Akceptační kritéria

- Dvě běžná spuštění po sobě vytvoří dva různé bundle adresáře a dva nezávislé JSON
  snapshoty; druhý běh nečte JSON ani `.partial` prvního běhu.
- Zpráva přítomná pouze v prvním exportu se bez aktuální serverové evidence neobjeví ve
  druhém nezávislém snapshotu. Aktuálně znovu načtená zpráva obsahuje aktuální text a
  metadata z LinkedIn, nikoli starou uloženou variantu.
- Síťově nebo parserově neúplný běh zůstane jasně označený jako neúplný uvnitř svého
  vlastního bundle; nesmí se maskovat daty z minulého exportu ani změnit starší bundle.
- Incremental výsledek vznikne pouze po explicitním přepínači s konkrétní baseline.
  Test prokáže, že bez přepínače se baseline neotevře ani při shodné dřívější cestě.
- CLI výstup jednoznačně vypíše cestu nového JSON/bundle a použitý režim (`snapshot`,
  `incremental`, případně explicitní `resume`).
- Unit a integrační testy pokryjí dva nezávislé běhy, kolizi `--output`, zákaz implicitního
  merge, explicitní incremental režim, partial izolaci a čerstvou aktualizaci textu.
- Aktualizovat `README.md`, `HANDOVER.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`
  a `docs/OPERATIONS.md`; staré rozhodnutí o implicitním merge označit jako nahrazené,
  ne je ponechat jako aktuální provozní doporučení.

### Pravděpodobně dotčené oblasti

- `src/config.ts`, `src/cli.ts`
- `src/linkedin/exporter.ts`
- `src/domain/merge.ts`
- `src/io/export-store.ts`
- exportní schema/audit metadata a testy v `tests/`
- aktuální uživatelská, architektonická a provozní dokumentace

## BL-004 — Research podpory archivovaných konverzací

- **Stav:** RESEARCH / volitelné
- Ověřit bez mutace účtu, zda a jak LinkedIn zpřístupňuje archivované konverzace přes bezpečné read-only GET odpovědi, jak se odlišují od inboxu a zda je současný export již částečně zachycuje.
- Výstupem má být pouze dokumentované zjištění, rizika a návrh případného explicitního CLI scope; implementace ani rozhodnutí funkci zařadit nejsou součástí tohoto tasku.

## BL-005 — History probe jako výchozí chování nového exportu

- **Stav:** TODO
- **Priorita:** vysoká
- Běžný nový export má automaticky v izolovaném Chromium contextu otevřít právě jeden serverem potvrzeně přečtený thread, odpozorovat aktuální read-only history GET kontrakt (`queryId`, proměnné, hlavičky a stránkovací tvar) a ten použít pro přímé autentizované GET načtení vybraných konverzací.
- Současný opt-in `--with-history-probe` změnit na výchozí režim a nabídnout jasný opt-out, například `--no-history-probe`; bez probe smí nástroj označit export za úplný pouze tehdy, když pasivní odpovědi samy prokážou úplnost historií.
- Zachovat stávající bezpečnostní hranice: thread musí být potvrzeně přečtený v aktuální serverové odpovědi, probe se nesmí opakovat ani otevřít více threadů, získaný kontrakt platí pouze pro daný běh a žádný mutační request se nesmí odeslat.
- Testy a dokumentace musí ověřit nový default, explicitní opt-out, jeden probe na běh, fresh odpozorování kontraktu, fail-closed chování a soulad s nezávislými snapshoty z BL-003.

## BL-006 — KRITICKÉ: InMail `subject` se chybně exportuje jako text zprávy

- **Stav:** TODO / blokuje důvěryhodný export
- **Priorita:** kritická
- **Dopad:** V ověřovaném `messages-since-2026-05-01-updated.json` je nejméně 107 z
  253 zpráv ve 28 konverzacích silně podezřelých: různé stabilní message ID, časy a
  směry mají opakovaně stejný pracovní titulek, například `AI Architect @ČEPS`.
  Současné date-range exporty proto nelze považovat za obsahově správné.

### Příčina

`textFrom()` v `src/linkedin/network/response-parser.ts` vybírá top-level `subject`
dříve, než projde skutečný text uvnitř `body`, `eventContent`, `attributedBody` nebo
dalších podporovaných content obálek. U InMail threadu se tak subject konverzace
zkopíruje do mnoha samostatných message eventů; chyba vzniká už při network parsování,
nikoli až při normalizaci nebo merge.

### Požadované řešení a akceptační kritéria

- `subject` nikdy nepoužívat jako náhradní `Message.text`; skutečné textové body
  extrahovat z přesně vymezených známých content struktur s dokumentovanou prioritou.
- Pokud event obsahuje pouze subject a žádný podporovaný message body ani smysluplnou
  přílohu, parser jej nesmí vydávat za úspěšně přečtenou textovou zprávu: započítá
  parser miss, označí historii/export jako neúplný a zachová poslední dobrý bundle.
- Pokud chceme subject uchovávat, přidat jej jako samostatné správně pojmenované pole
  na odpovídající úrovni schématu; nesmí kontaminovat text ani fallback identitu zprávy.
- Přidat anonymizovanou regresní fixture odpovídající reálnému InMail tvaru se
  subjectem a odlišnými inbound/outbound bodies; test musí ověřit přesné texty, ID,
  čas, směr, přílohu a absenci subjectu v `Message.text`.
- Prověřit všechny textové fallbacky a wrappery v parseru, aby metadata jako title,
  headline, subject nebo attachment name nemohla být zaměněna za message body.
- Přidat integrační quality gate, který na anonymizovaných datech odhalí tuto regresi;
  samotná unikátnost message ID nestačí jako důkaz správného obsahu.
- Po opravě spustit celý test/build/audit, nezávislé code review a nový živý export;
  původní odvozené exporty označit za obsahově vadné, nikoli je opravit mergováním.
- Aktualizovat `README.md`, `HANDOVER.md`, `docs/ARCHITECTURE.md` a
  `docs/OPERATIONS.md` včetně rozsahu dopadu a anonymizovaného důkazu opravy.

## BL-007 — KRITICKÉ: deterministicky uzavřít síť selection stránky před history probe

- **Stav:** TODO / znovu otevřený bezpečnostní nález
- **Priorita:** kritická; blokuje živý probe a BL-005
- **Dopad:** Integrační stress test 2026-09-25 znovu jednou propustil GET staré
  selection stránky na cizí `/voyager/api/messagingV2/conversations/UNREAD/events`.
  Únik neaktivoval žádný guard counter ani hard-failure stav. Tři bezprostřední
  cílená opakování prošla, což odpovídá dříve zdokumentovanému nedeterministickému
  nálezu `ZR-01` v `docs/history/CODE_REVIEW_LOG.md`, nikoli důkazu jeho uzavření.

### Požadované řešení a akceptační kritéria

- Najít přesné pořadí browser/CDP/network událostí, které dovolí již naplánovanému
  requestu selection dokumentu překonat současný teardown v
  `src/linkedin/probe-navigation.ts`.
- Zavést deterministickou bariéru ještě před vytvořením fresh target page: po jejím
  dokončení nesmí stará selection page, její frame, worker, timer ani pending request
  zasáhnout síť nebo se přenést do target fáze.
- Cizí nebo neznámý messaging request musí mít skutečný server count `0`; pokud nelze
  bezpečnost prokázat, probe musí skončit fail-closed s auditovatelným hard stavem.
- Regresní test musí stresovat relevantní 0–10ms timingy a různé zdroje requestu.
  Cílený race test spustit opakovaně v oddělených procesech, ne pouze jednou uvnitř
  jednoho Vitest běhu; každé opakování musí mít nula cizích server hitů.
- Po opravě opakovaně spustit celý `npm.cmd run check`, produkční i plný audit a
  nezávislé code review zaměřené na browser lifecycle, fail-closed stav a skutečné
  síťové počty.
- Do uzavření BL-007 nespouštět živý LinkedIn history probe. Syntetická reprodukce a
  oprava na lokálním HTTP serveru živou session nepotřebují; pozdější živá validace
  navíc vyžaduje explicitní souhlas uživatele v aktuálním promptu.
- Aktualizovat `README.md`, `HANDOVER.md`, `docs/ARCHITECTURE.md` a bezpečnostní
  rozhodnutí tak, aby žádný dokument neprezentoval probe jako ověřeně race-free před
  splněním těchto kritérií.
