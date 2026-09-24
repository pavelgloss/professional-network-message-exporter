# ARCHIV: úplný chronologický log code review

> **Historický dokument — starší verdikty `NO-GO` nejsou současný stav.** Log je
> záměrně chronologický a obsahuje nálezy, které byly později opraveny. Platný finální
> verdikt byl `GO — Critical 0 / High 0 / Medium 0` pro code baseline `b611a61`.
> Aktuální stručný přehled je v [`../../CODE_REVIEW.md`](../../CODE_REVIEW.md).

# Původní obsah: Nezávislé code review

## Verdikt

Aktuální `HEAD` není připravený pro autentizované produkční použití. Fresh-profile
smoke test se sice bezpečně zastaví bez zápisu exportu a běžné HTTP mutace jsou
blokované, ale existuje potvrzený kanál mimo HTTP route guard a několik cest, které
mohou vytvořit neúplný nebo nesprávně sloučený export. Před přihlášeným během je
nutné vyřešit přinejmenším CR-01 až CR-06.

## Nálezy

### CR-01 — CRITICAL — WebSocket provoz zcela obchází read-only guard

- **Soubor/řádky:** `src/browser/request-guard.ts:21-35`,
  `src/browser/context.ts:8-19`
- **Problém:** guard instaluje pouze `context.route('**/*', ...)`. Playwright má pro
  WebSockety samostatné `context.routeWebSocket`; běžný route handler handshake ani
  frames nevidí. Lokální runtime reprodukce otevřela z testovací stránky WebSocket:
  server přijal jeden upgrade, zatímco `allowedRequests` zůstal pouze na jednom HTTP
  dokumentu a `blockedRequests` zůstal prázdný.
- **Dopad:** tvrzení, že exportní režim nepovolí žádný zapisující request, není
  vynutitelné. Pokud LinkedIn stránka používá realtime socket, může přes něj poslat
  klientské frames (například stavové události) bez kontroly a bez diagnostického
  záznamu. To porušuje nejdůležitější safety invariant bez ohledu na to, zda jej
  aktuální anonymní smoke skutečně využil.
- **Doporučení:** před první stránkou/navigací v export contextu instalovat
  `context.routeWebSocket('**/*', ws => ws.close(...))` a WebSockety fail-closed
  zakázat. Přidat runtime test s lokálním upgrade serverem, který ověří nula
  serverových handshaků/frames, a counter do manifestu. Neprovádět přihlášený test,
  dokud toto není opravené.

### CR-02 — HIGH — Neznámý sender/direction se tiše změní na `inbound`

- **Soubor/řádky:** `src/linkedin/exporter.ts:76-84`,
  `src/domain/normalize.ts:68-84`, `src/linkedin/network/response-parser.ts:67-82`
- **Problém:** exporter odmítne chybějící `direction` pouze tehdy, když současně
  nemá `reliableSelfId`. Jakmile self ID existuje, zpráva bez `senderId` dostane hash
  neznámého sendera a `normalizeMessage` ji automaticky označí `inbound`. Stejně se
  zachází s DOM zprávou, jejíž směr nebylo možné určit, nebo se senderem z jiného URN
  namespace. Parser sám žádný network `direction` nevytváří.
- **Ověření:** přímá reprodukce s `selfId='stable-self'` a zprávou bez `senderId`
  vrátila `direction='inbound'` a umělý `member_*` sender ID.
- **Dopad:** odchozí zpráva může být vydávána za příchozí. To je nebezpečné hlavně
  pro zamýšleného dalšího agenta, který má hledat poslední inbound zprávu a případně
  odpovídat. Současně může export obsahovat `Unknown sender`, aniž by byl běh
  odmítnutý.
- **Doporučení:** direction odvozovat jen přes prokázanou vazbu sender URN/profile
  na účet nebo explicitní DOM self marker. Chybějící či nejednoznačnou vazbu
  nezaměnit za external sender; skončit `VALIDATION_FAILED`/partial bez přepsání
  posledního ověřeného exportu. Testovat outbound/inbound napříč `fsd_profile`,
  `miniProfile`, `messagingParticipant` a composite URN variantami.

### CR-03 — HIGH — Composite LinkedIn URN se ořízne na nesprávné ID

- **Soubor/řádky:** `src/domain/stable-id.ts:17-21`,
  `src/linkedin/network/response-parser.ts:47-55`,
  `src/linkedin/network/response-parser.ts:67-101`
- **Problém:** `extractUrnId` bere text za druhou dvojtečkou jen do první čárky nebo
  závorky. Pro composite URN
  `urn:li:msg_conversation:(urn:li:fsd_profile:ABC,2-XYZ)` vrací
  `(urn:li:fsd_profile:ABC`, nikoliv stabilní identitu konverzace. Stejná funkce se
  používá na conversation, participant, message i sender URN.
- **Dopad:** vznikají chybné conversation URL, nepropojí se sender se self účtem,
  rozbije se direction a mezi různými obálkami/runy se mění identita téhož objektu.
  Následný agent pak nemusí umět z exportovaného ID otevřít původní thread.
- **Doporučení:** URN parsovat podle konkrétního typu a composite hodnotu zachovat
  jako celek; nevydávat obecný poslední segment za ID všech namespace. Oddělit
  LinkedIn entity URN od route/thread ID a přidat anonymizované fixtures současných
  REST/Voyager/GraphQL composite tvarů.

### CR-04 — HIGH — Idempotentní merge nepropojí stejnou entitu přes různé identity

- **Soubor/řádky:** `src/domain/merge.ts:22-53`,
  `src/domain/merge.ts:49-66`, `src/linkedin/exporter.ts:102-107`
- **Problém:** maps používají jediný klíč `entityUrn ?? id` (participants navíc
  `entityUrn ?? profileUrl ?? id`). Pokud jeden běh zná URN a další pouze stejné
  prosté ID/URL, jde o dva různé klíče. Obdobně upgrade fallback ID na LinkedIn ID
  nevytvoří alias. `mergeExports` navíc bezpodmínečně převezme `next.account`, takže
  partial běh s DOM hash účtem může zahodit dříve známé stabilní account ID/URN.
- **Ověření:** merge exportu s `{id:'c', entityUrn:'urn:li:messagingThread:c'}` a
  dalšího exportu pouze s `{id:'c'}` vytvořil dvě konverzace se stejným `id='c'`.
- **Dopad:** opakované nebo částečné běhy mohou duplikovat conversations,
  participants i messages, rozpojit sender reference a degradovat stabilní účetní
  metadata. To přímo porušuje požadovanou idempotenci; atomický zápis pouze bezpečně
  uloží již chybně sloučený obsah.
- **Doporučení:** indexovat všechny dostupné aliasy (URN, explicitní ID, canonical
  thread/profile URL a fallback ID), při jednoznačné shodě entitu migrovat na
  silnější identitu a validovat unikátnost IDs/referencí. Starý stabilní account
  zachovat, pokud nový běh přináší jen slabší DOM fallback. Přidat testy identity
  upgrade/downgrade a partial run nad existujícím JSON.

### CR-05 — HIGH — DOM lazy loading ztrácí virtualizované položky a může tvrdit úplnost

- **Soubor/řádky:** `src/browser/scrolling.ts:13-25`,
  `src/linkedin/dom/conversation-list.ts:21-42`,
  `src/linkedin/dom/thread.ts:21-51`, `src/linkedin/exporter.ts:80-83`
- **Problém:** scroll loop sleduje pouze aktuální počet DOM uzlů a data extrahuje až
  po skončení scrollování. Virtualizovaný seznam drží počet řádků konstantní a staré
  řádky odebírá, takže loop po čtyřech stagnacích skončí a exporter uvidí jen finální
  viewport. Thread parser má stejný problém při scrollování nahoru. Důvod ukončení
  thread scrollu se zahodí a `partial` nereaguje na timeout/stagnaci seznamu ani
  threadu.
- **Dopad:** export může obsahovat výrazně méně než 100 konverzací a pouze část
  zpráv, přesto při `--allow-thread-open` skončit s `partial:false`. U threadu navíc
  final snapshot po scrollu nahoru může zachovat staré zprávy a ztratit nejnovější.
- **Doporučení:** během každé iterace akumulovat položky podle stabilního
  ID/fingerprintu, stagnaci měřit nad počtem unikátních akumulovaných entit a
  rozlišit potvrzený konec od timeoutu/stagnace. Každé nepotvrzené ukončení zahrnout
  do `partial`. Přidat skutečně virtualizovanou fixture, která odebírá mimo-viewport
  řádky.

### CR-06 — HIGH — Pagination a parser nepokrývají deklarované Voyager/GraphQL varianty

- **Soubor/řádky:** `src/linkedin/network/response-parser.ts:85-147`,
  `src/linkedin/network/pagination.ts:7-27`,
  `src/linkedin/exporter.ts:43-48`, `src/linkedin/exporter.ts:52-72`,
  `tests/integration/network-parser.test.ts:6-18`
- **Problém:** parser následuje jen absolutní `href`/`nextUrl` začínající přesně
  `https://www.linkedin.com/voyager/api/`. Nezpracuje relative link, start/count/total,
  cursor/pagination token ani reference arrays typu `*participants`/`*events`.
  Pagination má jeden globální limit 30 URL. Volá se jen před thread loopem; nově
  zachycené pagination URL po otevření/scrollu threadů už nikdo nenásleduje. Jediná
  fixture je zjednodušený Voyager REST tvar; žádná GraphQL/cursor/message-history
  fixture navzdory plánu neexistuje.
- **Dopad:** běh typicky skončí po prvních stránkách conversation listu nebo message
  history. Included/reference sender data se nemusí propojit, což dále vede k
  `Unknown sender` a chybnému direction. Požadavek „až 100 konverzací a všechny
  dostupné zprávy“ není implementací doložen.
- **Doporučení:** přidat samostatné adaptéry pro skutečně pozorované REST/Voyager a
  GraphQL obálky, indexovat všechny reference keys, podporovat relative odkazy a
  cursor tokeny pouze z pozorovaného read-only GET template. Pagination vést po
  konkrétních resources/conversations a znovu ji drain/follow po každém threadu.
  Test fixtures musí pokrýt conversation list i více stránek historie.

### CR-07 — HIGH — Raw coalesce zahazuje legitimní identické fallback zprávy

- **Soubor/řádky:** `src/linkedin/exporter.ts:128-155`,
  `src/domain/normalize.ts:78-82`, `tests/unit/domain.test.ts:23-28`
- **Problém:** `mergeRawMessages` nejprve vloží zprávy do `Map` podle fallback hashe.
  Dvě zprávy bez LinkedIn ID se stejným senderem, časem, typem, textem a attachments
  proto splynou ještě před normalizací. Test ordinal suffixů volá
  `normalizeConversation` přímo, a tuto exporter cestu tak vůbec netestuje.
- **Dopad:** legitimní opakované krátké zprávy (zvlášť při DOM času s hrubou
  přesností) mohou z exportu zmizet. Při inkrementálním načtení se mohou ordinal ID
  navíc posunout podle pořadí batchů.
- **Doporučení:** pro fallback identitu držet ordered multiset/buckets, párovat
  kolize s existujícím exportem chronologicky a ordinal přidělit až po úplném merge,
  jak požaduje plán. Přidat test přes skutečný `coalesceRaw`/exporter pipeline.

### CR-08 — MEDIUM — Zachycené account identity se ignorují a DOM fallback může být nestabilní

- **Soubor/řádky:** `src/linkedin/network/capture.ts:10-21`,
  `src/linkedin/exporter.ts:30-41`, `src/linkedin/account.ts:7-26`
- **Problém:** capture sbírá `accountCandidates`, ale exporter je nikdy nepoužije;
  spoléhá pouze na jeden přímý `/voyager/api/me` GET. DOM fallback přijme jako
  `profileUrl` libovolnou LinkedIn URL z prvního „Me“ triggeru, nikoliv jen `/in/...`,
  a hash vytvoří i z obecného `/feed/` odkazu nebo lokalizovaného labelu.
- **Dopad:** dojde k zbytečnému `VALIDATION_FAILED`, nestabilnímu account/sender ID,
  chybnému self porovnání nebo k degradaci staršího stabilního účtu při merge.
- **Doporučení:** validované capture candidates použít před DOM fallbackem; profile
  URL omezit na kanonickou `/in/` identitu a explicitně odlišit stabilní od
  prezentační identity.

### CR-09 — MEDIUM — Partial export se zapisuje a CLI končí úspěchem i při chybějících datech

- **Soubor/řádky:** `src/linkedin/exporter.ts:80-108`, `src/cli.ts:17-20`,
  `src/errors.ts:1-8`
- **Problém:** safe network-only běh nastaví `partial:true` vždy, i když síťová data
  mohou být úplná, a přesto přepíše hlavní `messages.json`; CLI pouze zaloguje warning
  a vrátí exit code 0. Naopak thread běh může kvůli CR-05 hlásit `partial:false` bez
  potvrzeného konce. Definovaný `PARTIAL_EXPORT` se nepoužívá.
- **Dopad:** skript/AI consumer nemůže z exit code spolehlivě poznat, že hlavní export
  nemá požadovanou coverage, a může jej považovat za hotový. Starý validní obsah se
  sice atomicky zachovává v merge, ale metadata aktuálního běhu a účet se mění.
- **Doporučení:** coverage počítat z potvrzených pagination/end stavů. Partial běh
  buď ukládat do odděleného candidate souboru, nebo jej bezpečně merge-nout, ale
  vrátit dokumentovaný nenulový `PARTIAL_EXPORT`; poslední plně ověřený export
  nedegradovat.

### CR-10 — MEDIUM — README CLI options se v aktuálním PowerShellu nepředávají

- **Soubor/řádky:** `README.md:24-28`, `src/config.ts:34-65`, `package.json:9-16`
- **Problém:** na review prostředí (PowerShell 7, npm 10.9.2) příkaz přes `npm.ps1`
  `npm run export -- --limit 17 --profile-dir ...` spustil
  `tsx src/cli.ts export 17 ...`; názvy optionů zmizely a aplikace použila limit 100
  i defaultní cesty. Stejný příkaz přes `npm.cmd` předal flagy správně. README přitom
  používá explicitně PowerShell blok a právě tuto formu příkazu.
- **Dopad:** uživatel může nevědomky použít jiný persistent profile/output nebo limit,
  než zadal. U citlivého exportu je překvapivá cílová cesta významný problém.
- **Doporučení:** na Windows README používat ověřený `npm.cmd` příkaz nebo stabilní
  wrapper/bin a přidat skutečný CLI process test se space-separated options. Parser
  má také odmítat neznámé/osiřelé argumenty namísto jejich tichého ignorování.

## Bezpečnost credentials a Git

- `.env`, `.env.*` (mimo `.env.example`), `.auth/`, výchozí reálný export, atomické
  temp soubory a výchozí diagnostics jsou ignorované.
- `git ls-files` nenašel session/cookie/export artefakt; trackovaná je pouze
  `.env.example` bez secretu.
- Custom `--output` přesune i diagnostics mimo konkrétní ignorovaný
  `data/linkedin/...` strom. Pokud zůstane podporovaný, aplikace/README má uživatele
  varovat, že nový cíl musí být také gitignored; ideálně to ověřit proti repository
  ignore pravidlům.
- Review nepoužilo credentials ani existující session. Fresh smoke vytvořil pouze
  nové prázdné, gitignored profily a redigované manifesty.

## Ověření provedené při review

- `npm run check`: **PASS** — typecheck, 7 test files / 19 tests a build prošly.
- `npm audit --omit=dev --audit-level=high`: **PASS**, 0 nalezených zranitelností.
- `git diff --check`: **PASS**.
- Fresh-profile unauthenticated smoke přes `npm.cmd`, vlastní temp profile/output:
  **PASS pro fail-closed auth** — exit 3 / `AUTH_REQUIRED`, `messages.json` nevznikl,
  manifest měl `AUTH_REQUIRED`, 16 povolených GET-like requests a 0 blocked requests.
- Lokální WebSocket safety probe: **FAIL** — 1 server-side upgrade, 0 evidence v
  route-guard counters (CR-01).
- Lokální identity/direction probe: **FAIL** — URN/id merge vytvořil 2 konverzace se
  stejným ID; composite URN se ořízl; neznámý sender byl `inbound` (CR-02 až CR-04).
- `git status --ignored`: žádná změna implementačního kódu; `node_modules/`, `dist/`,
  fresh `.auth/` a smoke diagnostics jsou ignorované.

## Neověřené zbytkové riziko / DoD

Bez uživatelova ručního loginu nebylo a z bezpečnostních důvodů ani nemělo být
ověřeno načtení skutečného Messaging inboxu, reálné současné LinkedIn obálky,
100 konverzací, úplná historie ani druhý produkční idempotentní run. Kvůli CR-01 se
takový autentizovaný run nemá provádět před opravou WebSocket guardu. Současné testy
navíc neověřují runtime redirect guard, již existující service worker, skutečný
partial/failure overwrite, GraphQL/cursor pagination ani virtualizovaný DOM.

---

## Re-review opraveného HEAD `4cf97d9`

### Verdikt re-review

**Zatím není bezpečné vyžádat jednorázový login ani spustit autentizovaný export.**
Oprava WebSocket guardu funguje, ale re-review prokázal kritický bypass přes service
worker uložený v persistentním profilu. To je přímo relevantní: login režim nyní
service workery povoluje a stejný profil se následně otevírá pro export.

