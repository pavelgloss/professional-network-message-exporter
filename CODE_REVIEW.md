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
