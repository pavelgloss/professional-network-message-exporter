# ARCHIV: původní implementační plán

> **Historický dokument — nepopisuje výslednou implementaci.** Plán vznikl před
> implementací a obsahuje později změněná rozhodnutí, zejména persistentní browser
> profil a přepínač `--allow-thread-open`. Aktuální implementace používá fresh
> ephemeral Chromium context se storage state a přepínač `--with-history-probe`.
> Autoritativní popis je v [`../ARCHITECTURE.md`](../ARCHITECTURE.md); souhrn vývoje
> rozhodnutí je v [`../DECISIONS.md`](../DECISIONS.md).

# Původní obsah: Implementační plán

## 1. Pevný rozsah a bezpečnostní invariants

Cílem je lokální Node.js/TypeScript CLI, které v autentizované persistentní Chromium
session přečte až 100 nejnovějších LinkedIn konverzací, načte veškeré dostupné zprávy
v těchto vláknech a idempotentně je sloučí do
`data/linkedin/messages.json`.

Po celou implementaci platí tyto nepřekročitelné podmínky:

1. Exportní režim nikdy neodesílá zprávu, reakci ani přílohu a nemaže, nearchivuje,
   neoznačuje ani neupravuje konverzaci, profil nebo nastavení účtu.
2. Aplikace neobsahuje žádný selektor ani kód pro tlačítka Send, Delete, Archive,
   React, Mark read/unread, profile edit nebo jiné mutační akce.
3. Před první navigací se instaluje request guard. V exportním režimu povolí vůči
   LinkedIn pouze `GET`, `HEAD` a `OPTIONS`, zablokuje všechny ostatní metody a také
   známé mutační URL/GraphQL operace bez ohledu na metodu. Nejasný požadavek se
   zablokuje a zaznamená jen metodou, redigovanou cestou a důvodem. Service workery
   se v exportním contextu vypnou, aby guard neobcházely.
4. Interní LinkedIn endpointy se používají jen pro čtení: přednost má pasivní
   zpracování odpovědí, které vyvolal webový klient. Případné opakování/paginace smí
   použít jen pozorovaný nebo z něj jednoznačně odvozený `GET` endpoint na povolené
   LinkedIn origin/path; nikdy GraphQL mutation ani zápisový endpoint.
5. DOM fallback zůstane sekvenční a bude pouze navigovat, scrollovat a číst. Otevření
   vlákna může samo o sobě změnit serverový stav read/unread. Proto je zakázané ve
   výchozím režimu a vyžaduje explicitní `--allow-thread-open` (nebo odpovídající
   proměnnou). CLI i README před použitím přesně popíší toto omezení. Request guard
   zůstává zapnutý i při fallbacku.
6. Login je samostatný ruční režim. Program nikdy nepřijímá heslo, neobchází MFA ani
   CAPTCHA a neexportuje cookies. Persistentní profil, session, reálná data a veškerá
   diagnostika jsou ignorované Gitem.
7. Logy, chyby a diagnostika nesmějí obsahovat cookie values, Authorization/CSRF
   hodnoty, celé query stringy ani těla síťových odpovědí. Screenshot/HTML s osobními
   daty se vytvoří jen na explicitní diagnostický přepínač a vždy mimo Git.
8. Export se zapíše až po úplné runtime validaci. Neúspěšný nebo neautentizovaný běh
   nesmí přepsat poslední platný export.

Bezpečnost má přednost před úplností. Pokud LinkedIn začne vyžadovat nejednoznačný
nebo zapisující request, běh skončí s konkrétní diagnostikou namísto jeho povolení.

## 2. Projekt a přesné soubory

Vytvořit následující strukturu:

