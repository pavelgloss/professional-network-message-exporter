# Nezávislé code review

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