Po odstranění RR-01 bude z hlediska síťových mutací rozumné provést pouze
**network-only diagnostický export bez `--allow-thread-open`**. Jeho JSON ale zatím
nelze považovat za produkčně spolehlivý kvůli RR-02 až RR-04; zejména falešné
`historyComplete` může obejít novou ochranu partial candidate.

### Nové a přetrvávající nálezy

#### RR-01 — CRITICAL — Persistovaný service worker obchází HTTP guard a odešle POST

- **Soubor/řádky:** `src/browser/context.ts:8-23`, `src/auth/login.ts:7-11`,
  `src/browser/request-guard.ts:21-43`
- **Problém:** `serviceWorkers: 'block'` zabrání novým registracím, ale v persistentním
  `userDataDir` nezneškodní již uložený service worker. `context.route` požadavky
  převzaté service workerem nevidí. Login context naopak používá
  `serviceWorkers: 'allow'`, takže si LinkedIn může worker během legitimního loginu
  uložit právě do profilu později použitého exportem.
- **Ověření:** v novém dočasném persistent profilu byl v login-like contextu
  zaregistrován lokální service worker. Po zavření a opětovném otevření téhož profilu
  přes aktuální `launchContext(..., 'export')` platilo:
  `context.serviceWorkers().length === 1`; `fetch('/mutate', {method:'POST'})`
  skončil úspěšně a lokální server přijal jeden POST. Request guard jej nezablokoval
  ani nezapočítal. Test nepoužil LinkedIn ani credentials.
- **Dopad:** nejdůležitější read-only invariant je znovu obejitelný a manifest může
  hlásit nula blokovaných mutací, přestože request opustil prohlížeč. Samotné zavření
  startup stránky ani WebSocket route tento kanál neřeší.
- **Doporučení:** export nesmí startovat z browser contextu, ve kterém může být
  persistovaný worker. Bezpečná varianta je po ručním loginu uchovat pouze ignorovaný
  storage state/cookies a každý export spouštět v novém ephemeral contextu se
  service workers blokovanými před vznikem první stránky. Alternativně vytvořit
  exportní kopii profilu bez SW storage ještě před spuštěním Chromium. Login režim
  má také service workery blokovat. Pro staré profily přidat fail-closed preflight;
  pouhé `context.serviceWorkers().length` až po launch není úplná prevence, protože
  worker už mohl při startu provést background práci. Přidat přesně výše popsaný
  persistent-profile integration test a neprovádět reálný login před jeho průchodem.

#### RR-02 — HIGH — Parser může označit historii za úplnou, i když event ztratil

- **Soubor/řádky:** `src/linkedin/network/response-parser.ts:100-114`,
  `src/linkedin/network/response-parser.ts:126-173`,
  `src/linkedin/exporter.ts:98-125`, `src/linkedin/network/pagination.ts:10-30`
- **Problém:** `historyComplete` používá počet raw `messageValues` a
  `pageInfo.hasNextPage === false`, ale neověřuje, že se každý raw event skutečně
  převedl na validní message. Proto i částečně neznámý formát dostane příznak úplnosti.
  Naopak u REST/Voyager paging na úrovni envelope se dosažení poslední stránky vůbec
  nepropíše ke konkrétní conversation; test historie ověřuje jen IDs, nikoliv
  completion. Cursor derivace navíc umí pouze JSON v parametru `variables`, ne běžný
  Rest.li tvar `(cursor:old,count:20)`.
- **Ověření:** anonymní payload se dvěma eventy (`m1` podporovaný, `m2` s neznámým
  content tvarem) vrátil pouze `m1`, ale současně
  `sourceMetadata.historyComplete === true`. Samostatný cursor probe s
  `variables=(cursor:old,count:20)` nevyprodukoval žádnou next URL.
- **Dopad:** network-only běh může nastavit `partial:false` a přepsat hlavní
  `messages.json`, přestože některé zprávy chybí. Tím se obchází správně zavedený
  `.partial` candidate/exit 5 mechanismus. U REST envelope naopak ani kompletně
  dočtený export neumí prokázat úplnost a zůstane navždy candidate.
- **Doporučení:** completion musí vyžadovat nulový parser miss pro všechny relevantní
  events a být sledovaná na úrovni konkrétního resource/conversation napříč stránkami.
  Envelope end state je nutné propagovat po merge. Neznámý message event nesmí dát
  `historyComplete:true`; má vynutit partial. Přidat negativní fixture se ztraceným
  eventem, REST end-to-end completion test a skutečný pozorovaný Rest.li cursor tvar.

#### RR-03 — HIGH — CR-07 stále ztrácí disjunktní fallback messages a raw alias umí duplicitu

- **Soubor/řádky:** `src/linkedin/exporter.ts:150-203`,
  `src/linkedin/exporter.ts:206-223`, `src/domain/merge.ts:100-121`
- **Problém:** fallback buckets se mezi dvěma vstupy slučují na
  `max(left.length, right.length)`. To je správné jen tehdy, když jde o dvě pozorování
  stejných zpráv, nikoliv o dvě disjunktní pagination dávky. Kód nemá source/page
  identitu, takže situace nerozliší. Stable větev navíc indexuje pouze jeden map key,
  ne všechny aliasy: záznam `{id:'M', entityUrn:'...:M'}` a následný záznam pouze
  `{entityUrn:'...:M'}` vytvoří dvě raw messages; po normalizaci mají obě `id='M'`.
  Schema ani merge unikátnost message ID nevynucují.
- **Ověření:** dvě disjunktní dávky po dvou fallback zprávách se stejným obsahem a
  časem, ale `sourceOrder` 0–1 a 2–3, daly pouze 2 zprávy místo 4 (zůstaly orders 2–3).
  ID/URN alias probe dal 2 raw messages a normalizované IDs `['M', 'M']`.
- **Dopad:** pagination může stále zahodit legitimní zprávy; jiná kombinace adapterů
  může naopak exportovat jednu zprávu dvakrát se stejným ID. CR-07 tedy není uzavřený
  a idempotence není obecně zaručená.
- **Doporučení:** každé pozorování opatřit source response/page identitou a fallback
  multiset skládat podle prokazatelného overlapu, nikoliv globálním `max`. Stable
  raw entries indexovat všemi aliasy stejně jako finální merge. Schema-level
  validace musí odmítnout duplicitní conversation/message/participant IDs a rozbité
  sender reference.

#### RR-04 — MEDIUM — Network participant a DOM name-only participant se zdvojí

- **Soubor/řádky:** `src/linkedin/dom/conversation-list.ts:15-31`,
  `src/linkedin/exporter.ts:206-220`, `src/domain/merge.ts:35-89`
- **Problém:** DOM conversation list přidává participanta pouze se jménem. Pokud
  network data téhož člověka obsahují ID/profile URL, raw i finální alias merge nemají
  společný klíč a ponechají dva participanty. Jméno samotné správně není bezpečný
  globální alias, ale DOM list record se má při existenci silnějších network dat
  použít jen jako doplněk, ne jako další osoba.
- **Ověření:** sloučení network `{id:'p', name:'Jane', profileUrl:'.../in/jane'}` a
  DOM `{name:'Jane'}` ve stejné conversation vytvořilo participanty `p` a
  `member_edf...`, oba se jménem Jane.
- **Dopad:** participants/recruiter data jsou zavádějící a další agent může jednu
  osobu chápat jako dvě. U skupinového threadu může být DOM combined label ještě
  horší.
- **Doporučení:** pokud stejná conversation již má autoritativní network
  participants, name-only list participanty nepřidávat; používat je jen pro prázdnou
  network sadu nebo jako nízko-důvěryhodné prezentační metadata.

### Stav původních CR-01 až CR-10

| Původní nález | Stav na `4cf97d9` | Re-review důkaz / poznámka |
| --- | --- | --- |
| CR-01 WebSocket bypass | WebSocket část uzavřena; safety invariant zůstává otevřený přes RR-01 | Skutečný `launchContext` probe: 0 upgrade/frames, `blockedWebSockets=1`; persistovaný SW samostatně odeslal POST. |
| CR-02 direction fail-open | Uzavřeno | Missing/unlinked sender a unknown DOM direction nyní fail-closed; outbound/inbound kontroluje self vazbu. |
| CR-03 composite URN | Základní network případ uzavřen | Composite value zůstává celé a typed conversation route ID je `2-XYZ`. DOM stále používá hrubé `entityUrn.split(':')` (`src/linkedin/dom/thread.ts:81`), což je zbytkové riziko pro composite DOM URN. |
| CR-04 alias merge/account | Hlavní persisted merge uzavřen; raw/participant mezery viz RR-03/RR-04 | URN/plain ID/route reprodukce dává 1 conversation; silnější account se zachová. |
| CR-05 virtualized DOM | Uzavřeno pro podporovaný scroll model | Virtualized fixture akumulovala 6/6 conversations i messages, `complete=true`; Send/Delete canary zůstal neaktivní. Fyzický top/bottom bez explicitního LinkedIn end markeru zůstává heuristika. |
| CR-06 parser/pagination | Částečně otevřeno, viz RR-02 | Relative paging, synthetic JSON cursor a druhá history page fungují; completeness a Rest.li cursor ne. |
| CR-07 fallback collisions | Otevřeno, viz RR-03 | Opakované stejné snapshoty projdou, disjunktní stejné pagination dávky se stále ztratí. |
| CR-08 account identity | Uzavřeno pro review scénáře | Captured stable account candidate se používá; obecný `/feed/` odkaz už není profile identity. |
| CR-09 partial overwrite/exit | Mechanismus uzavřen; může jej obejít RR-02 | Partial zapisuje `.partial`, main zůstal byte-identický a CLI vrací 5. |
| CR-10 PowerShell CLI | Uzavřeno pro dokumentovanou cestu | README používá `npm.cmd`; space-separated options se zachovaly a neznámý flag skončil `CONFIG_INVALID`, exit 2. |

### Ověření při re-review

- `npm.cmd run check`: **PASS** — 8 test files / 35 tests, typecheck i build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- WebSocket probe přes skutečný fresh persistent `launchContext`: **PASS** — 0
  serverových upgrades/frames, 1 blokovaný WebSocket, operational page vznikla až po
  guardu.
- Persisted service-worker probe: **FAIL / CRITICAL** — po reopen v export mode byl
  worker aktivní a lokální server přijal POST mimo guard (RR-01).
- Virtualized DOM + mutation canary: **PASS** — 6/6 list items, 6/6 messages,
  `complete=true`, žádný Send/Delete handler se nespustil.
- Alias/direction/URN: původní reprodukce **PASS**; rozšířený raw alias/fallback probe
  **FAIL** podle RR-03.
- Partial persistence: **PASS** — candidate obsahoval 2 messages, main 1 message a
  SHA-256 hlavního souboru zůstal byte-identický.
- Strict PowerShell CLI: **PASS** — `npm.cmd` zachovalo `--limit 17`; neznámý flag
  vrátil `CONFIG_INVALID`, exit 2, před browser launch.
- Fresh dočasný profile/output network-only smoke: **PASS pro auth fail-closed** —
  `AUTH_REQUIRED`, exit 3, nevznikl main ani `.partial`; manifest měl 16 povolených
  HTTP requests, 0 blocked HTTP a žádný WebSocket.
- Persistent startup-page probe: **PASS** — Chromium neobnovil seed stránku;
  0 startup HTTP/POST/WebSocket požadavků před guardem.
- `git diff --check`: **PASS** i po doplnění této sekce. Re-review nepoužil LinkedIn
  credentials, přihlášenou session ani thread-open fallback.

---

## Třetí re-review opraveného HEAD `074c096`

### Verdikt třetího re-review

**RR-01 je uzavřený a nebyl nalezen žádný zbývající Critical ani High problém,
který by umožňoval zápis na LinkedIn.** Export nově vzniká ve fresh ephemeral
contextu pouze ze serializovaného `storageState`; service worker z persistentního
profilu se nepřenese, nové workery jsou blokované a HTTP POST i WebSocket jsou
zastavené před serverem.

Projekt ale ještě není připravený označit za hotový ani považovat skutečný export za
úplný. **RR-02 zůstává otevřený jako High pro integritu dat:** neparsovatelný
standalone event na kořeni REST `elements` se nezapočítá jako parser miss a běh může
zapsat neúplná data do hlavního JSON. Proto zatím nedoporučuji vyžadovat reálný login;
nejprve je vhodné opravit TR-01, aby se uživatelův první běh nemohl tvářit jako úplný.
Po této opravě je z hlediska account-side mutací rozumné vyžádat
`npm.cmd run login` a spustit pouze network-only `npm.cmd run export -- --limit 100`
bez `--allow-thread-open`.

### Zbývající High nález

#### TR-01 / RR-02 — HIGH — Standalone REST event může zmizet bez parser miss a historie zůstane `complete`

- **Soubor/řádky:** `src/linkedin/network/response-parser.ts:103-127`,
  `src/linkedin/network/response-parser.ts:151-157`,
  `src/linkedin/network/response-parser.ts:177-190`,
  `src/linkedin/network/response-parser.ts:193-214`,
  `src/linkedin/exporter.ts:98-125`
- **Problém:** opravené počítání `parserMisses` existuje pouze uvnitř
  `conversationFrom`, tedy pro `events/messages` v conversation wrapperu. REST
  obálka může mít message eventy přímo v kořenovém `elements`. Ty parser zpracuje
  jednotlivě přes `nestedMessages`; úspěšný event vytvoří syntetickou conversation,
  ale neznámý/attachment-only event se beze stopy zahodí. Následné
  `applyRestEnvelopeHistoryEvidence` vidí u syntetické conversation nula misses a
  z envelope `paging` nastaví `historyComplete: true`.
- **Nezávislá reprodukce:** lokální anonymní payload obsahoval v kořenovém
  `elements` dva eventy stejné conversation: první s podporovaným textem a druhý s
  neznámým `unsupportedCard`; `paging={start:0,count:2,total:2,hasNextPage:false}`.
  Aktuální HEAD vrátil jen ID `KNOWN`, ale současně
  `sourceMetadata.historyComplete === true`, bez `parserMisses`, a
  `parsed.misses === 0`. Reprodukční test očekávající právě tento chybný stav prošel.
- **Dopad:** `manifest.counts.parserMisses` zůstane 0, `passiveHistoryComplete` může
  být true a `partial` false. `persistExportResult` pak nepoužije `.partial`, ale
  sloučí neúplný výsledek do hlavního `messages.json`. Ochrana posledního úplného
  exportu je tak stále obejitelná.
- **Doporučení:** při zpracování history REST resource evidovat všechny kandidátní
  eventy v konkrétní envelope ještě před filtrováním. Každý event, který vypadá jako
  message/event, ale `messageFrom` jej nezachová, musí zvýšit resource i conversation
  parser miss a zneplatnit příslušný history evidence page. Přidat trvalou fixture s
  top-level validním a neznámým eventem a testovat `misses > 0`,
  `historyComplete === false` a následné uložení pouze do `.partial` s exit code 5.

### Stav RR-01 až RR-04 na `074c096`

| Nález | Stav | Důkaz / poznámka |
| --- | --- | --- |
| RR-01 persistent service worker | **Uzavřeno** | Do fresh persistent profilu byl skutečně nainstalován aktivní worker; po uložení jen `storageState` a otevření přes aktuální export platilo 0 workers, 0 server POST, 0 WebSocket upgrades, `blockedRequests=1` a `blockedWebSockets=1`. |
| RR-02 parser/completion/cursor | **Částečně otevřeno — High TR-01** | Miss uvnitř conversation wrapperu správně vynutí incomplete; dvě REST stránky dají per-conversation complete a existující Rest.li `(cursor:old,count:20)` se přepíše. Standalone miss ale selže podle TR-01. |
| RR-03 fallback/alias/schema | **Uzavřeno pro reprodukované scénáře** | Disjunktní pages 2+2 dávají 4, opakovaný snapshot 2; kombinace ID+URN / pouze URN / pouze ID dává jednu raw message. Schema odmítne duplicate conversation/participant/message IDs, mismatch conversation reference i neexistující sender reference. |
| RR-04 name-only DOM participant | **Uzavřeno** | Pokud existuje autoritativní network participant, name-only DOM participant se nepřidá. |

### Ověření při třetím re-review

- `npm.cmd run check`: **PASS** — 9 test files / 42 tests, typecheck i build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- Persistent-SW seed -> storageState -> ephemeral export: **PASS** — worker byl v
  seed profilu aktivní, v exportu 0 workers a lokální server obdržel 0 POST i 0
  WebSocket upgrades. Storage state přenesl testovací local storage, nikoliv worker.
- HTTP/WebSocket guard a lokální mutation canary: **PASS** — 1 POST a 1 WebSocket
  byly zablokované; Send/Delete canary se neaktivovala. Virtualizovaná fixture
  akumulovala 6/6 conversations a 6/6 messages.
- Wrapped parser miss: **PASS** — neznámý event znamená `historyComplete:false`,
  `parserMisses:1`; standalone parser miss: **FAIL / HIGH** podle TR-01.