```text
package.json
package-lock.json
tsconfig.json
vitest.config.ts
.env.example
.gitignore
README.md
src/
  cli.ts
  config.ts
  errors.ts
  logger.ts
  domain/
    schema.ts
    normalize.ts
    stable-id.ts
    merge.ts
    recruiter.ts
  auth/
    login.ts
    session.ts
  browser/
    context.ts
    request-guard.ts
    scrolling.ts
  linkedin/
    exporter.ts
    auth-check.ts
    account.ts
    network/
      capture.ts
      response-parser.ts
      read-client.ts
      pagination.ts
    dom/
      selectors.ts
      conversation-list.ts
      thread.ts
  io/
    export-store.ts
    diagnostics.ts
tests/
  fixtures/
    network/
    dom/
    exports/
  unit/
    config.test.ts
    stable-id.test.ts
    normalize.test.ts
    recruiter.test.ts
    merge.test.ts
    request-guard.test.ts
    diagnostics.test.ts
  integration/
    network-parser.test.ts
    dom-fallback.test.ts
    export-store.test.ts
    unauthenticated-cli.test.ts
data/
  linkedin/
    .gitkeep
```

Odpovědnosti modulů:

- `cli.ts`: příkazy `login` a `export`, parsování argumentů, jednoznačné exit codes a
  finální souhrn bez citlivých dat.
- `config.ts`: načtení `.env` a argumentů, výchozí limit 100, validace cest, timeoutů,
  headless režimu a opt-in fallbacku. Cesty převést na absolutní a nepovolit, aby
  export/profile ukazoval na kořen workspace nebo systémový kořen.
- `errors.ts`: typované chyby `AUTH_REQUIRED`, `AUTH_CHALLENGE`, `READ_POLICY_BLOCK`,
  `PARSER_NO_DATA`, `PARTIAL_EXPORT` a `VALIDATION_FAILED`.
- `logger.ts`: strukturované úrovně logu a centrální redakce URL, headers, cookies,
  tokenů a hodnot podobných secrets.
- `domain/*`: jediný kanonický datový model, převod surových network/DOM záznamů,
  tvorba ID, recruiter heuristika a idempotentní merge.
- `auth/*`: ruční přihlášení do persistentního profilu a kontrola použitelnosti
  session bez vypsání či kopírování credentials.
- `browser/*`: vytvoření Playwright persistent contextu, request guard a omezené
  scrollovací utility se stagnation/time limity.
- `linkedin/network/*`: připojení listenerů před navigací, parsování relevantních
  JSON odpovědí, bezpečný read-only klient a cursor/link pagination.
- `linkedin/dom/*`: izolovaný registr alternativních stabilních/accessibility
  selektorů a fallback parsery; žádné mutační lokátory.
- `linkedin/exporter.ts`: orchestrace network-first sběru, případného DOM fallbacku,
  normalizace, validace a předání výsledku úložišti.
- `io/export-store.ts`: načtení starého souboru, schema validace a atomický zápis
  deterministicky serializovaného JSON.
- `io/diagnostics.ts`: bezpečný manifest běhu, počty, redigované URL paths, parser
  misses a opt-in snímky/HTML.

Použít Node.js 22, TypeScript v strict režimu, Playwright Chromium, `zod` pro runtime
schema, `dotenv` pro lokální konfiguraci, `write-file-atomic` pro bezpečný zápis a
Vitest pro testy. Pro vývojové spouštění použít `tsx`. Skripty v `package.json`:
`login`, `export`, `build`, `typecheck`, `test` a `check` (typecheck + test + build).

## 3. Datový model a normalizace

`src/domain/schema.ts` bude definovat a validovat verziovaný export:

```text
schemaVersion: 1
exportedAt: ISO-8601 UTC
account: { id, entityUrn?, name, profileUrl? }
stats: {
  requestedConversationLimit,
  exportedConversationCount,
  exportedMessageCount,
  partial,
  warnings[]
}
conversations[]: {
  id,
  entityUrn?,
  url?,
  lastActivityAt?,
  participants[],
  messages[],
  sourceMetadata?
}
participants[]: {
  id,
  entityUrn?,
  name,
  profileUrl?,
  headline?,
  company?,
  isSelf,
  probablyRecruiter,
  recruiterSignals[]
}
messages[]: {
  id,
  entityUrn?,
  conversationId,
  senderId,
  senderName,
  senderProfileUrl?,
  sentAt?,
  direction,
  sequence,
  text,
  messageType?,
  attachments?,
  sourceMetadata?
}
```