- REST history/pagination: **PASS** pro dvě stránky a per-conversation completion;
  **PASS** pro náhradu existujícího Rest.li cursoru. Zbytkové fail-closed omezení:
  první Rest.li template `variables=(count:20)` bez již přítomného cursor key neumí
  pozorovaný `endCursor` vložit a nevrátí next URL; podle dostupných fixtures to
  vede spíše k partial než k account-side mutaci, ale reálné obálky je nutné ověřit.
- Raw merge/schema: **PASS** — 2+2 -> 4, repeated 2, all-alias -> 1; duplicate
  participant a broken sender/conversation reference jsou odmítnuty.
- Fresh missing-state CLI smoke s vlastními dočasnými cestami: **PASS** — přes
  `npm.cmd` se zachoval `--limit 17`, proces skončil `AUTH_REQUIRED`/exit 3 a
  nevznikl main, `.partial`, manifest ani browser request. Neznámý flag skončil
  `CONFIG_INVALID`/exit 2 před browser launch.
- Partial persistence/exit z integračního testu: **PASS** — partial jde vedle main a
  CLI vrací 5. TR-01 je však cesta, která partial nesprávně nenastaví.
- Git/secret kontrola: trackovaný je pouze `data/linkedin/.gitkeep`; `.auth` storage
  state, hlavní export, `.partial`, diagnostics a `.env` jsou ignorované. Review
  nečetlo ani nepoužilo existující `.auth`, credentials nebo LinkedIn session.

### Zbytková rizika

Bez přihlášené session nebyly a neměly být ověřeny současné produkční LinkedIn
REST/Voyager/GraphQL obálky, reálných 100 konverzací, plná historie ani opakovaný
idempotentní produkční běh. Windows `mode: 0o600` také není náhradou za explicitní
NTFS ACL a uživatelský custom `--state-file` mimo `.auth/` nemusí být automaticky
gitignored; výchozí dokumentovaná cesta je ignorovaná správně. DOM thread fallback
zůstává pouze výslovný opt-in, protože samotné otevření vlákna může změnit read/unread
stav.

---

## Finální úzký re-review HEAD `d093528`

### Verdikt

Oprava uzavírá přesně reprodukovaný TR-01 pro top-level REST **event objekty**:
validní event se zachová včetně participant dat z `included`, neznámý event dá
`misses:1`, `parserMisses:1`, `historyComplete:false` a `partial:true`; kandidát se
uloží pouze do `.partial`, hlavní soubor zůstane byte-identický a partial CLI cesta
vrací exit 5.

**Critical nálezy: žádné. Account-side mutation Critical/High: žádné. Zůstává ale
jeden High nález úplnosti dat (FR-01), proto zatím nedoporučuji vyžádat skutečný
login ani spouštět produkční export.** Po rozšíření téže opravy na referenced
top-level elements bude z hlediska ověřených safety invariantů bezpečné požádat
uživatele o `npm.cmd run login` a poté spustit pouze network-only
`npm.cmd run export -- --limit 100`, bez `--allow-thread-open`.

### FR-01 / TR-01 — HIGH — Referenced top-level REST event stále zmizí bez parser miss

- **Soubor/řádky:** `src/linkedin/network/response-parser.ts:155-180`,
  `src/linkedin/network/response-parser.ts:224-253`,
  `src/linkedin/exporter.ts:98-125`
- **Problém:** `restEnvelopeElements(payload).filter(record)` zahodí URN string
  references dříve, než je může resolver převést přes již vytvořený `index` z
  `included`. Rekurzivní `nestedMessages` pak sice z `included` zachová validní event,
  ale neparsovatelný referenced event zmizí a nevstoupí do `standaloneMisses`.
- **Nezávislá reprodukce:** history payload měl
  `elements=['urn:...:KNOWN-REF','urn:...:UNKNOWN-REF']`, oba event objekty a sender
  profile v `included` a finální `paging={start:0,count:2,total:2,hasNextPage:false}`.
  Výsledek obsahoval pouze `KNOWN-REF`, ale `parsed.misses === 0`, bez
  `parserMisses`, a `historyComplete === true`.
- **Dopad:** stejně jako původní TR-01 může být neúplný výsledek označen jako úplný a
  sloučen do hlavního JSON místo `.partial`. To je v rozporu s požadavkem parseru na
  běžné Voyager/GraphQL included/reference obálky.
- **Doporučení:** top-level elements nejprve resolve-nout (`record(value) ? value :
  typeof value === 'string' ? index.get(value) : undefined`) a teprve nad rozřešenými
  message candidates počítat parsed/missed. Trvalý negativní test má použít dvě URN
  references do `included` a ověřit stejný partial/main/exit kontrakt jako nový
  object test.

### Ověření

- `npm.cmd run check`: **PASS** — 9 test files / 43 tests, typecheck i build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- Cílené parser/store/CLI testy: **PASS** — object TR-01, `.partial`, byte-stable
  main a exit 5. Vlastní přímý object probe vrátil `misses=1`, `historyComplete=false`,
  validního participanta a `partial=true`.
- Ephemeral storageState/SW/HTTP/WebSocket regression: **PASS** — service worker se
  nepřenesl ani nezaregistroval a lokální POST/WebSocket nedorazily na server.
  Mutation canary i virtualized DOM testy také prošly.
- Fresh missing-state smoke: **PASS** — `AUTH_REQUIRED`, exit 3, bez main,
  `.partial`, manifestu nebo browser requestu.
- Review nepoužilo LinkedIn, credentials ani existující session; implementační kód
  nebyl změněn.

---

## Definitivní verifikace HEAD `e0cd6a7`

### Verdikt

FR-01 pro top-level URN references je opravený: kombinace známé a nepodporované
message reference v `included` vrací jednu ze dvou zpráv, `misses=1`,
`parserMisses=1`, `historyComplete=false` a partial-only zápis při byte-identickém
main. Nerozřešená message reference přidá právě jeden miss, profilová reference
žádný; opakované references se nenásobí a cyklus skončí bezpečně.

**Critical nálezy: žádné. Account-side mutation Critical/High: žádné. Zůstává jeden
High nález integrity dat FV-01. Proto ještě nelze bezpečně označit projekt za hotový
ani doporučit reálný login/export.** Po opravě FV-01 bude podle všech dosavadních
safety reprodukcí možné požádat uživatele o `npm.cmd run login` a následně spustit
výhradně network-only `npm.cmd run export -- --limit 100`, bez
`--allow-thread-open`.

### FV-01 — HIGH — Top-level zprávy bez ID se tiše sloučí při nulovém miss

- **Soubor/řádky:** `src/linkedin/network/response-parser.ts:166-180`,
  `src/linkedin/network/response-parser.ts:243-256`,
  `src/linkedin/exporter.ts:98-125`
- **Problém:** při přidávání `nestedMessages` se duplicita testuje výrazem
  `(m.entityUrn ?? m.id) === (message.entityUrn ?? message.id)`. U všech zpráv bez
  LinkedIn ID/URN jsou obě strany `undefined`, takže po první zprávě parser zahodí
  každou další zprávu stejné conversation. Pro obsahově identické bez-ID objekty je
  ještě dříve zkolabuje `uniqueEnvelopeElements` podle content hashe; tím se ztratí
  multiset, který raw merge a ordinal fallback ID výslovně zachovávají.
- **Nezávislá reprodukce:** finální REST history envelope obsahovala dva top-level
  event objekty bez `id/entityUrn`, oba s validním conversation/sender/timestamp/text
  tvarem a `paging={start:0,count:2,total:2,hasNextPage:false}`. Jak dvě obsahově
  identické kopie, tak silnější varianta s rozdílným textem a časem vrátily pouze
  první message, `parsed.misses=0` a `historyComplete=true`.
- **Dopad:** dostupná historie se může zkrátit bez `.partial`; neúplný výsledek se
  sloučí do hlavního JSON. Jde o přímý návrat datové ztráty z CR-07 pro samostatnou
  REST cestu a porušení požadovaných deterministických fallback/ordinal IDs.
- **Doporučení:** stable-ID deduplikaci provádět pouze tehdy, když alespoň jeden
  skutečný alias existuje. Bez-ID zprávy zachovat jako ordered multiset a párovat až
  přes již implementovaný source-page/fingerprint mechanismus; dvě top-level položky
  z jedné response musí zachovat svou multiplicitu/source order. Přidat test alespoň
  se dvěma různými bez-ID zprávami a kolizní variantu se dvěma identickými zprávami;
  obě musí dát dvě messages a stabilní odlišná ordinal IDs.

### Stav všech Critical/High

| Oblast | Stav na `e0cd6a7` |
| --- | --- |
| HTTP/WebSocket/service-worker read-only boundary | **Uzavřeno**, žádný Critical/High account-side mutation nález. |
| Direction, sender reference a composite URN | **Uzavřeno** pro reprodukované obálky. |
| Partial/main/exit ochrana | **Uzavřeno**, pokud parser správně přizná miss; FV-01 ji stále obchází. |
| Wrapped, object a referenced parser misses | **Uzavřeno** včetně unresolved/cycle/duplicate URN references. |
| Fallback multiset a raw alias merge | **Otevřeno — High FV-01 pouze pro top-level bez-ID eventy**; dříve opravené page/alias scénáře dál procházejí. |
| Ostatní dříve evidované Critical/High | **Uzavřeno pro dosavadní lokální reprodukce**. |

### Ověření

- `npm.cmd run check`: **PASS** — 9 test files / 46 tests, typecheck i build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- Cílené parser/store/CLI testy: **PASS** — referenced 1/2, participant z
  `included`, miss/incomplete, partial-only, byte-stable main a exit 5; unresolved
  message, profile reference, duplicate references a cyklus také prošly.
- Ephemeral storageState, service-worker, POST/WebSocket guard, mutation canary a
  virtualizovaný DOM: **PASS** v cíleném lokálním běhu.
- Fresh missing-state smoke: **PASS** — `AUTH_REQUIRED`, exit 3, žádný main,
  `.partial`, manifest ani browser request.
- `git diff --check`: **PASS**. Review nepoužilo LinkedIn, credentials ani existující
  session a nezměnilo implementační kód.

---

## Finální závěr pro HEAD `fdce32f`

### Definitivní verdikt

**Nezůstává žádný reprodukovatelný Critical ani High nález v dosud otevřených
oblastech. FV-01 je uzavřený a read-only safety boundary zůstala bez regrese.**

**GO:** je nyní bezpečné požádat uživatele, aby ručně spustil
`npm.cmd run login`, a po úspěšném přihlášení provést pouze network-only export:

```powershell
npm.cmd run export -- --limit 100
```

První skutečný běh musí zůstat bez `--allow-thread-open`. Pokud skončí partial/exit
5, má se vyhodnotit pouze `.partial` kandidát; nesmí se automaticky přejít na DOM
thread fallback, protože otevření vláken může změnit read/unread stav.

### Stav všech dosavadních Critical/High

| Oblast | Finální stav |
| --- | --- |
| HTTP, redirect, WebSocket a service-worker read-only boundary | **Uzavřeno** |
| Direction/sender/participant reference a composite URN | **Uzavřeno** |
| Partial-only zápis, byte-stable main a exit 5 | **Uzavřeno** |
| Wrapped, object, referenced a unresolved parser miss | **Uzavřeno** |
| REST/Rest.li pagination a per-conversation completion | **Uzavřeno pro anonymizované reprodukce** |
| Raw aliases, fallback multiset, schema unikátnost a opakovaný merge | **Uzavřeno** |
| Virtualizovaný DOM a mutation canary | **Uzavřeno pro lokální fixture; thread-open zůstává opt-in** |
| FV-01 id-less top-level event multiplicity | **Uzavřeno** |

### Nezávislé reprodukce FV-01

- Dvě různé id-less top-level REST messages: **2/2**, `misses=0`,
  `historyComplete=true`, dvě různá deterministická fallback IDs.
- Dvě obsahově identické id-less messages: **2/2**, deterministická unikátní IDs
  `message_…` a `message_…_2`.
- Opakované parsování stejné source page a `coalesceRaw`: stále **2**, ne 4; IDs se
  mezi normalizacemi nemění.
- Opakovaný finální `mergeExports`: první i druhý run mají **2 messages**, dvě
  unikátní stejná IDs a `exportedMessageCount=2`.
- Opakovaná stabilní top-level URN reference: **1 message**, `misses=0`,
  `historyComplete=true`.
- Dřívější known+unsupported URN refs, unresolved message ref, profile ref,
  duplicate refs a reference cycle testy dál procházejí fail-closed kontraktem.

### Finální ověření

- `npm.cmd run check`: **PASS** — 9 test files / 49 tests, typecheck i build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- Cílené session-isolation, service-worker, POST/WebSocket guard, DOM mutation canary
  a virtualized tests: **PASS**.
- Fresh missing-state export: **PASS** — `AUTH_REQUIRED`, exit 3, bez main,
  `.partial`, manifestu nebo browser requestu.
- `git diff --check`: **PASS**. Review nepoužilo LinkedIn, přihlašovací údaje ani
  existující session; implementační kód nebyl změněn a review nebylo commitováno.

Zbytkové provozní riziko je stejné jako v předchozích sekcích: současné neveřejné
LinkedIn obálky lze potvrdit až prvním uživatelským network-only během. Neznámý tvar
musí skončit partial, nikoliv oslabením guardu nebo automatickým otevřením vláken.

---

## Runtime review změn `cf7aa77..6a68e30`

### Verdikt

**Critical nálezy: žádné. Otevřené jsou dva High a tři Medium nálezy.** Nové
adaptéry pro aktuální Dash GraphQL úspěšně parsují ověřenou anonymizovanou obálku a
základní POST/WebSocket/service-worker/redirect ochrany nebyly v tomto rozsahu
oslabeny. Přesto nyní nelze slíbit absolutní read-only hranici ani pravdivou
úplnost výsledku: zakázaný GET lze schovat percent-encodingem a počet inertních DOM
řádků může zakrýt chybějící network conversations.

**NO-GO pro nabídnutí opt-in otevření jednoho již přečteného vlákna.** Nejdřív je
nutné uzavřít RT-01. Navíc současný `--allow-thread-open` není omezen na jedno
vlákno: `src/linkedin/exporter.ts:69-72` iteruje přes všechny vyexportované
konverzace. Bez samostatného parametru s jedním předem ověřeným conversation URL/ID
by nabídka „otevřít právě jedno“ neodpovídala skutečnému chování. Po opravě guardu a
přidání one-thread scope lze takový krok nabídnout pouze jako výslovný opt-in nad
již přečteným vláknem; běžný export musí dál zůstat network-only.

### RT-01 — HIGH — Percent-encoded mutation token obchází browser i přímý GET guard

- **Soubor/řádky:** `src/browser/request-guard.ts:7-17`,
  `src/linkedin/network/read-client.ts:5-12`
- **Problém:** oba guardy hledají zakázaná slova v raw `url.pathname` a
  `url.search`. WHATWG `URL` percent-encoding v těchto vlastnostech zachová, zatímco
  server/query parser ho běžně dekóduje. Exact origin i nový exact Dash path jsou
  správně kontrolované, jejich query ale canonicalizovaná není.
- **Nezávislá reprodukce:** `requestPolicy('GET', ...)` i
  `assertAllowedReadUrl(...)` povolily všechny tyto vstupy:
  `.../messaging/%73%65%6e%64Message`,
  `.../voyagerMessagingGraphQL/graphql?queryId=%6d%75%74%61%74%69%6f%6e` a
  `.../messaging/messages?operation=%6d%61%72%6b%52%65%61%64`. Nezakódovaná
  mutation query je blokovaná. Cizí host, suffix `/graphql/extra` v přímém klientu
  a redirect byly blokované; `readJson` používá `maxRedirects: 0` a 3xx nikdy
  nenásleduje.
- **Dopad:** metoda zůstává GET a všechny write metody jsou blokované, ale ochrana
  proti GET endpointům/GraphQL operacím typu send/markRead není úplná. To porušuje
  hlavní bezpečnostní invariant projektu i bez důkazu, zda konkrétní současný
  LinkedIn endpoint takový GET akceptuje.
- **Doporučení:** před policy kontrolou bezpečně a omezeně canonicalizovat path a
  každé query jméno i hodnotu (`URLSearchParams`), odmítnout malformed/double-encoded
  varianty a testovat single/double encoding všech zakázaných tokenů v obou
  guardech. HTTP method, exact origin/path a no-redirect podmínky zachovat.

### RT-02 — HIGH — Inertní DOM limit může označit kratší network export jako úplný

- **Soubor/řádky:** `src/linkedin/dom/conversation-list.ts:71-96`,
  `src/linkedin/exporter.ts:52-66`, `src/linkedin/exporter.ts:106-111`
- **Problém:** nové inertní řádky bez ID/URL se správně nepromění na konverzace,
  ale `observedRows >= limit` nastaví `reason='limit'` a `complete=true`. Exporter
  pak počítá `listCoverageComplete = raw.length >= limit || domList.complete`, i když
  počet rozpoznaných network/DOM konverzací je menší než limit.
- **Nezávislá reprodukce:** pro `limit=100`, 100 pozorovaných inertních řádků a 80
  raw network conversations vyjde `domList.complete=true`,
  `listCoverageComplete=true`; při úplných jednotlivých historiích a nulovém parser
  miss vrátí `coverageIsPartial(...) === false`. Chybějících 20 conversation shape
  přitom nemusí vytvořit message parser miss.