`direction` musí být `inbound` nebo `outbound`. Vlastní účet se nejprve určí přes
member/person URN z network dat, poté přes kanonickou profile URL a teprve jako DOM
fallback přes explicitní „sent by me“ marker. Směr se nesmí hádat jen podle jména.
Pokud jej nelze bezpečně určit, export se neoznačí za úspěšný a warning/diagnostika
uvede dotčené ID bez textu zprávy.

Normalizace provede:

- převod epoch ms/µs nebo ISO času do ISO-8601 UTC,
- trim pouze okrajového whitespace; zachování vnitřních newline textu,
- kanonizaci LinkedIn URL odstraněním tracking query a normalizaci member/conv URN,
- převod prázdných/neuvedených hodnot konzistentně na chybějící optional field,
- deduplikaci participantů přes URN/ID/profile URL,
- zachování příloh jako bezpečných metadat (typ, název, LinkedIn ID/URL), nikoliv
  stahování souborů,
- zachování pouze explicitně povolených source metadat; žádné raw payloady, headers,
  cookies nebo tokeny.

Stabilní ID má prioritu: LinkedIn message/conversation/member ID, potom entity URN.
Náhradní ID bude prefixované SHA-256 z kanonického obsahu. Conversation fingerprint
zahrne seřazené participant IDs/profile URLs a stabilní URL identifikátor. Message
fingerprint zahrne conversation ID, sender ID, normalizovaný timestamp, typ, text a
ID příloh. Stejné kolizní zprávy se párují proti existujícímu exportu v chronologickém
pořadí; teprve nové kolize dostanou deterministický ordinal suffix. Samotné `sequence`
nesmí být zdrojem identity, protože se změní po načtení starší historie.

Deterministické řazení:

- konverzace podle `lastActivityAt` sestupně a následně podle `id`,
- participants podle `isSelf`, normalizovaného jména a `id`,
- zprávy chronologicky podle `sentAt`, potom zdrojového pořadí a `id`,
- `sequence` přepočítat až po finálním merge jako 0-based pořadí.

`exportedAt` se při úspěšném běhu přirozeně mění; všechny ostatní stejné vstupy musí
produkovat byte-stabilní JSON (2 mezery a finální newline).

## 4. Autentizace persistentním profilem

1. `.gitignore` musí před prvním během zahrnout `.auth/`, `.env`,
   `data/linkedin/messages.json`, dočasné/backup soubory a
   `data/linkedin/diagnostics/`. Sledovat jen `.gitkeep` a anonymizované test fixtures.
2. `npm run login` otevře headed persistent Chromium context v
   `.auth/linkedin-chromium/` na oficiální přihlašovací stránce LinkedIn. Uživatel
   provede login/MFA/CAPTCHA přímo v browseru; CLI credentials nikdy nečte.
3. Login command bez request guardu povolí jen ruční autentizační flow; po nalezení
   autentizované stránky ověří přítomnost session pouze booleanem, vypíše „session
   ready“, context korektně zavře a neuloží storage state jinam.
4. `npm run export -- --limit 100` použije tentýž profil s lockem proti dvěma
   souběžným Chromium procesům. Export nikdy automaticky nespustí login formulář.
5. `auth-check.ts` rozliší platnou session, `/login`, vypršelou session,
   `/checkpoint/`/MFA a CAPTCHA. V posledních případech skončí před zápisem se
   stručnou jedinou instrukcí `npm run login`; žádná screenshot diagnostika nebude
   automatická na login/challenge stránce.

## 5. Network-first sběr

Implementovat v tomto pořadí:

1. Vytvořit persistent context, vypnout service workery, nainstalovat request guard
   a teprve potom založit stránku/listenery.
2. `capture.ts` přijímá pouze odpovědi z přesně povolených LinkedIn originů, kontroluje
   content type a maximální velikost a posílá JSON do parseru. Relevantnost určí
   kombinace URL hints (`messaging`, `conversation`, `events`, `graphql`, `voyager`)
   a rozpoznané datové struktury, nikoliv jediný endpoint string.
3. Otevřít Messaging landing page, ověřit autentizaci a pomalu scrollovat seznam
   konverzací. Ukončit při 100 unikátních ID, potvrzeném konci pagination nebo po
   několika iteracích bez nového ID. Vést počty, nikoliv obsah, v logu.