- **Dopad:** neúplný export se může zapsat jako úspěšný hlavní JSON, přestože nesplní
  požadovaný limit. Aktuální lokální `.partial` kandidát tento latentní stav nemá
  (`100/100` konverzací) a zůstává partial kvůli nepotvrzené historii.
- **Doporučení:** důvod `limit` považovat za úplný jen při `raw.length >= limit`.
  U inertních řádků evidovat zvlášť UI coverage a resolved conversation coverage;
  každá mezera mezi pozorovaným a rozřešeným počtem musí dát warning a partial.
  Také `end` smí potvrdit úplnost jen s explicitním total/mapping důkazem.

### RT-03 — MEDIUM — „Redacted“ diagnostics propouští alfabetické opaque IDs/text

- **Soubor/řádky:** `src/io/diagnostics.ts:49-72`,
  `src/io/diagnostics.ts:93-114`, `src/browser/request-guard.ts:22-38`
- **Problém:** libovolný lowercase/camelCase segment nebo JSON/query key odpovídající
  `^[*$]?[a-z][A-Za-z_]{0,63}$` je považován za strukturální. Heuristika nepozná
  čistě alfabetické dynamické ID, jméno ani text na náhodné/blocked cestě. Loggerova
  field-name redakce takovou hodnotu následně také nezakryje.
- **Nezávislá reprodukce:** `redactedPathShape('/random/pavelprivate')` vrací stejný
  text; `queryParameterNames(...?pavelPrivate=value&token=value)` vrací
  `['<redacted-key>', 'pavelPrivate']`; strukturální podpis objektu s klíčem
  `pavelPrivateConversation` uloží tento název do key paths. Primitive hodnotu
  `secret-value` podpis správně neuložil.
- **Dopad:** defaultní, ignorovaný lokální manifest/log může obsahovat identifikátor
  nebo uživatelský text vložený do path/key, včetně blocked random POST/WS path.
- **Doporučení:** použít úzký allowlist skutečně známých strukturálních path segmentů
  a schema/query klíčů; vše ostatní ukládat jako `:opaque`/`<opaque-key>`. Přidat
  canary testy bez číslic a bez slov `token/secret/auth`.

### RT-04 — MEDIUM — Duplicitní preview může přiřadit jméno nesprávné osobě

- **Soubor/řádky:** `src/linkedin/exporter.ts:164-189`
- **Problém:** enrichment vyžaduje právě jednu odpovídající konverzaci pro právě
  zpracovávaný hint, ale nevyžaduje právě jeden DOM hint pro daný preview. Pokud
  mají dva řádky stejný snippet a parser zná jen jednu odpovídající konverzaci,
  první hint vyhraje a druhý je přeskočen přes `used`.
- **Nezávislá reprodukce:** jedna raw conversation se zprávou „Thank you for your
  interest in this role“ a dva hinty se stejným snippetem, ale jmény „Wrong First
  Row“ a „Actual Second Row“, vedla k `enriched=1` a přiřazení „Wrong First Row“.
- **Dopad:** stabilní ID a direction se nemění, ale participant/sender metadata může
  být věcně nesprávné právě při neúplné network list coverage.
- **Doporučení:** před enrichmentem vytvořit globální bijekci preview→hint a
  preview→conversation; obě strany musí mít právě jeden prvek a konfliktní jména se
  musí přeskočit s warningem. Volné `includes` párování dále zpřísnit.

### RT-05 — MEDIUM — Pagination derivace nepovoluje nový Dash GraphQL endpoint

- **Soubor/řádky:** `src/linkedin/network/read-client.ts:5-12`,
  `src/linkedin/network/response-parser.ts:419-434`
- **Problém:** přímý reader nově přesně povoluje
  `/voyager/api/voyagerMessagingGraphQL/graphql`, ale `normalizePaginationUrl` a
  `deriveQueryUrl` stále připouštějí jen `/voyager/api/(messaging|graphql)`.
- **Nezávislá reprodukce:** current Dash fixture se stejným source URL a root
  `paging.links[0].href='?queryId=messengerConversations&start=1&count=1'` vrátila
  `paginationUrls=[]`.
- **Dopad:** delayed GET lze zachytit pasivně, ale explicitní href/start/cursor pro
  další moderní page se nevygeneruje ani nenačte. U historie to zpravidla skončí
  fail-closed; u listu v kombinaci s RT-02 může chybějící stránka zůstat nepřiznaná.
- **Doporučení:** sdílet jediný exact read-path predicate mezi klientem a pagination
  derivací a přidat anonymizovaný multi-page fixture pro moderní endpoint včetně
  relative href, Rest.li start/count a cursor varianty.

### Co bylo ověřeno bez nálezu

- Request guard v review rozsahu nezměnil method policy; POST/PUT/PATCH/DELETE dál
  blokuje. WebSocket guard je instalován před export page a session-isolation test
  potvrzuje nulový přenos persistentního service workeru a blokaci POST/WS.
- Exact moderní read URL projde, cizí host a suffix path v `assertAllowedReadUrl`
  neprojdou. `readJson` má `maxRedirects: 0` a 3xx vždy skončí
  `READ_POLICY_BLOCK`, i kdyby target sám prošel allowlistem.
- Current Dash fixture dává právě jednu conversation `CONV-ONE`, participant IDs
  `SELF/EXT`, message `EVENT-ONE`, správný backend conversation, body „Modern Dash
  message“, sender `EXT` a po normalizaci `direction=inbound`; embedded conversation
  reference nevytvoří duplikát. Jeden unsupported event dává `misses=1`,
  `parserMisses=1`, `historyComplete=false`.
- Inertní DOM collector pouze čte a mění `scrollTop`; nevolá click a bez ID/URN/URL
  nevymýšlí conversation ID. Virtualized/delayed list testy prošly a výsledný raw
  seznam je oříznut na `limit`; RT-02 se týká pravdivosti completion příznaku.
- Reálný `data/linkedin/messages.json.partial` prošel `ExportSchema`: schema v1,
  `partial=true`, requested `100`, declared/actual conversations `100/100`,
  declared/actual messages `100/100`, 200 participant records; warning kategorie
  jsou `LIST_SCROLL_LIMIT` a `THREAD_HISTORY_NOT_CONFIRMED`. Review nevypisovalo
  žádná jména, ID ani text zpráv.
- Git: `.auth/`, hlavní/partial exporty a diagnostics jsou ignorované; tracked je
  pouze `.env.example` s cestami a bezpečnými defaulty. High-entropy LinkedIn secret
  pattern v tracked souborech nenalezen. Existující `.auth` ani její obsah nebyly
  otevřeny.

### Testy

- `npm.cmd run check`: **PASS** — 11 test files / 56 tests, typecheck i build.
- Cíleně: request guard, network diagnostics, current parser, DOM fallback,
  session-isolation a WebSocket guard: **PASS** — 6 files / 30 tests.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- `git diff --check`: **PASS** před zápisem tohoto dodatku. Review nepoužilo
  LinkedIn, credentials ani existující session; implementační kód nebyl změněn a
  review nebylo commitováno.

---

## Re-review HEAD `4a47be0` (`770df43..4a47be0`)

### Verdikt

**Critical nálezy: žádné. Zůstávají dva High a dva Medium nálezy.** RT-02, RT-04
a RT-05 jsou v požadovaných reprodukcích uzavřené. RT-01 je opravený pro běžné,
single/double/deep percent-encoding, ASCII control, malformed encoding a Unicode
compatibility znaky, nikoliv však pro C1/Cf znaky. Allowlist RT-03 správně rediguje
alphabetický opaque path/query/JSON key, ale diagnostická hranice stále propouští
opaque hostname a thread ID z obecné chybové zprávy.

**NO-GO pro reálný `npm.cmd run probe:read-thread`.** Před opt-in během musí být
uzavřeny R2-01 a R2-02: guard musí fail-closed odmítat C1/Cf URL a probe musí před
první stránkou vynutit skutečný main-frame navigation budget, ne pouze počet volání
helperu. Běžný network-only export nesmí být nahrazen probe režimem.

### R2-01 / RT-01 — HIGH — C1 a Unicode format znaky stále rozdělí zakázaný token

- **Soubor/řádky:** `src/domain/url-safety.ts:8-25`,
  `src/browser/request-guard.ts:9-24`, `src/linkedin/network/read-client.ts:9-17`
- **Problém:** canonicalizace po každém decode odmítá pouze ASCII C0 a DEL
  (`U+0000..001F`, `U+007F`). C1 control znaky a Unicode category `Cf` zůstávají v
  řetězci, takže blacklist neuvidí zakázané slovo rozdělené takovým znakem.
- **Nezávislá reprodukce:** browser `requestPolicy` i přímý
  `assertAllowedReadUrl` povolily query tokeny `muta%C2%85tion` (C1 NEL),
  `muta%E2%80%8Btion` (zero-width space), `muta%C2%ADtion` (soft hyphen) a
  `muta%E2%80%AEtion` (bidi override). Naproti tomu single, double, osm i devět
  encoding vrstev, `%00`, `%09`, `%ZZ`, encoded query separator, fullwidth `ｍ` a
  mathematical-bold `𝐦` byly správně blokované v obou guardech.
- **Dopad:** není prokázáno, že současný LinkedIn backend tyto znaky před dispatch
  normalizuje nebo ignoruje. Pro absolutní no-mutation invariant je však URL s
  control/format znakem nejednoznačný vstup a nesmí fail-open projít až k serveru;
  stejná mezera platí pro pagination a probe request classification.
- **Doporučení:** před allowlist/blacklist kontrolou odmítnout minimálně celé Unicode
  kategorie `Cc` a `Cf` (včetně bidi/zero-width), případně také surrogate a
  line/paragraph separators. Zakázané operation/path tokeny ověřovat nad striktní
  ASCII gramatikou; nové testy musí běžet přes `requestPolicy`,
  `assertAllowedReadUrl`, pagination i `observedHistoryQueryTemplate`.

### R2-02 — HIGH — Jeden `goto` neomezuje probe na jeden skutečně otevřený thread

- **Soubor/řádky:** `src/linkedin/probe.ts:58-63`,
  `src/linkedin/probe.ts:65-91`, `src/browser/request-guard.ts:31-50`
- **Problém:** unit helper volá `page.goto` právě jednou, ale probe nemá žádný
  main-frame navigation/redirect gate. Už výběrové `page.goto('/messaging/')` může
  být HTTP nebo client-side přesměrováno na libovolný thread ještě před ověřením
  `read===true`; následný candidate `goto` může být přesměrován na jiný thread.
  Oba cíle jsou bezpečně vypadající GET a obecný request guard je dovolí. Manifest
  přesto bez měření nastaví `probeThreadNavigations = 1`.
- **Nezávislá reprodukce:** lokální Chromium server dostal při jediném
  `page.goto('/messaging/')` dva requesty, `/messaging/` a po 302
  `/messaging/thread/UNREAD/`; finální page URL byl druhý thread. Stejný redirect
  mechanismus Playwright používá pro LinkedIn a současná policy druhý GET thread URL
  neblokuje. Reprodukce nepoužila LinkedIn ani session.
- **Dopad:** změna routingu nebo redirect serveru může otevřít neověřený unread
  thread před výběrem a poté ještě jeden explicitní thread. Tím se poruší hlavní
  omezení probe a může se změnit read/unread stav účtu.
- **Doporučení:** ještě před první page instalovat probe-specific main-frame state
  machine. Ve selection fázi musí blokovat jakýkoli `/messaging/thread/...` target;
  po výběru smí jednorázově povolit pouze přesně canonical URL/ID ověřeného
  `read===true` kandidáta a odmítnout jiný thread v celé redirect chain i následné
  navigaci. Počet v manifestu odvozovat z reálně povolených main-frame requests.
  Přidat lokální test redirectu z listu i z candidate URL a client-side navigation.

### R2-03 — MEDIUM — Kandidátův `network-explicit` důkaz není svázaný s read endpointem

- **Soubor/řádky:** `src/linkedin/network/capture.ts:10`,
  `src/linkedin/network/capture.ts:39-45`, `src/linkedin/network/capture.ts:99-101`,
  `src/linkedin/network/response-parser.ts:163-177`, `src/linkedin/probe.ts:16-37`
- **Problém:** capture považuje za relevantní velmi široký path substring na
  libovolném `*.linkedin.com` a parser nastaví `readEvidence='network-explicit'`
  jen podle boolean pole `obj.read`. Zdrojový origin/path/method se do kandidáta
  nepřenese a `selectSafeProbeConversation` jej proto nemůže validovat proti exact
  read allowlistu ani zjistit konfliktní novější `read=false` reprezentaci.
- **Nezávislá reprodukce:** stejný syntetický conversation-shaped JSON s
  `read:true` a messagingThread URN byl parsován a vybrán jako bezpečný kandidát ze
  source `https://tracking.linkedin.com/random/conversation.json` i
  `https://www.linkedin.com/unrelated/conversation.json`; oba zdroje leží mimo
  `isAllowedLinkedInReadPath`.
- **Dopad:** field se sice skutečně získal z network response a `unreadCount=0` se
  správně neinferuje, ale jeho endpointová provenance a aktuálnost nejsou
  prokázané. U změněné/kolizní response shape může probe otevřít thread na základě
  jiného významu pole `read`.
- **Doporučení:** pro probe sbírat kandidáty jen z GET responses, jejichž exact
  origin/canonical path/query projde read policy a je klasifikován jako conversation
  list query. Uchovat ověřený source kind/evidence; po coalescingu odmítnout kandidáta
  s libovolným konfliktním `read=false` nebo bez jednoznačného nejnovějšího stavu.

### R2-04 / RT-03 — MEDIUM — Opaque origin a navigation error mohou stále vypsat ID

- **Soubor/řádky:** `src/browser/request-guard.ts:13-24`,
  `src/browser/request-guard.ts:40-47`, `src/logger.ts:4-13`,
  `src/cli.ts:29-35`, `src/linkedin/probe.ts:58-63`
- **Problém:** nový path/query/JSON allowlist funguje, ale blocked request ukládá
  `url.origin` beze změny. Obecná logger redakce z URL odstraní query, nikoliv path;
  Playwright `page.goto` chyba běžně obsahuje celý candidate thread URL.
- **Nezávislá reprodukce:** blocked POST na syntetický
  `https://pavelprivateconversation.example/random/pavelprivateconversation` by do
  manifestu uložil origin `https://pavelprivateconversation.example` (path byl
  správně `/:opaque/:opaque`). `redact({message: 'page.goto: ...
  https://www.linkedin.com/messaging/thread/pavelPrivateConversation/'})` zachoval
  celý thread ID v log message.
- **Dopad:** ignorovaný lokální manifest nebo konzolový/logovaný probe failure může
  obsahovat alfabetický opaque identifikátor. Samotné `probeHistoryQueries` tímto
  netrpí: vlastní save-manifest canary neobsahoval path ID ani query value.
- **Doporučení:** v request diagnostics ukládat pouze allowlisted origin family
  (`https://www.linkedin.com`, `https://*.linkedin.com`, `external`) a v loggeru
  redigovat URL pathname stejným contextual path redaktorem. Probe navigation chybu
  převést na generický `AppError` bez raw Playwright call logu.

### Uzavřené RT reprodukce a pozitivní ověření

- **RT-02 uzavřeno:** `listCoverageIsComplete(20, 100, 100) === false` a výsledné
  `coverageIsPartial(...) === true`. Inertní collector pro 40 řádků vrací nula
  vymyšlených conversations, `observedRows=40`, `complete=false`; pouze scrolluje.
- **RT-04 uzavřeno pro požadovanou ambiguity reprodukci:** jedna conversation a
  dva různé DOM names se stejným preview daly `enriched=0`, žádné přiřazené jméno a
  ambiguity callback. Preview je kontrolováno globálně na obou stranách.
- **RT-05 uzavřeno:** relative modern Dash href na exact
  `/voyager/api/voyagerMessagingGraphQL/graphql` vytvoří jednu page URL; mutation
  href nevytvoří žádnou. Předání unsafe pagination URL do followeru dalo
  `PAGINATION_URL_BLOCKED` a nula `request.get` volání.
- **RT-03 path/key část uzavřena:** `/random/pavelPrivateConversation` se uloží jako
  `/:opaque/:opaque`; stejný query/JSON key jako `<opaque-key>`. Primitive values se
  do structural signature neukládají. R2-04 popisuje zbývající origin/log mezeru.
- `assertAllowedReadUrl` blokuje cizí host, userinfo a suffix moderního exact path.
  `readJson` s `maxRedirects:0` nefollowoval safe ani foreign 302; fake request byl
  zavolán právě jednou a skončil `READ_POLICY_BLOCK`.
- Probe je default-off, nelze jej kombinovat s `--diagnostics-content`, CLI větev se
  vrací před exporterem a `src/linkedin/probe.ts` nepoužívá DOM thread extraction
  ani export store. Jediná DOM inspekce je auth-state detekce; response obsah se pro
  selection parsuje pouze v paměti a neukládá se. POST/WebSocket guard a blokace
  service workeru se instalují v export contextu před `newPage`.
- Synthetic observed-history template i uložený manifest obsahovaly jen `GET`,
  konstantní LinkedIn origin, redigovaný path shape a allowlisted query parameter
  names; žádný canary path ID ani query value. Helper candidate `goto` byl bez
  retry/loop zavolán jednou; R2-02 vysvětluje chybějící runtime redirect budget.
- Fresh missing-state `npm.cmd run probe:read-thread -- --state-file <missing>
  --output <temp>` skončil `AUTH_REQUIRED`, exit 3, bez main, `.partial` a
  diagnostics. Existující `.auth` ani session nebyly čteny.

### Testy a Git

- `npm.cmd run check`: **PASS** — 12 test files / 77 tests, typecheck i build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- `.auth/`, exporty a diagnostics jsou ignorované. V tracked souborech nebyl nalezen
  runtime secret/export artifact ani high-entropy LinkedIn secret pattern.
- `git diff --check`: **PASS** před zápisem dodatku. Review nepoužilo LinkedIn,
  credentials ani existující session; implementační kód nebyl změněn a review
  nebylo commitováno.

---

## Finální re-review HEAD `252f08f` (`f5c64e8..252f08f`)

### Verdikt

**Critical nálezy: žádné. Zůstávají dva High nálezy; nové Medium nálezy nejsou.**
Požadované přesné varianty R3-01, R3-03 a většina R3-02 jsou opravené: thread URL
pro libovolný resource/frame se zastaví před serverem, přesné REST/legacy/current
Dash varianty mimo allowlist se zastaví a oba document preflighty používají
samostatné zahazované request contexty. Rozšířená negativní matice ale našla dvě
další fail-open větve v nové probe policy: nově pojmenovaný messaging API namespace
a nerozpoznaný identity field uvnitř jinak povolených history variables.

**NO-GO pro skutečný one-read-thread probe.** `npm.cmd run probe:read-thread` zatím
uživateli nenabízet: oba níže uvedené requesty dosáhly v lokální runtime reprodukci
serveru a gate je ani nezapočítal jako blokované. Běžný network-only export bez
`--allow-thread-open`/bez probe zůstává od tohoto opt-in režimu oddělený.

### R4-01 / R3-02 — HIGH — Neznámý messaging namespace je klasifikován jako non-messaging a projde

- **Soubor/řádky:** `src/linkedin/probe-request-policy.ts:115-128`,
  `src/linkedin/probe-navigation.ts:180-198`, `src/browser/request-guard.ts:12-28`
- **Problém:** `messagingSurface` pozná pouze segmenty přesně
  `messaging`, `graphql` a `voyagerMessagingGraphQL`. Segment s novou příponou nebo
  novým explicitně messaging názvem vrátí `messaging:false`; probe pak použije
  `route.fallback()` a obecný guard libovolný GET bez známého mutation slova pustí.
  Komentář o blokaci každé REST/legacy/lookalike cesty tedy neplatí pro neznámý
  namespace. Totéž platí pro redirect request na takovou cestu, protože i ten je
  znovu klasifikován stejným fail-open způsobem.
- **Nezávislá reprodukce:** v lokálním Chromium běhu se skutečným pořadím obou route
  handlerů dostal server po jednom GET pro všechny čtyři target-page requesty:
  `/voyager/api/messagingV2/conversations/UNREAD/events`,
  `/voyager/api/graphqlV2?...`,
  `/voyager/api/voyagerMessagingGraphQLV2/graphql?...` a
  `/voyager/api/voyagerMessagingRest/conversations/UNREAD/events`.
  `crossThreadRequestsBlocked` zůstal `0`. Samostatná kompoziční kontrola potvrdila
  pro každý případ `probeMessaging=false`, `globalAllow=true`. LinkedIn ani session
  nebyly použity.
- **Dopad:** změna soukromého LinkedIn namespace může během selection nebo target
  fáze kontaktovat endpoint s jiným thread ID mimo jediný ověřený read target.
  Policy to nezastaví ani následně neoznačí běh jako unsafe; tím se vrací původní
  riziko otevření/označení unread threadu.
- **Doporučení:** v probe režimu klasifikovat celý same-origin `/voyager/api/**`
  prostor default-deny a propustit pouze explicitní phase-specific GET allowlist
  nezbytných endpointů. Pokud bootstrap vyžaduje další API, přidávat je jen jako
  přesné pozorované read tvary. Negativní testy mají zahrnout suffix/new-namespace
  varianty a redirect na ně a kontrolovat skutečný server count `0`.

### R4-02 / R3-02 — HIGH — Povolený target reference lze doplnit nerozpoznaným jiným ID

- **Soubor/řádky:** `src/linkedin/probe-request-policy.ts:50-69`,
  `src/linkedin/probe-request-policy.ts:98-112`,
  `src/linkedin/probe-request-policy.ts:140-143`
- **Problém:** JSON/Rest.li walker odmítá neznámé keys jen tehdy, když jejich název
  obsahuje `conversation`, `thread` nebo `urn`. Obecné identity keys `id`, `ids`
  nebo jiný nově zavedený alias ignoruje. Stačí proto do variables přidat
  allowlisted `conversationId=READ`; policy vidí právě jeden známý target a celý
  request povolí, i když stejné variables nesou `id=UNREAD`.
- **Nezávislá reprodukce:** obě exact-current history URL prošly probe i globálním
  guardem a lokální server je obdržel, zatímco blocked counter zůstal `0`:
  JSON `variables={"conversationId":"READ","id":"UNREAD"}` a Rest.li
  `variables=(conversationId:READ,ids:(UNREAD))`. Policy v obou případech hlásila
  `conversation-history` a jediný `referencedId=READ`; hodnotu `UNREAD` vůbec
  nezahrnula do rozhodnutí.
- **Dopad:** pokud současná nebo budoucí persisted query interpretuje obecný/nový
  field jako skutečnou conversation identitu, může exact povolený operation načíst
  jiný thread. Protože request zároveň vytvoří validní redigovanou history template,
  běh může skončit úspěšně místo fail-closed chyby.
- **Doporučení:** pro obě povolené history operace validovat celé `variables` proti
  striktní strukturální allowlist gramatice. Každý identity-like `*id`, `*ids`, URN
  nebo jiný nepovolený scalar/collection field musí request zablokovat; všechny
  rozpoznané identity musí být target alias. Stejnou kontrolu použít nad JSON i
  Rest.li a přidat server-count testy pro decoy target + cizí `id/ids`.

### Opravené R3 a znovu ověřené R2 reprodukce

- **R3-01 uzavřeno pro požadované resource varianty:** lokální testy pro `img`,
  iframe, object/subframe, prefetch a worker-fetch na thread URL skončily s unread
  server countem `0` a fail-closed violation. Pozdější direct `fetch()` na exact
  cached target rovněž neposlal druhý server GET. Target dokument měl právě jeden
  serverový preflight GET a jednu browser navigation splněnou z paměti.
- **Přesné R3-02 tvary fungují:** selection propustí pouze exact Dash list GET;
  exact REST, legacy GraphQL, case/trailing/current unknown-operation a missing,
  wrong či konfliktní `conversationId`/URN/JSON/Rest.li reference mají server count
  `0`. Correct direct/URN/JSON/Rest.li target aliases projdou. R4-01 a R4-02 jsou
  další varianty mimo tuto původní matici.
- **R3-03 uzavřeno:** selection a target preflight jsou dva samostatné
  `playwrightRequest.newContext` contexty se vstupní kopií storage state a vždy se
  disposeují. Syntetické selection i target `Set-Cookie` nezměnily browser cookie
  jar; selection cookie se neposlala targetu. Browser cached response neobsahovala
  `Set-Cookie`, `Location` ani opaque header. Target 302 se s `maxRedirects:0`
  zastavila před unread serverem.
- **R2 Unicode zůstává uzavřené:** 63/63 kombinací C1, Cf, Co, Cn, surrogate a
  U+FFFD v raw/single/double path, query name a query value zablokoval současně
  `requestPolicy` i `assertAllowedReadUrl`. Malformed, deeper encoding, NFKC
  fullwidth a host/userinfo varianty také zůstaly fail-closed.
- **R2 provenance/redaction zůstává uzavřené:** read evidence vznikne pouze z
  direct elementu exact GET Dash `messengerConversations`; nested/included,
  tracking/unrelated source, POST/chybějící method a konfliktní read stav kandidáta
  nezpůsobilí. Opaque origin/path/error/header/query canary nebyl v manifestu ani
  logger outputu; ukládají se pouze strukturální allowlist údaje.
- Probe zůstává default-off a CLI větev nepoužívá DOM thread extraction ani export
  store. Template map se do manifestu kopíruje až po `assertTargetSafe`; gate
  failure tedy žádnou template neuloží. Fresh missing-state běh skončil
  `AUTH_REQUIRED`, exit `3`, bez main, `.partial`, diagnostics i template souboru.
  Konzervativně nerozpoznaná/composite reference může způsobit pouze fail-closed
  nedostupnost probe, nikoli rozšíření povoleného provozu.

### Testy a Git

- `npm.cmd run check`: **PASS** — 15 test files / 113 tests, typecheck i build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- Cílené navigation/policy/Unicode/provenance/redaction testy: **PASS**; rozšířené
  R4-01/R4-02 adversarial runtime varianty: **FAIL** podle nálezů výše.
- `.auth/`, main/partial exporty a diagnostics jsou ignorované. V tracked obsahu
  nebyl nalezen runtime secret/export artifact ani konkrétní credential value;
  nalezené řetězce jsou pouze názvy secret fields v implementaci/testech/zadání.
- `git diff --check`: **PASS** před zápisem tohoto dodatku. Review nepoužilo
  LinkedIn, credentials ani existující session; implementační kód nebyl změněn a
  nic nebylo commitováno.

---

## Finální re-review HEAD `58892af` (`3ad0ee8..58892af`)

### Verdikt

**Critical nálezy: žádné. Zůstávají dva High a jeden Medium nález.** R2-01,
R2-03 a R2-04 jsou v požadovaných adversarial reprodukcích uzavřené. Nový cached
navigation postup také správně zastaví testované 302 a běžné main-frame/client-side
navigace. Jeho request gate je ale stále fail-open pro subresource/subframe thread
GET a pro messaging/GraphQL varianty, ze kterých extractor nedokáže získat ID.

**NO-GO pro skutečný `npm.cmd run probe:read-thread`.** Před opt-in během musí být
R3-01 a R3-02 uzavřené default-deny, phase-specific allowlistem. Jinak může již
selection dokument kontaktovat neověřený thread a target dokument může poslat
cross-thread nebo neznámý messaging GET, aniž by probe selhal. Běžný network-only
export zůstává oddělený a tyto nálezy nejsou důvodem zapínat probe automaticky.

### R3-01 / R2-02 — HIGH — Subresource a subframe obejdou one-thread navigation gate

- **Soubor/řádky:** `src/linkedin/probe-navigation.ts:149-170`,
  `src/linkedin/probe-navigation.ts:173-201`, `src/linkedin/probe.ts:110-135`
- **Problém:** gate předá každý non-navigation request přes `route.fallback()` a
  stejně předá navigaci vedlejšího frame. Pokud URL není rozpoznaná jako GraphQL s
  explicitním conversation ID, nevznikne violation ani blocked counter. Přímý
  `/messaging/thread/<id>/` subresource ani iframe žádný GraphQL ID nemá.
- **Nezávislá reprodukce:** lokální cached selection dokument obsahoval postupně
  `<img src=/messaging/thread/UNREAD/>`, iframe a prefetch na stejný syntetický
  unread thread. Ve všech třech případech server obdržel unread GET, zatímco
  `assertSelectionSafe()` prošel a `navigationAttemptsBlocked=0`,
  `crossThreadRequestsBlocked=0`. Reprodukce nepoužila LinkedIn ani session.
- **Dopad:** ještě před výběrem `read===true` kandidáta může stránka nebo změněný
  runtime načíst dokument neověřeného unread threadu. Pokud samotné načtení thread
  route nebo jeho skripty ovlivní read state, poruší to hlavní bezpečnostní účel
  probe; v každém případě je nepravdivý deklarovaný budget jednoho threadu.
- **Doporučení:** ve selection fázi blokovat thread route pro každý resource type a
  každý frame, ne pouze main-frame navigation. Po arm smí být browserová target
  navigace jen cached fulfill; jakýkoli další request na thread document musí být
  blokován. Přidat `<img>`, iframe, prefetch/preload a worker-fetch testy, které
  kontrolují skutečný server count i gate violation.

### R3-02 / R2-02 — HIGH — Neznámé REST/GraphQL messaging requesty procházejí fail-open

- **Soubor/řádky:** `src/linkedin/probe-navigation.ts:39-66`,
  `src/linkedin/probe-navigation.ts:149-156`, `src/browser/request-guard.ts:18-28`,
  `src/linkedin/network/read-policy.ts:1-6`
- **Problém:** cross-thread blokace nastane pouze při `referencedIds.size > 0`.
  Extractor podporuje case-sensitive exact GraphQL path a omezené URN/key tvary;
  nula rozpoznaných IDs znamená povolit request. Obecný read guard navíc záměrně
  připouští libovolný GET pod širokým `/voyager/api/messaging` nebo legacy
  `/voyager/api/graphql/` prefixem, pokud URL neobsahuje blacklistované slovo.
- **Nezávislá reprodukce:** všechny následující GET prošly `requestPolicy` i
  `assertAllowedReadUrl`, ale `explicitProbeGraphqlConversationIds` vrátil prázdný
  set: REST `/voyager/api/messaging/conversations/UNREAD/events`, GraphQL s
  `conversationId=UNREAD`, JSON variables s `{"conversationId":"UNREAD"}`,
  `/voyager/api/graphql/` s trailing slash a case varianta `/voyager/api/GraphQL`.
  Stejně projde neznámý messaging GET bez známého action tokenu. Standardní
  lowercase GraphQL `conversationUrn` canary je naopak blokovaný správně.
- **Dopad:** target HTML může načíst jiný thread přes podporovanou REST cestu nebo
  nepoznanou GraphQL obálku a probe přesto skončí úspěšně; request handler může jako
  jediný „history template“ uložit právě cross-thread tvar. U úplně neznámého GET
  endpointu nelze v absolutním no-mutation režimu bezpečně předpokládat read-only
  význam jen podle metody a absence několika slov.
- **Doporučení:** pro probe zavést phase-specific default deny. Selection smí
  používat pouze přesně rozpoznaný Dash conversation-list GET; armed fáze jen
  explicitně rozpoznaný history GET, jehož právě jedno ID patří target alias setu.
  Každý history/messaging request bez rozpoznatelného ID musí být blokován, nikoli
  povolen. Extractor sjednotit s canonical, case-insensitive exact path policy a
  doplnit REST path IDs i všechny reálně pozorované GraphQL variable keys; unknown
  path/operation testovat nulovým server countem.

### R3-03 — MEDIUM — Odstraněný `Set-Cookie` header přesto změní sdílený cookie jar

- **Soubor/řádky:** `src/linkedin/probe-navigation.ts:74-89`,
  `src/linkedin/probe-navigation.ts:173-188`, `src/linkedin/probe-navigation.ts:223-234`
- **Problém:** cached fulfill skutečně nepředá `Set-Cookie`, Location ani opaque
  response headers. Předcházející `route.fetch` a zejména
  `context.request.get`, který sdílí cookie storage BrowserContextu, však
  `Set-Cookie` z reálné response zpracovává ještě před sestavením safe headers.
- **Nezávislá reprodukce:** před target preflight byl lokální context cookie jar
  prázdný. Target odpověď obsahovala syntetický `Set-Cookie: targetPrivate=value`;
  bez browser target requestu už po `armTarget` jar obsahoval `targetPrivate`.
  Následný cached browser response správně neměl `set-cookie` ani opaque header a
  server viděl target URL jen jednou.
- **Dopad:** hodnoty se neukládají do manifestu ani storage-state souboru a context
  se po probe zavře, takže nejde o trvalý credential leak. Tvrzení, že response
  cookie není předána probe browser contextu, ale není pravdivé; nová/rotovaná
  session cookie může ovlivnit následné history requesty v témže běhu.
- **Doporučení:** selection i target dokument načíst izolovaným API request contextem
  se vstupní kopií potřebných auth cookies, jehož response cookies se nepropíší do
  browser contextu, a po načtení jej zahodit. Alternativní snapshot/restore musí
  přesně odstranit nově přidané i přepsané cookies. Test má kontrolovat
  `context.cookies()`, ne pouze fulfilled response headers.

### Uzavřené reprodukce

- **R2-01 uzavřeno:** 63/63 vlastních kombinací bylo blokováno současně v
  `requestPolicy` i `assertAllowedReadUrl`: raw/single/double formy v path, query
  name a query value pro C1, zero-width/soft-hyphen Cf, private-use, unassigned,
  surrogate a explicitní U+FFFD. Původní deep/malformed/fullwidth testy také prošly.
- **R2-03 uzavřeno pro požadovaný Dash tvar:** pouze direct element z exact GET
  `voyagerMessagingGraphQL/graphql?queryId=messengerConversations` získal
  `read=true/network-explicit`. Direct collection pod `data` i top-level root
  funguje; root `elements`, nested tracking a `included` conversation nikoliv.
  Chybějící method, POST, tracking/unrelated URL a konfliktní `read=false` nejsou
  způsobilé.