4. `response-parser.ts` mít tolerantní adaptéry pro REST/Voyager a GraphQL obálky:
   rekurzivně rozbalit `data`, `included`, `elements`, `events`, `messages`, `paging`
   a běžné URN reference, ale emitovat jen typované kandidáty. Neznámé pole ignorovat,
   chybějící povinné pole hlásit jako parser miss. Anonymizované fixtures pokryjí
   varianty obálek.
5. `read-client.ts` smí znovu použít autentizační kontext pouze pro povolený `GET`.
   Přenese minimální nutné browser headers v paměti, nikdy je neloguje ani neukládá.
   Navštívené URL kontroluje proti origin/path allowlistu a odstraní fragment;
   redirects mimo allowlist odmítne.
6. Pro vybrané conversation IDs následovat jen zachycené pagination links/cursors a
   pozorované read-only URL template. Vlákna zpracovávat sekvenčně s mírným jitterem,
   žádnou vysokou paralelizací. Message pagination pokračuje dozadu až do potvrzeného
   konce nebo stagnation/time limitu; není zde pevný limit počtu zpráv.
7. Síťové záznamy průběžně slučovat v paměti podle URN/ID. Network hodnoty mají
   přednost pro ID, čas, sender a směr; pozdější DOM data smějí pouze doplnit chybějící
   prezentované hodnoty.
8. Pokud network cesta nedá conversation ID nebo message body pro všechny vybrané
   konverzace, výchozí safe režim skončí jako částečný s instrukcí k volitelnému
   `--allow-thread-open`. DOM fallback se nesmí zapnout tiše.

Request guard bude unit-testovatelná čistá policy funkce a runtime route handler.
Souhrn běhu uvede počet povolených GET a počet/typ zablokovaných požadavků. Jakýkoliv
exporterem iniciovaný nepovolený request je fatální chyba; běžné zablokované telemetry
webu mohou být warning, nikdy se ale nepovolí.

## 6. DOM fallback

DOM fallback implementovat odděleně, aby změna LinkedIn UI nezasáhla network parser:

- `selectors.ts` vrací seřazené alternativy: nejprve role/accessible name, potom
  stabilní `data-*`/URN/href atributy, nakonec omezené CSS struktury. Každý úspěšný
  selector zaznamenat pouze názvem strategie.
- `conversation-list.ts` z viditelných řádků získá URL/ID, participanty, snippet a
  poslední aktivitu. Scrolluje správný list container do 100 unikátních položek nebo
  do stagnace.
- `thread.ts` otevře jen konkrétní conversation URL/link, nikdy nepoužije obecný
  klik na řádek s akčními prvky. Po otevření scrolluje message container nahoru,
  dokud nepřibývají starší message IDs/fingerprints. Extrahuje text, čas, sender,
  profile URL, DOM direction marker a attachment metadata.
- Scroll utility má maximální počet iterací, timeout, kontrolu stagnace a malé
  prodlevy. Jedna chyba vlákna nezpůsobí klikání na alternativní neověřené prvky;
  uloží warning a pokračuje jen bezpečnou cestou.
- Před prvním otevřením vlákna vypíše CLI výrazné upozornění, že zobrazení může změnit
  read/unread stav. Flag představuje explicitní souhlas s tímto omezením, nikoliv se
  zasíláním či jinými změnami.

Fallback integration test poběží pouze nad lokální statickou anonymizovanou stránkou.
Test zároveň ověří, že lokátory nemohou zasáhnout připravená mutační tlačítka.

## 7. Recruiter heuristika

`recruiter.ts` bude čistá, verzovaná a konzervativní funkce. Posuzuje pouze externí
účastníky; vlastní účet vždy dostane `probablyRecruiter: false`.

- Silné signály v headline/title/company: recruiter, recruitment, talent acquisition,
  talent partner, headhunter, staffing, sourcer/sourcing a recruitment consultant.
- Slabší personální signály: hiring, HR, people partner/people operations.
- Signály v textu: konkrétní job/role/position/career/freelance/contract opportunity,
  interview a salary/compensation ve spojení s nabídkou práce.
- Negativní/nejisté použití (např. participant jen odpovídá recruiterovi nebo běžná
  zmínka o vlastním hiringu) samo nestačí.