- **R2-04 uzavřeno:** syntetický alfabetický canary zmizel z blocked origin/path,
  obecného navigation error logu, query names/values i JSON/header diagnostics.
  Origin byl `<redacted-origin>`, path `/:opaque/:opaque`, thread error
  `/messaging/thread/:opaque`; response header hodnoty se do manifestu vůbec
  neukládají. R3-03 se týká runtime cookie efektu, ne redakce uložených dat.
- **Očekávané R2-02 scénáře prošly:** selection i target 302 byly zastavené před
  unread serverem; target preflight provedl jediný server GET a browser target
  navigation použila cache. `pushState`, `replaceState`, `location` redirect,
  popup a standardní cross-thread GraphQL `conversationUrn` skončily fail-closed.
  Location a opaque response headers se neforwardovaly. R3-01/R3-02 popisují
  varianty mimo pokrytí těchto pozitivních testů.
- Probe zůstává default-off, guard/service-worker blokace se instalují před page,
  nepoužívá export store ani DOM thread extraction. Při fresh missing-state běhu
  vrátil exit 3 a nevznikl main, `.partial`, diagnostics ani template. U gate
  selhání se template map nepřidává do manifestu před bezpečnostními assertions.

### Testy a Git

- `npm.cmd run check`: **PASS** — 14 test files / 99 tests, typecheck i build.
- Cílený URL/probe/parser/guard/config běh: **PASS** — 6 files / 67 tests.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- `.auth/`, exporty a diagnostics jsou ignorované. V tracked souborech nebyl nalezen
  runtime secret/export artifact ani high-entropy LinkedIn secret pattern.
- `git diff --check`: **PASS** před zápisem dodatku. Review nepoužilo LinkedIn,
  credentials ani existující session; implementační kód nebyl změněn a review
  nebylo commitováno.

---

## Závěrečný stav po review HEAD `252f08f`

Aktuální stav všech otevřených závažností je **Critical 0 / High 2 / Medium 0**.
Platí detailní nálezy R4-01 a R4-02 výše; dřívější R3-01 a R3-03 jsou uzavřené a
původní přesné varianty R3-02 jsou blokované. Definitivní verdikt pro reálný
one-read-thread probe je **NO-GO**, dokud obě nové fail-open větve nedostanou
default-deny opravu a server-count regresní testy. Implementace nebyla během review
změněna a nic nebylo commitováno.

---

## Úzký finální re-review HEAD `308577b`

### Verdikt

**Critical nálezy: žádné. High: jeden. Medium: žádné.** R4-01 je v požadované
namespace/encoding matici uzavřený a běžné `id`/`ids` varianty R4-02 se nyní
blokují. R4-02 ale není zcela uzavřený: parser ignoruje jednoznačnou foreign
conversation URN, pokud ji payload vloží pod neznámý key bez identity suffixu.

**NO-GO pro právě jeden skutečný `--probe-read-thread`.** Přestože exact GET
redirect izolace a všechny dřívější R3 ochrany prošly, níže uvedené exact history
requesty dosáhly lokálního serveru a `assertTargetSafe()` prošel. Probe zatím
uživateli nenabízet. Network-only export bez probe/thread-open režimu tímto nálezem
dotčen není.

### R5-01 / R4-02 — HIGH — Cizí conversation URN pod neznámým key se do identity rozhodnutí nedostane

- **Soubor/řádky:** `src/linkedin/probe-request-policy.ts:63-76`,
  `src/linkedin/probe-request-policy.ts:80-112`,
  `src/linkedin/probe-request-policy.ts:142-145`,
  `src/linkedin/probe-request-policy.ts:182-185`
- **Problém:** JSON walker primitivní string okamžitě vrátí a jeho hodnotu vůbec
  neprohlédne. Rest.li větev obdobně zpracuje field value jen tehdy, když key končí
  na `id/ids/urn/urns` nebo obsahuje několik semantic stems. Cizí, syntakticky
  jednoznačná conversation URN v `payload`, `value`, `refs` či jiném neznámém
  fieldu je proto ignorovaná. Současný target `conversationId=READ` stačí, aby
  request vypadal jako jediný target reference a policy jej povolila.
- **Nezávislá reprodukce:** sedm variant bylo klasifikováno
  `allow:true`, `conversation-history`, `referencedIds=[READ]`: JSON scalar
  `payload:urn:li:messagingThread:UNREAD`, composite JSON
  `payload:urn:li:msg_conversation:(urn:li:fsd_profile:MEMBER,UNREAD)`, nested
  `value`, pole `refs`, double-encoded JSON a jednoduchá i nested Rest.li hodnota.
  Samostatný lokální Chromium probe poslal tři reprezentativní URL serveru přes
  nový isolated API proxy (`serverHits=[1,1,1]`), měl
  `crossThreadRequestsBlocked=0` a `assertTargetSafe=true`. LinkedIn ani session
  nebyly použity.
- **Dopad:** persisted query, která zavede/akceptuje nový field název, může přes
  exact povolený history operation načíst jiný než ověřený read thread. Gate běh
  neoznačí jako unsafe a request může zároveň vytvořit zdánlivě validní history
  template. To přímo odporuje one-thread target invariantě.
- **Doporučení:** rekurzivně zkontrolovat každý string scalar v JSON, polích i
  Rest.li hodnotách pomocí typed `conversationIdFromUrn`; každý rozpoznaný
  conversation URN přidat do reference setu bez ohledu na key. Jakákoli foreign
  conversation identity musí request zablokovat. Profile/message URN lze podle
  entity type ignorovat. Přidat server-count `0` testy pro simple/composite,
  nested/array a double-encoded JSON i Rest.li cizí URN pod neznámým key.

### Uzavřené požadované reprodukce

- **R4-01 uzavřeno:** `messagingV2`, `graphqlV2` s messenger operation,
  `voyagerMessagingGraphQLV2`, encoded `%6dessagingV2`, case/custom messaging
  namespace a custom GraphQL mailbox tvar byly ve vlastním runtime probe všechny
  zablokované (`10` kombinovaných namespace/identity requestů, server hits `0`,
  blocked counter `10`). Malformed/deeper/Unicode canonicalizace zůstává fail-closed.
- **R4-02 částečně uzavřeno:** direct `id`, JSON/Rest.li `id` a `ids`,
  `compoundId`, nested identity key a double-encoded foreign raw ID se blokují;
  targeted policy matice měla `14/14` blocked a `6/6` legitimních allow případů.
  R5-01 popisuje zbývající value-based URN variantu.
- **Redirect a exact reads:** allowed list GET s 302 provedl právě jeden source GET,
  redirect target měl count `0`, gate vykázal blocked `1`, assertion selhala a
  response `Set-Cookie` nezměnil browser jar. Exact list i exact target-history GET
  naopak každý provedl právě jeden server request a browser dostal cached JSON;
  API response `Set-Cookie` po obou zůstal jen v zahazovaném request contextu.
- **R3 regrese:** `img`, iframe, object/subframe, prefetch, worker-fetch a pozdější
  direct fetch na thread URL mají server count `0`; cached target document má jeden
  preflight GET a jednu in-memory browser navigation. Selection/target document i
  API response cookies zůstaly oddělené od browser jaru. POST, WebSocket a service
  worker ochrany prošly v plném test suite.

### Testy a Git

- `npm.cmd run check`: **PASS** — 15 test files / 115 tests, typecheck i build.
- Cílený probe/navigation/URL/guard běh: **PASS** — 5 files / 56 tests.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- `.auth/`, main/partial exporty a diagnostics jsou ignorované; tracked soubory
  neobsahují nalezenou credential value ani runtime export/session artifact.
- `git diff --check`: **PASS** před zápisem tohoto dodatku. Review nepoužilo
  LinkedIn, credentials ani existující session; implementační kód nebyl změněn a
  nic nebylo commitováno.

---

## Finální security re-review HEAD `585094b`

### Verdikt

**Critical: 0 / High: 1 / Medium: 0.** Původní R5-01 je pro všech sedm
simple/composite/nested/array/double-encoded JSON a Rest.li reprodukcí uzavřený.
Nový parser ale nefailuje closed pro syntaktický conversation-like URN s
nepodporovaným budoucím namespace ani pro některé malformed URN. To je u soukromého
a měnícího se LinkedIn API stále target-identity mezera.

**NO-GO pro jeden skutečný `--probe-read-thread`.** Supported foreign conversation
URN se již zastaví, ale exact history GET s `messagingThreadV2:UNREAD` dosáhl v
lokální runtime reprodukci serveru a gate jej prohlásil za bezpečný. Network-only
export bez probe/thread-open režimu tímto nálezem dotčen není.

### R6-01 / R5-01 — HIGH — Unknown/malformed conversation-like URN se ignoruje místo fail-closed blokace

- **Soubor/řádky:** `src/linkedin/probe-request-policy.ts:45-69`,
  `src/linkedin/probe-request-policy.ts:128-151`,
  `src/domain/stable-id.ts:29-46`
- **Problém:** `collectConversationUrns()` nastaví `valid=false` pouze tehdy, když
  `isConversationUrn()` již rozpozná entity type jako jednu ze šesti současných
  konstant. Syntaktický `urn:li:messagingThreadV2:UNREAD`,
  `messagingConversationV2`, `conversation-v2` nebo prázdný
  `urn:li:messagingThread:` proto jen přeskočí. Vedle validního
  `conversationId=READ` zůstane jediný známý reference `READ` a exact history
  request je povolen.
- **Nezávislá reprodukce:** policy vrátila `allow:true`,
  `kind=conversation-history`, `referencedIds=[READ]` pro všechny čtyři výše
  uvedené varianty. Lokální Chromium route-chain poslal reprezentativní
  `messagingThreadV2:UNREAD` i prázdný current-type URN serveru (`hits=[1,1]`),
  `crossThreadRequestsBlocked=0` a `assertTargetSafe=true`. Naproti tomu unbalanced
  current composite, dvojitá dvojtečka a foreign current URN s trailing delimiterem
  skončily fail-closed.
- **Dopad:** jakmile LinkedIn zavede nový conversation entity type, může se foreign
  unread identity skrýt pod unknown key vedle návnadového target aliasu. Probe ji
  odešle jako povolený history GET, nezaznamená violation a může uložit validně
  vypadající template pro request mimo jediný ověřený read target.
- **Doporučení:** při každém nalezeném `urn:li:<entityType>:` nejprve oddělit a
  validovat celý token. Rozpoznaný conversation type musí dát validní route ID;
  malformed token nebo neznámý type obsahující `messag|conversation|thread` musí
  nastavit `result.valid=false`. Pouze explicitně známé non-conversation typy
  (person/profile/participant/message/mailbox) ignorovat. Přidat policy i skutečný
  server-count `0` test pro prázdný current URN a několik future namespace variant,
  vždy vedle `conversationId=READ`.

### Ověřené opravy a regrese

- **Původních sedm R5-01 případů:** simple a composite foreign conversation URN,
  nested scalar, array s profile+foreign conversation, double-encoded JSON,
  simple Rest.li a nested Rest.li měly v nezávislém Chromium běhu každý server hit
  `0`; blocked counter byl přesně `7`.
- **Target URN pozitivní kontrola:** `messagingThread`, composite
  `msg_conversation`, `fsd_messengerConversation`, `messengerConversation`,
  `messagingConversation` a `conversation` s ID `READ` měly každý právě jeden
  server hit a `assertTargetSafe()` prošel.
- **Hraniční parser matice:** mixed target+foreign, více URN v jednom scalaru,
  comma/semicolon/quoted delimitery, triple/nested encoding, unbalanced composite
  a dvojitá dvojtečka skončily fail-closed. Profile, participant, message/event a
  mailbox URN pod neidentity payloadem se nepřimíchaly do conversation IDs a validní
  target request zůstal povolen. R6-01 popisuje tři future types a empty-value tvar,
  které tuto matici nesplnily.
- **Namespace/redirect/cache/cookies:** předchozí R4 namespaces včetně encoded a
  case/custom variant zůstaly na server count `0`. Allowed-list 302 má source count
  `1`, redirect target `0` a fail-closed assertion. Exact list/history i cached
  target mají po jednom povoleném server GET; browser navigation nevytváří druhý
  document GET. Selection, target i isolated API `Set-Cookie` nezměnily browser jar.
- **Starší bezpečnostní invarianty:** full suite znovu potvrdila blokaci POST,
  WebSocket upgradu/frame a persistent service workeru, přesně jednu explicitně
  read target navigation, DOM mutation bait, atomic main/partial chování, parser
  provenance/redakci a absenci export-store volání v probe větvi.
- Fresh missing-state `npm.cmd run probe:read-thread -- --state-file <missing>
  --output <temp>` skončil `AUTH_REQUIRED`, exit `3`, bez main, `.partial`,
  diagnostics či jiného souboru. Nebyl použit existující storage state ani session.

### Testy a Git

- `npm.cmd run check`: **PASS** — 15 test files / 117 tests, typecheck i build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- Nezávislé local-Chromium/policy matice: původní R5 cases a supported target
  namespaces **PASS**; R6-01 future/malformed variants **FAIL** podle nálezu výše.
- `.auth/`, main/partial exporty a diagnostics jsou ignorované; tracked obsah nemá
  nalezenou credential value ani runtime export/session artifact.
- `git diff --check`: **PASS** před zápisem dodatku. Review nepoužilo LinkedIn,
  reálná data, credentials ani existující session; implementační kód nebyl změněn
  a nic nebylo commitováno.

---

## Finální security re-review HEAD `fa6ec2b`

### Verdikt

**Critical: 0 / High: 1 / Medium: 0.** R6-01 je pro tři future entity namespaces
a empty-value current URN opravený. Rozšířená požadovaná malformed/missing-ID
matice však odhalila navazující fail-open případ: conversation-shaped token, který
nemá canonical druhou dvojtečku, vůbec nevstoupí do URN klasifikace.

**NO-GO pro jeden skutečný `--probe-read-thread`.** Exact history request s
`urn:li:messagingThread/UNREAD` dosáhl lokálního serveru a gate stále hlásil safe.
Běžný network-only export bez probe/thread-open režimu tímto nálezem dotčen není.

### R7-01 / R6-01 — HIGH — Malformed conversation token bez canonical separatoru unikne URN klasifikaci

- **Soubor/řádky:** `src/linkedin/probe-request-policy.ts:55-99`,
  `src/linkedin/probe-request-policy.ts:175-198`,
  `src/linkedin/probe-request-policy.ts:217-238`
- **Problém:** `collectConversationUrns()` hledá pouze regex
  `urn:li:([\w-]+):`. Tokeny `urn:li:messagingThread`,
  `urn:li:messagingThread/UNREAD`, `urn:li:messagingThread=UNREAD` a obdobný tvar
  s `?`/`#` proto nenajde. `isSensitiveProbeSurface()` je sice podle slova
  `messagingThread` označí za sensitive, ale nenastaví `references.valid=false`;
  vedle `conversationId=READ` tak request splní exact history allow podmínku.
- **Nezávislá reprodukce:** policy pro šest malformed variant v JSON payloadu
  vrátila `allow:true`, `referencedIds=[READ]`. Lokální Chromium route-chain poslal
  reprezentativní missing-value, slash+foreign a equals+foreign request serveru
  (`malformedHits=[1,1,1]`), `crossThreadRequestsBlocked=0` a
  `assertTargetSafe=true`. Stejný běh potvrdil, že tři R6 future types, canonical
  empty current URN a dva supported foreign URNs mají server count `0`.
- **Dopad:** pokud soukromý endpoint nebo mezivrstva akceptuje/normalizuje
  alternativní separator či nový serializační tvar, může foreign unread identity
  projít vedle target návnady bez violation. I pokud jej současný backend odmítne,
  explicitně požadovaný invariant „ambiguous/malformed fail-closed“ není splněn.
- **Doporučení:** před extrakcí validních URN detekovat každý normalizovaný
  `urn:li:` prefix. Obsahuje-li následující token `messag|conversation|thread`, musí
  se celý kandidát buď rozparsovat jako podporovaný canonical conversation URN s
  platným ID, nebo nastavit `result.valid=false`; slash/equal/missing separator se
  nesmí tiše ignorovat. Explicitně známé profile/person/participant/message/event/
  mailbox/inbox entity dál ignorovat. Přidat policy a server-count `0` testy pro
  missing colon/ID i `/`, `=`, `?`, `#` JSON/Rest.li a repeated-encoded varianty.

### Ověřené opravy a regrese

- **R6-01 uzavřeno v původním rozsahu:** `messagingThreadV2`,
  `messagingConversationV2`, `conversation-v2` i canonical empty
  `messagingThread:` vedle target aliasu mají server count `0` a blocked counter.
  Case, hyphen, underscore, numeric prefix/suffix a mixed conversation/nonconversation
  entity type se klasifikují konzervativně; conversation/thread marker má prioritu.
- **Pozitivní/negativní typed URN:** šest podporovaných target namespaces
  (`messagingThread`, composite `msg_conversation`, `fsd_messengerConversation`,
  `messengerConversation`, `messagingConversation`, `conversation`) mělo každý
  právě jeden server hit a safe assertion. Supported foreign simple/composite URN
  měly hit `0`. Profile/person/participant/message/event/mailbox/inbox entity pod
  neidentity payloadem se do conversation setu nepřimíchaly a target request prošel.