`true` nastane při jednom silném profilu signálu nebo při nejméně dvou nezávislých
textových/slabých signálech. Jinak `false`. Matching je case-insensitive,
word-boundary aware a testovaný v angličtině i na běžných českých výrazech. Do
`recruiterSignals` se uloží jen názvy pravidel, ne kopie textu. Klasifikace nikdy
nefiltruje konverzace ani zprávy.

## 8. Idempotentní merge a ukládání

1. Před merge načíst existující `messages.json`, validovat schema a při nevalidním
   souboru skončit bez přepsání. Neprovádět tichou migraci neznámé schema verze.
2. Konverzace spojit podle LinkedIn ID/URN, poté podle stabilního fallback ID.
   Aktuální neprázdná metadata aktualizují stará; chybějící aktuální hodnota nesmaže
   dříve známou hodnotu.
3. Participants obdobně spojit podle ID/URN/profile URL a recruiter flag přepočítat
   z nejnovějšího sjednoceného kontextu.
4. Messages spojit podle LinkedIn ID/URN. Bez něj použít fingerprint a collision
   matching popsaný výše. Staré zprávy, které aktuální částečný běh neviděl, zachovat.
5. Po merge znovu odvodit směr, `lastActivityAt`, řazení, `sequence` a statistiky;
   poté celý objekt runtime validovat.
6. Serializovat deterministicky do dočasného souboru ve stejné složce, flushnout a
   atomicky nahradit cíl přes `write-file-atomic`. Při chybě zůstane starý export.
7. Dva identické normalizované vstupy musí po odečtení `exportedAt` vytvořit identický
   soubor. Test „run twice“ ověří nulové duplicity; test inkrementálního běhu ověří
   zachování staré historie, přidání nové zprávy a aktualizaci headline.

Skutečný `data/linkedin/messages.json` bude lokálně vygenerovaný validní JSON, ale od
počátku ignorovaný Gitem, aby budoucí commit nemohl omylem zveřejnit zprávy. Testy
použijí výhradně anonymizované fixtures mimo produkční cestu.

## 9. Diagnostika bez secrets

Výchozí běh vytvoří pouze redigovaný JSON manifest v ignorované složce
`data/linkedin/diagnostics/<run-id>/manifest.json` s časy, verzí aplikace, názvy
parser strategií, counts, status codes, URL origin + pathname, stagnation důvody a
warning/error kódy. Neobsahuje query, request/response headers, request/response body,
cookies, local/session storage ani text zpráv.

`logger.ts` a `diagnostics.ts` budou mít stejné centrální redakční filtry pro klíče
`cookie`, `authorization`, `csrf`, `token`, `session`, `password`, `li_at`,
`JSESSIONID` a token-like hodnoty. Test vloží canary secrets do vnořeného objektu a
ověří, že se nikde ve výstupu nevyskytují.

Volitelný `--diagnostics-content` může uložit screenshot a omezený HTML snapshot pro
opravu selektorů. CLI předem upozorní, že mohou obsahovat osobní zprávy; soubory jsou
lokální a gitignored. Ani tento režim nikdy neukládá cookies/storage/network bodies a
na login, MFA nebo CAPTCHA stránce obsahovou diagnostiku nevytvoří.

## 10. Testovací a ověřovací matice

### Automatické testy

- Config: defaults, limit 100, neplatné hodnoty, bezpečné cesty a precedence CLI/env.
- Stable IDs: shodné vstupy, pořadí participants, unicode/newline, kolize a doplnění
  starších zpráv.
- Normalizace: REST/GraphQL časy, URN, URL, prázdné texty/media a direction.
- Recruiter: silné, kombinované, negativní a nejisté případy; vlastní participant.
- Merge: dva stejné běhy, nové messages, změněná metadata, partial run, stabilní
  řazení a žádná duplikace.
- Request policy: všechny HTTP metody, cizí origin, redirects, známé mutační paths,
  GraphQL mutation názvy a povolené Messaging GET.
- Network parser: anonymizované REST/Voyager/GraphQL fixtures, pagination, neznámá
  pole a malformed/oversized response.