- **Encoding a kombinace:** canonical empty ID, unbalanced composite, double colon,
  mixed target+foreign, více URN v jednom scalaru, quoted/delimited hodnoty a
  URL/JSON/Rest.li repeated encoding byly blokované nebo správně rozlišeny. R7-01
  je omezený na malformed conversation-like prefix, který vůbec nesplní start regex.
- **Namespace/transport:** R4 namespace default-deny, allowed GET redirect
  (`source=1`, `target=0`), cached document/API response, isolated cookie jar,
  thread img/iframe/object/prefetch/worker/fetch, POST, WebSocket a persistent-SW
  regrese prošly. Exactly-one target stále vyžaduje explicitní network
  `read===true`, shodný route ID a jednu cached browser navigation.
- Probe větev nadále nepoužívá export store ani DOM thread extraction. Fresh
  missing-state běh skončil `AUTH_REQUIRED`, exit `3`, bez main, `.partial`,
  diagnostics či jiného souboru; existující storage state/session nebyl čten.

### Testy a Git

- `npm.cmd run check`: **PASS** — 15 test files / 119 tests, typecheck i build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- Nezávislé local-Chromium/policy matice: požadované R6 a starší regrese **PASS**;
  malformed missing-separator R7-01 varianty **FAIL** podle nálezu výše.
- `.auth/`, main/partial exporty a diagnostics jsou ignorované; tracked obsah nemá
  nalezenou credential value ani runtime export/session artifact.
- `git diff --check`: **PASS** před zápisem dodatku. Review nepoužilo LinkedIn,
  reálná data, credentials ani existující session; implementační kód nebyl změněn
  a nic nebylo commitováno.

---

## Finální security re-review HEAD `2142680`

### Verdikt

**Critical: 0 / High: 0 / Medium: 0.** R7-01 je v požadovaném i rozšířeném
rozsahu uzavřený. Nová klasifikace nejprve rozpozná conversation-family entity a
teprve potom vyžaduje canonical druhou dvojtečku; malformed nebo budoucí typ proto
již nemůže zmizet z target evidence.

**GO pro právě jeden skutečný `--probe-read-thread` po výslovném opt-in uživatele.**
Probe musí zůstat omezený na jednu network-confirmed `read===true` konverzaci a
nesmí se kombinovat s exportem ani DOM thread fallbackem. Běžný network-only export
bez `--allow-thread-open` zůstává samostatný bezpečný režim.

### R7-01 — uzavřeno

- **Soubor/řádky:** `src/linkedin/probe-request-policy.ts:45-93`,
  `src/linkedin/probe-request-policy.ts:175-238`
- Nezávislá policy matice zablokovala missing-second-colon varianty na konci i s
  `/UNREAD`, `=UNREAD`, `?UNREAD` a `#UNREAD`, jejich case/future podoby,
  single/double encoded hodnoty, nested JSON i jednoduchou/nested Rest.li
  reprezentaci. Smíšený target+foreign a více URN v jednom scalaru zůstaly
  fail-closed; `referencedIds` u canonical foreign variant obsahovalo `UNREAD`.
- Samostatný syntetický Chromium/server probe ověřil všech 12 požadovaných
  malformed/encoded variant s **server hit `0`**. Šest supported foreign typů mělo
  také hit `0`; `crossThreadRequestsBlocked` byl přesně `18` a následná safe
  assertion správně selhala. Stejný běh poslal všech šest supported target typů
  (`messagingThread`, composite `msg_conversation`,
  `fsd_messengerConversation`, `messengerConversation`,
  `messagingConversation`, `conversation`) právě jednou a benign nonconversation
  payload právě jednou.
- Doplňkový fuzz měl 261 delimiter/quote/wrapper, entity case/suffix, NFKC Unicode,
  control/format/U+FFFD, glued prefix/suffix, unbalanced/composite, mixed-URN,
  malformed-percent a 1–10× encoded kombinací; žádná praktická foreign nebo
  ambiguous conversation varianta nebyla povolena. Známé profile/person/
  participant/message/event/mailbox/inbox/member entity se správně nepřidaly do
  conversation references. Čistě confusable ne-ASCII entity, kterou LinkedIn
  backend nerozpozná jako ASCII URN namespace, nepředstavuje praktický bypass.

### Regresní bezpečnostní invarianty

- Exact Dash GraphQL path a operation allowlist zůstává default-deny pro REST,
  legacy/current lookalike, case/trailing/custom namespace i mutation názvy.
  Allowed GET redirect má podle integračních testů pouze source request; redirect
  target se neodešle.
- Selection i target document jsou načtené jednorázovým disposable request
  contextem s `maxRedirects: 0` a browser navigace dostane jen in-memory cached
  odpověď. Response `Set-Cookie`, `Location` a opaque headers se nepřenášejí do
  browser jaru. Target lze armovat pouze ze shodných stabilních ID/URN/route aliasů
  a s explicitním network `read===true` evidence; browser target navigation je
  povolena přesně jednou.
- Thread URL jako image/iframe/subframe/prefetch/worker/direct fetch, cross-thread
  GraphQL, popup a history/location redirect zůstávají blokované před sítí.
  Persistent service worker se do ephemeral export/probe contextu nepřenáší;
  globální guard blokuje POST i WebSocket před serverem.
- Probe větev nevolá export store, nečte thread DOM a nevytváří main ani `.partial`.
  Fresh `npm.cmd run probe:read-thread -- --state-file <missing> --output <unique>`
  skončil `AUTH_REQUIRED`, exit `3`, bez vytvoření state, output, partial,
  diagnostics nebo parent adresáře. Nebyl použit žádný existující storage state.

### Testy, závislosti a Git

- `npm.cmd run check`: **PASS** — typecheck, **15 test files / 121 tests**, build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- `.auth/`, main/partial exporty a diagnostics jsou podle `git check-ignore`
  ignorované. Tracked secret scan nenašel credential value, private key ani runtime
  session/export artifact; výskyty názvů `JSESSIONID`/`li_at` jsou pouze ochranný
  aplikační kód a zadání/plán.
- `git diff --check`: **PASS** před zápisem tohoto dodatku. Review nepoužilo
  LinkedIn, reálná data, credentials ani session; implementace nebyla změněna a
  nic nebylo commitováno.

### Residual risk (Low)

LinkedIn používá soukromé a proměnlivé endpointy. Pokud se skutečný read-only
history request od známého exact namespace/operation/identity tvaru odchýlí, gate
jej má zablokovat a probe skončí bez template. To může vyžadovat další synteticky
ověřenou allowlist úpravu, ale není to důvod rozšiřovat nynější oprávnění ani
opakovat thread navigation.

---

## Redigované runtime zjištění po schváleném opt-in probe (2026-09-06)

První uživatelem výslovně schválený authenticated probe skončil bezpečně s
`READ_POLICY_BLOCK` ještě před targetem. Redigovaný manifest zaznamenal jednu
selection navigation a jeden selection preflight, nula target navigation/preflight,
pět před sítí zablokovaných messaging subrequestů, nula navigation/popup pokusů a
24 globálním read-only guardem zablokovaných POSTů. Existující partial export se
nezměnil; žádné vlákno nebylo otevřeno.

Příčinou byla příliš přísná agregace: každý bezpečně abortovaný selection
subrequest nastavoval stejný fatální příznak jako navigační únik. Navazující oprava
odděluje počítané `selectionSubrequestsBlocked` od `hardSafetyViolations`. Pouze
ne-navigační denied messaging/thread subrequest v selection fázi je tolerovaný po
prokazatelném abortu; iframe/subframe/main navigation, popup, History API,
preflight/redirect selhání a každá odchylka po armování targetu zůstávají fatální.
Kandidát se nadále smí vytvořit jen z browseru předané exact conversation-list GET
odpovědi s explicitním network `read === true`; odmítnutá nebo redirect odpověď se
do page/network capture vůbec nepředá.

---

## Security re-review selection tolerance HEAD `a6b1e6c`

### Verdikt

**Critical: 0 / High: 0 / Medium: 3.** Samotné zúžení tolerance na selection
non-navigation messaging/thread subrequesty funguje: requesty jsou abortované před
sítí a nejsou omylem fatální. Dvě TOCTOU mezery kolem asynchronního target preflightu
ale dovolí pokračovat k target navigaci po zakázané aktivitě; jedna z nich umí
zakázaný History API pokus zcela vymazat z finálního výsledku. Navíc agregát
`navigationAttemptsBlocked` neodpovídá skutečným navigation requestům.

**NO-GO pro opakování skutečného `--probe-read-thread`.** První schválený běh měl
nula thread navigací a skončil fail-safe. Před druhým během je potřeba uzavřít
AR-01 až AR-03; běžný network-only export bez thread-open režimu nálezy nemění.

### AR-01 — MEDIUM — History/location violation během preflightu se po target navigation ztratí

- **Soubor/řádky:** `src/linkedin/probe-navigation.ts:51-55`,
  `src/linkedin/probe-navigation.ts:147-168`,
  `src/linkedin/probe-navigation.ts:248-285`;
  orchestrace `src/linkedin/probe.ts:114-128`
- **Problém:** zakázané `pushState`/`replaceState` nastaví pouze flag uvnitř právě
  načteného documentu. `assertSelectionSafe()` se volá před `armTarget()`, ale
  `armTarget()` po svém asynchronním preflightu page-local flag ani přesnou selection
  location znovu nekontroluje. Cached target navigation vytvoří nový document a
  init script flag resetuje. Stejná časová mezera existuje pro fragment/same-document
  location změny, které nevytvoří routovaný síťový navigation request.
- **Nezávislá reprodukce:** syntetická selection stránka naplánovala
  `history.pushState(..., '/messaging/thread/UNREAD/')` za 100 ms, target preflight
  byl lokálním serverem zpožděn o 350 ms. První selection assertion prošla; zakázaný
  History pokus proběhl během preflightu. `armTarget()` přesto resolve, cached target
  navigation proběhla a `assertTargetSafe()` chybně prošla. Snapshot:
  `hardSafetyViolations=0`, `targetNavigationsAllowed=1`; unread server hit byl `0`.
- **Dopad:** probe může uložit success/template i poté, co selection document
  prokazatelně zkusil zakázanou client-side cross-thread navigaci. Samotný pokus je
  JS wrapperem zastaven před sítí, proto nález není High, ale integrita hard-safety
  rozhodnutí je porušena.
- **Doporučení:** před návratem z `armTarget()` znovu atomicky ověřit
  `hardViolated`, exact selection location a `pageHistoryWasBlocked(page)`. Totéž
  ověřit při spotřebování cached target documentu těsně před `route.fulfill`, nebo
  History violation okamžitě propagovat do Node-side hard state. Přidat delayed
  preflight test pro History API i same-document location/hash.

### AR-02 — MEDIUM — Již zaznamenaná hard violation nezastaví cached target navigaci

- **Soubor/řádky:** `src/linkedin/probe-navigation.ts:178-231`,
  `src/linkedin/probe-navigation.ts:261-285`;
  `src/linkedin/probe.ts:118-128`
- **Problém:** fáze se správně přepne na `armed` před target preflightem, takže
  pozdější foreign request je server `0` a volá `markHardViolation()`. Po dokončení
  preflightu ale `armTarget()` stav znovu netestuje. Exact cached target exception
  v route handleru je navíc před ostatními policy větvemi a nemá podmínku
  `!hardViolated`; target je tedy stále otevřen a teprve závěrečný assertion selže.
- **Nezávislá reprodukce:** během stejného 350ms preflightu selection dokument
  spustil jednou foreign `messagingV2` fetch a v druhém běhu `location.href` na
  unread thread. Oba foreign/unread endpointy měly server hit `0` a snapshot již po
  `armTarget()` obsahoval `hardSafetyViolations=1`, přesto `armTarget()` resolve a
  target navigation měla `targetNavigationsAllowed=1`. Až `assertTargetSafe()`
  odmítl běh.
- **Dopad:** background request typický pro živou messaging stránku může během
  target preflightu vytvořit hard failure, ale probe přesto provede uživatelsky
  významnou thread navigation. Cíl je stále explicitně network-confirmed read, takže
  nejde o foreign/unread server access, ale „hard fatal before target“ invariant a
  předvídatelnost opakování probe nejsou splněny.
- **Doporučení:** po preflight await odmítnout `armTarget()`, pokud je
  `hardViolated`; cached target document zahodit. Target fulfill větev musí při hard
  stavu request abortovat, ne dokument vydat. Test musí vyžadovat
  `armTarget rejects`, `targetNavigationsAllowed=0` a žádný druhý wire document GET
  pro delayed foreign fetch, main/subframe location i popup.

### AR-03 — MEDIUM — `navigationAttemptsBlocked` má false negative i false positive

- **Soubor/řádky:** `src/linkedin/probe-navigation.ts:178-184`,
  `src/linkedin/probe-navigation.ts:219-221`,
  `src/linkedin/probe-navigation.ts:280-284`
- **Problém:** `block()` zvyšuje buď `navigationAttemptsBlocked`, nebo
  `crossThreadRequestsBlocked` podle předaného `kind`. Každá thread URL ale vždy
  používá `kind='cross-thread'`, i když `request.isNavigationRequest() === true`.
  Main/subframe/iframe/object navigation se proto do navigation counteru nezapíše.
  Opačně neúspěšný isolated target preflight ručně přičte
  `navigationAttemptsBlocked`, přestože žádná browser navigation nezačala.
- **Nezávislá reprodukce:** delayed `location.href` na unread thread i existující
  iframe/object test mají server `0`, `hardSafetyViolations=1` a
  `crossThreadRequestsBlocked=1`, ale `navigationAttemptsBlocked=0`. Target
  preflight 302/bad response naopak skončí s `targetNavigationsAllowed=0` a
  `navigationAttemptsBlocked=1`.
- **Dopad:** agregát `navigationAttemptsBlocked=0` nelze používat jako důkaz, že se
  žádná navigation nepokusila nastat; právě tak byl interpretován redigovaný runtime
  manifest. Safety blokace samotná funguje, ale auditní evidence a rozhodování o
  dalším probe jsou zavádějící.
- **Doporučení:** počítat nezávislé dimenze: každý routovaný
  `request.isNavigationRequest()` zvýší navigation counter, messaging/thread nav
  může současně zvýšit cross-thread counter. Pro preflight failure zavést samostatný
  `probePreflightFailures`; nezapočítávat jej jako browser navigation. Přidat přesné
  counter testy pro main, iframe, object, popup/History a selection/target preflight.

### Co prošlo

- Pět souběžných denied selection fetchů dalo přesně
  `crossThreadRequestsBlocked=5`, `selectionSubrequestsBlocked=5`,
  `hardSafetyViolations=0`, všechny server hits `0`; selection assertion, target
  arm i jediná cached target navigation následně prošly.
- Selection image, prefetch a worker-fetch jsou nonfatal a server `0`; iframe,
  object/subframe, popup a History/location pokus před selection assertion jsou
  fatální. Main selection redirect je zastaven před unread serverem.
- Allowed conversation-list GET s 302, HTTP 500 nebo HTML content type není
  fulfillnut do browseru, zvyšuje hard violation a selection assertion selže.
  Redirect-list integrační test navíc potvrdil nulový browser `response`, takže z
  něj capture nevytvoří kandidáta. Selection i target document preflight failure
  zůstává fail-closed.
- Po přechodu do `armed` i v target phase mají foreign/unknown messaging HTTP
  requesty server `0` a nastaví hard violation. Exact target/list GET, redirect
  `maxRedirects:0`, disposable cookie jar, stripped response headers a jedno použití
  cached targetu zůstávají beze změny.
- Candidate selection nadále vyžaduje exact Dash conversation-list GET,
  `sourceMetadata.read === true`, `readEvidence === 'network-explicit'`, shodu všech
  ID/URN/route aliasů a odmítá konflikt s explicitním unread záznamem.
- Plný suite znovu ověřil POST, WebSocket, persistent-SW isolation, starší R4–R7
  namespace/URN invariants, DOM mutation canary, parser/provenance, atomic
  main/partial chování a absenci export-store volání v probe větvi.

### Testy, data a Git

- `npm.cmd run check`: **PASS** — typecheck, **15 test files / 126 tests**, build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- Fresh missing-state `npm.cmd run probe:read-thread -- --state-file <missing>
  --output <unique>`: `AUTH_REQUIRED`, exit `3`, bez vytvoření parent adresáře,
  state, main, `.partial` nebo diagnostics.
- `.auth/`, exporty a diagnostics jsou ignorované; tracked secret scan nenašel
  credential value, private key ani runtime session/export artifact.
- `git diff --check`: **PASS** před zápisem tohoto dodatku. Review pracovalo pouze
  se syntetickými lokálními HTTP/Chromium fixtures a redigovanými agregáty uvedenými
  v zadání; LinkedIn, storageState, session ani reálná data nebyly použity.

### Residual risk (Low)

`block()` připíše nonfatal selection counter před dokončením `route.abort()` a
chybu abortu potlačí. Playwright běžně request drží před sítí a testy potvrzují
server `0`; pro striktně dokazatelnou toleranci by se ale nonfatal stav měl potvrdit
až po úspěšném abortu a abort exception změnit na hard failure.

---

## Re-review preflight race oprav HEAD `04fc2c0`

### Verdikt

**Critical: 0 / High: 0 / Medium: 2.** AR-03 je uzavřený a běžné delayed AR-01/02
scénáře nyní skončí před targetem. History ochranu však lze obejít přes nezměněné
metody na `History.prototype` a jediné event-loop yield v target route nevytváří
atomickou hranici vůči browser timer/request událostem. V obou případech se cached
read target může otevřít s `targetNavigationsAllowed=1`.

**NO-GO pro opakování jediného skutečného `--probe-read-thread`.** První reálný
probe měl nula thread navigací; před opakováním je potřeba odstranit PR-01 a PR-02.
Network-only export bez thread-open režimu těmito nálezy dotčen není.

### PR-01 / AR-01 — MEDIUM — Page může obejít History wrapper přes `History.prototype`

- **Soubor/řádky:** `src/linkedin/probe-navigation.ts:158-195`,
  `src/linkedin/probe-navigation.ts:311-376`
- **Problém:** init script vytváří non-writable vlastní `history.pushState` a
  `history.replaceState`, ale původní metody na `History.prototype` zůstávají
  dostupné. Skript může zavolat
  `History.prototype.pushState.call(history, ...)` a následně stejně obnovit původní
  URL. Nevznikne `popstate` ani `hashchange`, binding se nezavolá a end-of-preflight
  kontrola vidí znovu přesný selection URL a `historyBlocked=false`.
- **Nezávislá reprodukce:** selection fixture během 350ms target preflightu provedla
  přes prototype `pushState` z `/sel-proto` na `/messaging/thread/UNREAD/` a přes
  prototype `replaceState` zpět na `/sel-proto`. `armTarget()` resolve,
  `hardSafetyViolations=0`; cached target byla fulfillnuta,
  `targetNavigationsAllowed=1` a `assertTargetSafe()` prošel. Unread server hit byl
  `0`, protože History API samo síťový request neposílá.
- **Dopad:** zakázaná cross-thread client-side navigace může být z auditní evidence
  zcela odstraněna a probe může uložit success/template. Nedochází k foreign server
  read ani LinkedIn mutaci, proto Medium, nikoli High.
- **Doporučení:** uzamknout guarded metody přímo na `History.prototype` v každém
  execution world/frame (případně bezpečně zablokovat veškeré History mutace mimo
  no-op exact URL). Přidat delayed i post-arm testy, které volají prototype
  `pushState`/`replaceState` a zkoušejí round-trip zpět na selection URL; musí dát
  `arm rejects`, `targetNav=0` a terminal cache.

### PR-02 / AR-02 — MEDIUM — Jedno target-route yield nezavírá browser/Node race

- **Soubor/řádky:** `src/linkedin/probe-navigation.ts:257-286`,
  `src/linkedin/probe-navigation.ts:361-376`
- **Problém:** target route po první safe kontrole jednou yieldne přes
  `setTimeout(0)`, podruhé synchronně zkontroluje stav, nastaví `phase='target-used'`
  a zavolá `route.fulfill()`. Timer nebo request ze starého selection documentu může
  být doručen těsně po druhé kontrole, ale před commitnutím cached dokumentu.
  Foreign request se správně abortuje a nastaví hard state, target fulfill už však
  běží a dokončí se.
- **Nezávislá reprodukce:** po úspěšném `armTarget()` selection stránka naplánovala
  ordinary guarded History pokus nebo foreign `messagingV2` fetch za 0–5 ms a
  reviewer ihned zavolal target `goto`. Ve 40 History bězích prošla target navigace
  s následným `hard=1` v 1/10 běhů pro 1 ms a 8/10 pro 5 ms. Ve 32 foreign-fetch
  bězích nastal `targetNav=1, hard=1, crossBlocked=1` v 4/8 běhů pro 1 ms, 7/8 pro
  2 ms a 8/8 pro 5 ms. Foreign server hit byl ve všech bězích `0`; závěrečný
  assertion selhal, ale read target již byl otevřen.
- **Dopad:** hard violation po armování není vždy terminal před target documentem.
  Cíl je stále ověřený explicitně read thread a cizí request síť nezasáhne, takže
  nejde o neoprávněný unread read; porušuje to však výslovný `targetNav=0` invariant
  a bezpečnou opakovatelnost probe.
- **Doporučení:** nepoužívat časový yield jako synchronizační bariéru. Před target
  navigací ukončit execution lifecycle selection dokumentu (nejrobustněji zavřít
  selection page a předem guardovaně vytvořit inertní target page), teprve potom
  jednou fulfillnout cached target. Alternativa musí mít deterministický handshake,
  po kterém starý document již nemůže spustit timer/fetch/binding; testovat desítkami
  0–5ms race iterací a vyžadovat vždy `targetNav=0` po pre-target violation.

### Uzavřené části AR-01/02/03

- Běžný delayed `pushState`, `replaceState`, hash/popstate s URL změnou, foreign
  fetch, `location`, popup a iframe/object/subframe během pomalého preflightu nyní
  nastaví hard stav, `armTarget()` odmítne, target cache se nezveřejní a pozdější
  target pokus má `targetNav=0`; unread/foreign endpoint má server `0`.
- Binding na stránce má `writable=false`, `configurable=false`; assignment ani
  `defineProperty`/`delete` jej nenahradí. Přímé zavolání bindingu způsobí pouze
  terminal DoS. PR-01 obchází volání guarded metody, nikoli binding property.
- Po hard eventu se fáze mění na `failed` a oba cached dokumenty se mažou. Více
  událostí zvyšuje hard counter; následné blokování target navigation je započtené
  jako skutečná browser navigation a cache nelze později použít. PR-02 je úzké okno,
  kdy fulfill již začal před doručením hard události.
- **AR-03 uzavřeno:** main/subframe/thread navigation zvyšuje
  `navigationAttemptsBlocked` až po úspěšném `route.abort`; messaging thread může
  současně zvýšit cross-thread counter. Selection/target preflight selhání mají
  vlastní counters a target preflight 302/invalid response ponechá browser
  navigation counter na nule.
- Selection denied non-navigation image/prefetch/worker/fetch mají server `0`, po
  potvrzeném abortu jsou nonfatal a zachovávají přesné
  `crossThreadRequestsBlocked === selectionSubrequestsBlocked`. Pět souběžných
  requestů dalo `5/5`, hard `0` a bezpečný flow mohl pokračovat.
- Safe flow má jeden selection preflight, jeden target preflight, právě jednu cached
  target navigation a jeden exact target history GET. Redirect/bad status/content
  type se nefulfillne; `Set-Cookie`, `Location` a opaque headers se nepřenášejí do
  browser jaru.
- Conversation candidate nadále pochází pouze z browseru předané exact Dash list
  GET odpovědi a vyžaduje explicitní network `read=true`, shodné ID/URN/route aliasy
  a nulový conflicting unread evidence. Redirect list response se do capture
  nedostane.
- POST, WebSocket, persistent-SW, one-target/no-export, namespace/default-deny a
  všechny starší R4–R7 URN/encoding invarianty prošly plným suite. Okamžitý
  production teardown `gate.dispose()` → `context.close()` byl v 60 timer-race
  iteracích bez unread server hitu; binding po dobu živého contextu může vyvolat jen
  fail-closed stav.

### Testy, data a Git

- `npm.cmd run check`: **PASS** — typecheck, **15 test files / 133 tests**, build.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS**, 0 zranitelností.
- Fresh missing-state `npm.cmd run probe:read-thread -- --state-file <missing>
  --output <unique>`: `AUTH_REQUIRED`, exit `3`, bez parent adresáře, state, main,
  `.partial` nebo diagnostics.
- `.auth/`, exporty a diagnostics jsou ignorované; tracked secret scan nenašel
  credential value, private key ani runtime session/export artifact.
- `git diff --check`: **PASS** před zápisem tohoto dodatku. Review používalo jen
  syntetické lokální HTTP/Chromium fixtures; LinkedIn, storageState, session ani
  reálná data nebyly použity. Implementace nebyla změněna a nic nebylo commitováno.

### Residual risk (Low)

Same-URL History state entry a následný same-URL `popstate` současný listener
neoznačí, protože `href` zůstává původní. Bez URL změny nebo foreign network requestu
to nemá praktický read/state-change dopad; konzervativní varianta může přesto hlásit
každý `popstate`. Po `dispose()` binding/init script v živém contextu zůstává, ale
produkční cesta context ihned zavírá; opětovné použití stejného contextu není
podporované.

---

## Závěrečný úzký re-review HEAD `a241ed3` (2026-09-06)

### Verdikt

**Critical: 0 · High: 1 · Medium: 0 · NO-GO** pro druhý skutečný
`--probe-read-thread`. Fresh target Page odstranila dřívější post-arm lifecycle
race, ale selection teardown stále nedává deterministickou síťovou bariéru.

### ZR-01 — High — request selection dokumentu může během CDP teardownu zasáhnout síť

- **Soubor/řádky:** `src/linkedin/probe-navigation.ts:126-140,402-406`
  (`sealAndCloseSelectionPage`: CDP session → `Network.enable` →
  `Network.setBlockedURLs('*')` → `Runtime.terminateExecution` → close).
- **Reprodukce:** plný `npm.cmd run check` selhal v implementačním testu
  `keeps 30 zero-to-ten-millisecond selection races disjoint from the fresh target
  page`, iterace `10`, delay `10 ms`, foreign fetch na
  `/voyager/api/messagingV2/conversations/UNREAD/events`. Lokální server obdržel
  **1 GET**, ačkoli test vyžaduje `0`. Snapshot po úniku byl
  `selectionPreflightGets=1`, `targetPreflightGets=1`, `targetNavigationsAllowed=0`,
  `crossThreadRequestsBlocked=0`, `navigationAttemptsBlocked=0`,
  `hardSafetyViolations=0`: request tedy unikl i mimo audit/countery guardu.
  Dvě bezprostřední samostatné reprodukce stejného 30× testu následně prošly, což
  potvrzuje nedeterministický race, nikoli jeho uzavření.
- **Dopad:** pod reálným timingem může již naplánovaný request staré selection Page
  dojít na cizí (potenciálně unread) conversation-history endpoint ještě před
  účinným CDP blokem/ukončením JavaScriptu. To porušuje základní server-hit-0
  bezpečnostní invariant, aniž by probe přešel do hard-failure stavu.
- **Doporučení:** vytvořit blokovací/termination fence ještě před okamžikem, kdy se
  selection JavaScript může rozběhnout mezi asynchronními CDP kroky (např. CDP
  session připravit předem a teardown zahájit synchronně účinnou bariérou), a
  zároveň deterministicky uzavřít či vypustit všechny již povolené requesty před
  vytvořením target Page. Opravu přijmout až po opakovaném 30× 0–10ms testu, kde
  každý foreign endpoint zůstane server `0` a každý pokus je blokovaný nebo hard.

### Ostatní ověřené invarianty

- Zbytek plného suite prošel: fresh target Page, `History.prototype` call/apply,
  interní page identity versus popup, route/listener lifecycle, safe flow s právě
  jednou cached target navigation a jedním exact history GET, cookie isolation,
  POST/WebSocket/SW a no-export.
- Fresh missing-state probe: `AUTH_REQUIRED`, exit `3`, nevznikl parent adresář ani
  main/`.partial`/diagnostics. Audit: **0 vulnerabilities**. Tracked secret scan
  našel pouze názvy klíčů/testovací canary a dokumentaci, ne credential hodnotu;
  `git diff --check` byl čistý před tímto review dodatkem.
- Review nepoužilo LinkedIn, storageState/session ani reálná data; pouze syntetické
  lokální HTTP/Chromium. Implementace nebyla změněna a nic nebylo commitováno.

---

## Review commitů `4d1fb85..ae0ae78` (2026-09-06)

### CRH-01 — High — běžný export obchází opt-in a může otevřít až tři thready

- **Odkazy:** `src/linkedin/exporter.ts:21-34`, `src/cli.ts:17-22`,
  `README.md:46-62`.
- `exportMessages()` bez kontroly `probeReadThread` vždy nejprve volá
  `discoverHistoryGet()`. Ten při libovolném selhání opakuje celý probe třikrát.
  Selhání může nastat až po úspěšné thread navigation (např. chybějící template nebo
  následný safety/parser error), takže jediný obyčejný `npm.cmd run export` může
  provést až tři thread navigations. CLI varování se přitom vypisuje jen pro
  explicitní `--probe-read-thread` a README stále výslovně slibuje, že běžný export
  vlákna nikdy neotevírá a probe není jeho součástí.
- **Dopad:** operace vyžadující vědomý one-thread opt-in se stala implicitní a retry
  ruší globální důkaz „právě jeden thread“. Ephemeral Playwright context sice
  nepoužívá ani nemění běžný Chrome profil, ale rozsah autorizované interakce s
  LinkedInem je překročen.
- **Doporučení:** běžný export nesmí probe spouštět bez samostatného explicitního
  opt-in flagu. Po první target navigation již nikdy neopakovat celý probe; retry
  povolit pouze pro fáze prokazatelně před thread navigation nebo zachovat observed
  template bezpečným explicitním workflow.

### CRH-02 — High — GraphQL historie je označena za úplnou bez serverového end/total důkazu

- **Odkazy:** `src/linkedin/history-reader.ts:82-110,162-164`,
  `src/linkedin/exporter.ts:108-125`.
- `isUnpaginatedFullCollection()` kontroluje pouze název persisted operation a
  nepřítomnost několika pagination klíčů v request URL. Když parser nenajde explicitní
  next URL, `markCompleteUnpaginatedCollection()` si sám vytvoří `total=count`,
  `end=true` a `historyComplete=true`, ačkoli odpověď serveru žádné `total/end`
  tvrzení neposkytla. Syntetická odpověď s jedinou zprávou, bez paging metadata a URL
  `messengerMessages.<hash>?variables=(conversationId:CONV)` skončila s
  `historyComplete=true`, evidence `start=0,count=1,total=1,end=true`, bez warningu a
  bez parser miss. Za splněného list coverage pak exporter může zapsat
  `partial=false`, i kdyby server vrátil pouze implicitní/defaultní okno historie.
- **Dopad:** neúplný výpis lze publikovat jako úplný hlavní JSON a přepsat tak poslední
  důvěryhodný complete export; chybějící starší zprávy nejsou signalizovány.
- **Doporučení:** úplnost uznat pouze z explicitního response evidence (server
  `total/end/hasNextPage=false` plus souvislé pokrytí od začátku), případně z
  ověřeného kontraktu konkrétního response adaptéru. Samotná absence pagination
  parametru/next linku musí zůstat `historyComplete=false`.

### CRH-03 — Medium — substituce mění všechny textové výskyty ID, nejen identity field

- **Odkaz:** `src/linkedin/history-reader.ts:24-69`.
- `instantiateObservedHistoryUrl()` provádí `split(oldForm).join(newForm)` nad celou
  URL pro raw i opakovaně encoded formy. Následná policy ověří jen to, že výsledná URL
  obsahuje právě jednu target conversation reference; nekontroluje zachování ostatních
  polí. Reprodukce s variables
  `{conversationId:"ABCDEF123==",tracking:"ABCDEF123=="}` při rebindu na
  `ZYX987654==` změnila **conversationId i tracking**, přesto prošla policy. Krátké
  povolené ID může stejným způsobem změnit persisted `queryId`, číselné parametry nebo
  znaky percent-encodingu.
- **Dopad:** observed request se nereprodukuje strukturálně; může být odmítnut,
  stránkovat jinak nebo vrátit jiný datový výsek. Běžné selhání zůstane partial, ale
  korektnost/idempotence výsledků závisí na náhodné nekolidující podobě ID.
- **Doporučení:** parsovat přesnou identity pozici v canonical query/JSON/Rest.li AST
  a nahradit pouze její hodnotu při zachování encoding depth; poté porovnat všechny
  ostatní query komponenty byte/strukturálně s observed template.

**Souhrn:** Critical `0`, High `2`, Medium `1`. Nové requesty jsou v implementaci
prováděny přes fresh Playwright Chromium/API context, metodou GET, s
`maxRedirects: 0`; změny samy o sobě nesahají na běžný Chrome profil. Review
nepoužilo LinkedIn, session ani reálná data a nezměnilo implementaci.

---

## Finální review a re-review HEAD `b611a61` (2026-09-07)

### Verdikt

**GO — Critical 0 · High 0 · Medium 0** v kontrolovaném rozsahu.

První finální průchod našel dva High a jeden Medium nález. Commit `b611a61` je
uzavřel a stejný nezávislý reviewer provedl úzký re-review:

- lokální export už pouze řadí kandidáty; otevřený thread vždy pochází z aktuální
  network capture, má aktuální explicitní `read=true` a projde kontrolou konfliktu
  s `read=false`;
- opětovné použití prokázané historie vyžaduje společný stabilní message ID/URN;
  id-less fingerprint ani pouhá shoda conversation ID nestačí a no-overlap test
  zachová výsledek neúplný;
- diagnostika proměnných a response kontraktů ukládá pro number/boolean jen typ,
  nikdy konkrétní hodnotu nebo timestamp.

Reviewer: typecheck **PASS**, cílené testy **19/19 PASS**, žádný další blokující
nález. Root po opravách: `npm.cmd run check` **PASS** — 16 souborů / **150 testů**,
typecheck a build; `npm.cmd audit --audit-level=high` **PASS**, 0 zranitelností.
Review nepoužilo browser, LinkedIn, session, diagnostiku ani runtime exporty a nic
neupravilo.