- DOM: lokální fixture s lazy listem/threadem, více selector variant a návnadami
  Send/Delete/Archive, které nesmějí být aktivovány.
- Export store: invalid existing JSON, atomická výměna, write failure a byte-stabilní
  výsledek.
- Diagnostika: recursive redaction a zákaz message body v manifestu.
- CLI: fresh temp profile skončí očekávaným `AUTH_REQUIRED`, nic nezapíše a vypíše
  přesný bezpečný další krok; challenge fixture analogicky.

### Běhové ověření implementátorem

1. `npm install` a `npx playwright install chromium`.
2. `npm run check` musí projít na čistém checkoutu.
3. Spustit integrační Playwright testy jen proti lokálním fixtures; ověřit, že jejich
   mutační canary nebyla aktivována.
4. Spustit exportní smoke test s novým dočasným profilem. Očekávaný výsledek je
   kontrolované `AUTH_REQUIRED`, jediná instrukce `npm run login`, žádný vznik/přepis
   `messages.json` a žádný secret v logu/diagnostice.
5. Pokud pracovní persistentní session neexistuje, je to očekávaná jediná externí
   blokace: uživatel musí spustit `npm run login` a ručně dokončit LinkedIn login,
   MFA nebo CAPTCHA. Implementátor nesmí credentials získávat jinak.
6. Po dostupnosti session spustit nejprve bezpečný network-only export s limitem 100.
   Ověřit platné schema, reálný nenulový text, sender, timestamp, direction,
   participant flags, counts a nulové povolené mutace.
7. Spustit export podruhé a programově porovnat IDs/counts: bez nových LinkedIn dat
   nesmí přibýt duplicity. `exportedAt` se může změnit.
8. Pokud network-only běh zůstane částečný, pouze sdělit konkrétní coverage a nabídnout
   příkaz s `--allow-thread-open`; nespouštět jej bez explicitního vědomí rizika
   read/unread. Po opt-in znovu ověřit request-guard counters a merge.
9. Před dokončením zkontrolovat `git status`, že `.auth`, `.env`, export,
   diagnostika, screenshots, HTML ani browser profil nejsou trackované. Provést
   nezávislé code review se zaměřením na bezpečnost, data loss a selectors a opravit
   všechny závažné nálezy.

## 11. Pořadí implementace a lokální Git

1. Scaffold, `.gitignore`, konfigurace, schema a anonymizované fixtures.
2. Stable IDs, normalizace, recruiter klasifikace, merge a export store včetně unit
   testů.
3. Persistentní login/session kontrola, browser context a request guard včetně testů.
4. Network capture/parser/read-only pagination a network-first orchestrátor.
5. Izolovaný opt-in DOM fallback a lokální Playwright integration test.
6. Diagnostika/redakce, CLI ergonomie a praktický README.
7. Instalace browseru, `npm run check`, unauthenticated smoke test a kontrola ignorovaných
   secrets/dat.
8. Až s uživatelskou session reálné network-only ověření a opakovaný idempotence run;
   případný thread-open fallback jen po opt-in.
9. Samostatné code review, opravy a finální `npm run check` + `git diff --check`.

Po každém uceleném kroku vytvořit malý lokální commit, ale nikdy necommitovat session,
credentials, reálné zprávy ani obsahovou diagnostiku. Tento plánovací krok samotný
commit nevytváří.

## 12. Definition of Done

Projekt je hotový pouze tehdy, když jsou splněny všechny body, které lze ověřit bez
cizího vstupu: dependencies a Chromium jsou nainstalované, build/typecheck/testy
projdou, request guard má důkaz z testů, CLI bezpečně rozpozná chybějící session,
výstupní schema/merge/recruiter klasifikace jsou testované a README obsahuje jen
praktickou instalaci, jednorázový login, spuštění, umístění dat a upozornění na
read/unread fallback.

Plné produkční DoD (skutečné zprávy, až 100 nejnovějších konverzací, jejich dostupná
historie a druhý neduplikující běh) lze potvrdit až po ručním přihlášení vlastníka
účtu. Chybějící login, MFA nebo CAPTCHA je očekávaná autentizační blokace, nikoliv
důvod oslabit bezpečnost nebo simulovat úspěšný export.
