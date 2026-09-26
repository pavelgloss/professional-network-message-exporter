# As-built architektura

Stav: **aktuální**

Ověřeno: **2026-09-25**

Aktuální implementační baseline: **`bcfa8b5`**. Implementace popsaná níže zahrnuje
dokončené conversation-level `isStarred`.

Tento dokument popisuje skutečně implementovaný systém, nikoli původní plán. Původní
návrh je zachován v `docs/history/IMPLEMENTATION_PLAN_ORIGINAL.md`.

## 1. Cíl a hranice systému

Projekt je lokální Node.js 22+/TypeScript CLI nad Playwrightem. Z vlastní přihlášené
LinkedIn session čte nejnovější konverzace a dostupnou historii zpráv, normalizuje je
a atomicky je ukládá do validovaného JSON.

Nástroj je záměrně read-only:

- neposílá zprávy, reakce ani přílohy;
- nemaže, nearchivuje a nemění konverzace;
- nemění profil ani nastavení účtu;
- výchozí export neotevírá žádné konkrétní vlákno;
- při nejasnosti o bezpečnosti nebo úplnosti selže uzavřeně (`fail closed`).

Otevření i již přečteného vlákna může teoreticky změnit serverový read/unread stav.
Proto je povoleno jen explicitním opt-in režimem a pouze pro jeden thread s aktuálním
network důkazem `read=true`. Absolutní garanci chování LinkedIn serveru dát nelze.

## 2. Provozní režimy

### Login

```powershell
npm.cmd run login
```

`src/auth/login.ts` otevře nový headed Chromium browser. Uživatel ručně dokončí login,
MFA nebo CAPTCHA. Program heslo nečte. Po potvrzení autentizace uloží pouze Playwright
storage state do `.auth/linkedin-storage-state.json` atomickým zápisem s omezenými
právy.

Nejde o persistentní Chrome profil. Běžný uživatelův Chrome, jeho procesy, profil a
otevřené taby se nepoužívají ani nezavírají.

### Výchozí export bez otevření threadu

```powershell
npm.cmd run export -- --limit 100
```

Export vytvoří fresh ephemeral context ze storage state, načte Messaging stránku,
pasivně zachytí povolené odpovědi, scrolluje seznam a čte DOM. Neotevře konkrétní
konverzaci. Pokud nelze úplnost seznamu nebo historií dokázat, zapíše pouze
`messages.json.partial` a skončí exit kódem 5.

### Export s jedním history probe

```powershell
npm.cmd run export -- --limit 100 --with-history-probe
```

Před hlavním exportem proběhne oddělený one-thread probe. Ten smí otevřít nejvýše
jedno vlákno, které má v aktuální network odpovědi explicitní `read=true` a současně
nemá konfliktní `read=false`. Zachytí validovaný GET kontrakt historie. Hlavní export
pak běží v novém contextu a tento kontrakt používá pro přímé read-only načítání
historií všech vybraných konverzací.

Lokální starší export může pouze ovlivnit pořadí vhodných kandidátů; nikdy nenahrazuje
aktuální network důkaz, že je cílové vlákno přečtené.

### Samostatný diagnostický probe

```powershell
npm.cmd run probe:read-thread
```

Používá stejný bezpečnostní one-thread mechanismus, ale neprovádí hlavní export a
nezapisuje `messages.json` ani `.partial`. Ukládá jen redigované strukturální metadata
pozorovaných GET šablon. Nelze jej kombinovat s `--diagnostics-content` ani
`--with-history-probe`.

## 3. Datový tok exportu

```text
storage state
    │
    ├─ volitelný one-thread probe ──> validovaný history GET kontrakt
    │
    ▼
fresh guarded Chromium context
    │
    ├─ autentizace a identita účtu
    ├─ pasivní network capture + povolená list pagination
    ├─ DOM scroll seznamu a konzervativní preview hints
    ▼
raw conversations
    │
    ├─ volitelná přímá GET historie podle zachyceného kontraktu
    ├─ coalescing identit a deduplikace
    ├─ normalizace + recruiter klasifikace
    ├─ Zod validace úplného exportu
    ▼
idempotentní merge + atomický zápis messages.json nebo messages.json.partial
```

### 3.1 Session a browser isolation

`src/browser/context.ts` nejprve načte a validuje storage state; při jeho absenci
nevznikne žádný request na LinkedIn. Potom spustí samostatný Playwright Chromium,
vytvoří nový context s `serviceWorkers: 'block'`, vypnutými downloady a před první
exportní stránkou instaluje request guard.

Login i každý export používají nový context. Storage state přenáší cookies a local
storage, nikoli persistentní browser profil nebo service worker.

Export zapisuje storage state pouze při explicitním `login`. Cookies případně
obnovené během exportu používá v daném in-memory contextu, ale neukládá je zpět do
`.auth/linkedin-storage-state.json`. Snapshot může expirovat nebo být serverem
revokován; očekávaný výsledek je `AUTH_REQUIRED` a nový ruční login. Relace je
oddělená od běžného Chrome, ale globální odhlášení nebo bezpečnostní revokace mohou
ukončit obě.

### 3.2 Bezpečnost síťového provozu

`src/browser/request-guard.ts` v exportním contextu:

- blokuje jiné HTTP metody než `GET`, `HEAD` a `OPTIONS`;
- blokuje známé mutační cesty a mutation-like názvy bez ohledu na metodu;
- mezi blokované mutace patří i star/unstar/toggle-star operace; samotný read-only
  list filtr nebo response kategorie `STARRED` blokovaná není;
- blokuje WebSocket upgrade před přenosem frame;
- ukládá jen redigovaný tvar rozhodnutí, nikdy credentials nebo query hodnoty.

Přímé čtecí requesty pro pagination a historii navíc procházejí
`src/linkedin/network/read-policy.ts` a `read-client.ts`. Jsou omezené na povolený
LinkedIn origin/path, nepovolují automatické redirecty a odmítají mutation-like URL.

Probe má užší phase-specific politiku v `probe-request-policy.ts` a navigation gate v
`probe-navigation.ts`. Selection a target fáze jsou oddělené. Target dokument projde
jedním exact GET preflightem bez redirectu; jeho in-memory kopie se zobrazí browseru,
aby browser neposílal druhý document GET. Popup, History API escape, location změna,
cizí thread reference nebo další target navigation ukončí probe fail-closed.

BL-007 přidává `src/browser/probe-transport.ts`: probe context musí vzniknout přes
`createProbeContext` ještě před první page. Lifetime HTTP/CONNECT deny proxy nikdy
nic neforwarduje a explicitně vypíná Chromium implicitní loopback bypass. Zásah
proxy znamená `transport-denied` hard state bez URL či hlaviček v diagnostice.
Gate neakceptuje běžný context. Tato hranice zůstává aktivní také během dispose a
zaniká až s contextem; login a hlavní export transport nemění.

Všechny povolené dokumenty/API se fulfillují přes izolované request contexty bez
redirectů, se stávající úzkou message policy. Assets mají allowlist resource typů
script/stylesheet/image/font a cest `/sc/h/`, `/aero-v1/sc/h/` na stejném originu
nebo `https://static.licdn.com`, případně `/dms/image/` na `https://media.licdn.com`.
Lokální syntetické testy mají `/assets/` pouze na přesném loopback originu fixture.
Asset broker nepřenáší cookies či request hlavičky; do browseru se nikdy nevrací
Set-Cookie. Neznámé resources nemají fallback na browserovou síť. Všechny brokery
povolují pouze GET/HEAD, ověřují response type/size a mají 5s request timeout.

Každý browser request zachytí generation a owning page. Worker bez frame ownership
nedostane oprávnění selection ani target page. Před každým brokerovým síťovým
voláním se generation znovu kontroluje; closing ji synchronně revokuje, drain má
7s fail-closed deadline, potom se selection zavře. Teprve poté vznikne nová target
page. CDP freeze/network fence zůstává pomocná ochrana; bezpečnost již nezávisí na
tom, zda zanikající Playwright frame předá request aplikačnímu Route handleru.

Tato politika je defense-in-depth, ne stealth. Browserové UI se může pokusit o mnoho
POSTů, z nichž část je pouze telemetrie; guard je přesto abortuje před sítí, protože
jejich význam není spolehlivě známý. LinkedIn může automatizaci nadále rozpoznat ze
vzoru, rychlosti a objemu povolených GET requestů. WebSocket/service-worker blokace
zajišťují kontrolovatelný datový tok, nikoli neviditelnost.

### 3.3 Identita účtu

Preferovaný zdroj je read-only `GET /voyager/api/me`. Fallback je důvěryhodná identita
z pasivně zachycené odpovědi; poslední fallback je DOM. Pokud stabilní self ID chybí a
směr některé zprávy nelze dokázat, export se odmítne místo odhadu.

### 3.4 Seznam konverzací

Autoritativní identity konverzací pocházejí z network dat. `response-parser.ts`
tolerantně parsuje známé Voyager/REST/Dash GraphQL obálky a zaznamenává relevantní
parser misses. Pozorované bezpečné pagination URL může `pagination.ts` následovat.

`dom/conversation-list.ts` scrolluje virtualizovaný seznam a sbírá stabilní URL/URN,
pokud existují. Moderní inertní řádky bez identity slouží jen jako důkaz počtu řádků a
zdroj jména/preview. Viditelný text se nepoužívá k vymyšlení conversation ID. Jméno
účastníka se z DOM doplní pouze při jednoznačné one-to-one shodě preview se zprávou.

Úplnost seznamu je konzervativní: network musí dodat alespoň požadovaný limit a DOM
nesmí ukazovat více nevyřešených řádků. Když účet obsahuje méně konverzací než zadaný
limit, současná implementace neumí z pouhého konce DOM bezpečně dokázat globální
úplnost a výsledek proto může zůstat `.partial`.

Na stejných důvěryhodných přímých elementech pozorované Dash conversation-list GET
odpovědi parser čte i `categories[]`. Pouze dobře utvořené pole stringů dává
conversation-level `isStarred`: přesný token `STARRED` po normalizaci velikosti písmen
znamená `true`, validní pole bez něj `false`. Chybějící, malformed, vnořený tracking
nebo message-level objekt neposkytuje evidence a pole se vynechá.

### 3.5 Lazy loading a historie zpráv

LinkedIn používá pro starší zprávy oddělenou persisted GET operaci. UI ji někdy po
otevření threadu vyšle a někdy ne. Proto `history-reader.ts` pracuje takto:

1. Probe zachytí aktuální initial history GET a případně skutečnou older-page GET
   šablonu.
2. Pokud older šablona chybí, reader z initial GET odvodí přesně omezený anchored
   kontrakt. Zachová ostatní bajty URL a vloží pouze ověřená pole `deliveredAt`,
   `countBefore` a `countAfter:0`.
3. Pro každou konverzaci přepíše právě jednu ověřenou conversation identitu.
4. Stránky načítá zpět od času nejstarší dosud známé zprávy. Kotva musí monotónně
   klesat; cizí identita, redirect, cyklus, parser miss nebo nejednoznačný kontrakt
   znamená neúplnost.
5. Konverzace je kompletní jen při souvislé validní evidenci až po koncovou serverovou
   stránku. Rozpočet je nejvýše 250 history stránek na konverzaci.

Výchozí export bez probe může být úplný jen tehdy, když pasivně zachycené serverové
odpovědi samy dokazují kompletní historii všech konverzací. DOM thread reader v
`src/linkedin/dom/thread.ts` je fixture-testovaný pomocný adaptér, ale produkční
export jej nevolá a neproklikává postupně jednotlivé thready.

### 3.6 Snapshot recovery

Pokud nový běh nedokáže znovu načíst starší stránky, smí použít historii z předchozího
úplného `messages.json` pouze když současně platí:

- stejné stabilní conversation ID;
- předchozí historie měla `historyComplete=true` a nulový parser miss;
- čerstvé a staré okno sdílí alespoň jedno stabilní message ID nebo URN;
- aktuální běh nemá relevantní parser miss.

Pouhá shoda conversation ID, textový fingerprint nebo id-less zpráva nestačí. Tím se
brání označení historie s časovou mezerou jako úplné.

## 4. Normalizace, schema a merge

Runtime schema je v `src/domain/schema.ts` a má verzi `schemaVersion: 1`.

Export obsahuje:

- `exportedAt`, identitu `account` a `stats` s limitem, počty, `partial` a warnings;
- konverzace s ID/URN/URL, aktivitou, volitelným `isStarred`, účastníky, zprávami a
  audit metadata;
- účastníky s identitou, self flagem, `probablyRecruiter` a vysvětlujícími signals;
- zprávy se stabilním ID, senderem, volitelným časem, direction, pořadím, textem,
  typem a volitelnými přílohami.

Zod validace odmítá duplicitní identity, neznámé sendery, nesoulad conversation
reference a nesoulad `direction` se self identitou.

`stable-id.ts` preferuje LinkedIn ID/URN. Pokud chybí, vytváří deterministické hash ID.
`merge.ts` spojuje identity přes ID, normalizované URN, bezpečné route/profile aliasy a
u fallback zpráv jen přes jednoznačný fingerprint. Starou historii zachovává,
neduplikuje opakovaný běh a odmítá merge mezi rozdílnými účty. Recruiter klasifikace
je konzervativní heuristika, nikoli jisté profesní označení.

`isStarred` se nepoužívá pro identitu. Nová explicitní hodnota `true` i `false`
přepíše předchozí stav; `undefined` znamená nedostatek současné evidence a zachová
poslední explicitní hodnotu. Pole zůstává optional ve `schemaVersion: 1`, takže starší
exporty jsou zpětně kompatibilní.

## 5. Persistence a ochrana před ztrátou dat

`src/io/export-store.ts` před zápisem načte a znovu validuje existující JSON.
Poškozený existující export se nepřepíše. Zápis používá `write-file-atomic` s `fsync`.

- Úplný výsledek jde do `data/linkedin/messages.json`.
- Neúplný výsledek jde do `data/linkedin/messages.json.partial`.
- `.partial` nikdy nenahrazuje poslední úplný export.
- Opakované běhy se slučují idempotentně; `exportedAt` se může změnit.

Vlastní `--output` změní cestu hlavního souboru; diagnostics vzniknou v sousedním
adresáři `diagnostics/`. U cesty mimo `data/linkedin/` musí uživatel sám zajistit, že
nebude commitnuta.

### 5.1 Odvozené date-range soubory nejsou nativní export

CLI nemá `--since`. Lokální soubory s
`exportType: "linkedin-message-date-range"` vznikly externí `jq` transformací a mají
jiný top-level kontrakt. Neprocházejí strict `ExportSchema`, nejsou podporovaným
vstupem `export-store.ts` a jejich `range.complete` nelze zaměňovat za nativní
`stats.partial=false`. Algoritmus, anonymní výsledky a důkazní hranice jsou v
`docs/OPERATIONS.md`.

## 6. Diagnostika a soukromí

Výchozí manifest obsahuje run ID, časy, status, počty, použité strategie, warnings a
redigované strukturální informace. Query hodnoty, cookies, authorization/CSRF tokeny,
request/response bodies a texty zpráv se do něj neukládají.

`--diagnostics-content` může uložit screenshot a sanitizované HTML, které mohou stále
obsahovat osobní zprávy. Režim je explicitní, data zůstávají lokálně a při login/MFA/
CAPTCHA se obsahová diagnostika nevytváří. Při selhání se ukládá jen po autentizovaném
`PARSER_NO_DATA`.

`.auth/`, `.env`, `data/linkedin/*.json*`, diagnostics a další reálné výstupy jsou v
`.gitignore`. Nesmějí se commitovat ani vkládat do issue, logu nebo AI kontextu.

## 7. Konfigurace a návratové kódy

| Volba / env | Default | Poznámka |
| --- | --- | --- |
| `--state-file` / `LINKEDIN_STATE_FILE` | `.auth/linkedin-storage-state.json` | login i export |
| `--output` / `LINKEDIN_OUTPUT` | `data/linkedin/messages.json` | pouze export |
| `--limit` / `LINKEDIN_LIMIT` | `100` | rozsah 1–500 |
| `--timeout-ms` / `LINKEDIN_TIMEOUT_MS` | `30000` | rozsah 5000–300000 |
| `LINKEDIN_HEADLESS` | `true` | export; `--headed` jej přepne na headed |
| `--with-history-probe` | vypnuto | one-thread opt-in + export |
| `--probe-read-thread` | vypnuto | samostatný metadata-only probe |
| `--diagnostics-content` | vypnuto | potenciálně citlivý screenshot/HTML |

| Exit | Význam |
| --- | --- |
| `0` | Úspěšný login, probe nebo úplný export |
| `1` | Neočekávaná chyba nebo interní AppError bez specializovaného kódu |
| `2` | Neplatná konfigurace/CLI |
| `3` | Chybějící, expirovaná nebo challenge session; spustit login |
| `4` | Explicitně odmítnutá read policy, parser/data nebo validační podmínka |
| `5` | Bezpečně uložený neúplný export do `.partial` |

Vždy se řiďte i logovaným error kódem (`AUTH_REQUIRED`, `READ_POLICY_BLOCK`,
`PARSER_NO_DATA`, `VALIDATION_FAILED`, `PARTIAL_EXPORT`), protože exit 1 a 4 sdružují
více příčin.

## 8. Mapa implementace

| Oblast | Soubory |
| --- | --- |
| CLI/config/error/log redaction | `src/cli.ts`, `config.ts`, `errors.ts`, `logger.ts` |
| Login a storage state | `src/auth/login.ts`, `src/auth/session.ts` |
| Browser isolation a globální guard | `src/browser/context.ts`, `request-guard.ts` |
| Probe lifetime transport deny | `src/browser/probe-transport.ts` |
| Export orchestrace | `src/linkedin/exporter.ts` |
| One-thread opt-in | `probe.ts`, `probe-navigation.ts`, `probe-request-policy.ts` |
| Přímá historie | `history-reader.ts` |
| Network capture/parser/pagination | `src/linkedin/network/*` |
| DOM list a testovaný thread adaptér | `src/linkedin/dom/*` |
| Schema, normalizace, ID, merge, recruiter | `src/domain/*` |
| Atomický export a diagnostika | `src/io/*` |
| Bezpečnostní a funkční důkazy | `tests/unit/*`, `tests/integration/*`, anonymní fixtures |

## 9. Testovací strategie

`npm.cmd run check` spouští typecheck, všechny testy a build. Testy pokrývají mimo
jiné HTTP/WebSocket guard, service-worker isolation, redirect/navigation races,
one-target omezení, Unicode URL safety, parser a pagination, anchored historii,
virtualizovaný DOM, stabilní identity, merge, snapshot recovery, atomický store,
redakci diagnostiky, unauthenticated CLI a trusted-boundary/merge chování `isStarred`.

Integrační testy používají lokální servery a anonymizované fixtures. Nevyžadují
LinkedIn session a nemají sahat na reálná data.

## 10. Známá omezení

- **Aktuální kritická vada BL-007:** selection-page teardown před fresh target page
  není prokázaně deterministická síťová bariéra. Stress test 2026-09-25 jednou
  propustil cizí messaging GET bez guard counteru; do opravy se živý history probe
  nesmí spouštět.
- **Aktuální kritická vada BL-006:** `textFrom()` může vybrat top-level InMail
  `subject` dříve než skutečný nested message body. Existující reálné exporty nejsou
  obsahově důvěryhodné; schema ani unikátní ID tuto sémantickou záměnu neodhalí.
- End-to-end byl živě ověřen limit 100; limit 200 je podporovaný, ale na tomto účtu
  nebyl živě ověřen. Maximální povolená konfigurace je 500.
- Lazy-loading older-page operace je na straně LinkedIn UI nondeterministický. Na
  zcela prvním běhu bez předchozího úplného snapshotu může dlouhá historie skončit
  `.partial`.
- Požadovaný limit vyšší než skutečný počet dostupných konverzací nemusí být možné
  bezpečně prokázat jako úplný a může skončit `.partial`.
- LinkedIn používá neveřejné DOM a endpointy. Změna kontraktu má vést k fail-closed
  výsledku, ale může vyžadovat úpravu parseru/politiky.
- Přísná blokace POST záměrně odmítne i případný read-only GraphQL POST, protože jej
  nelze spolehlivě odlišit od mutace.
- Blokování POST/WebSocket/service workerů neskrývá automatizaci před LinkedIn.
- Storage state je statický snapshot z posledního loginu; export jej na disku
  neobnovuje.
- CLI nemá nativní date-range režim. Dosavadní soubory od 1. 5. 2026 jsou odvozené
  postprocessingem a mají vlastní, nativně nevalidované top-level schema.
- Recruiter flag je konzervativní heuristika.
- `isStarred` zůstává neznámé, pokud trusted list response neobsahuje validní
  `categories[]`; není odvozováno z CSS ani z textu. Dva izolované browserové běhy
  2026-09-24 ověřily jeho živý export na 100 konverzacích (8 true, 92 false,
  0 unknown/invalid), ale ne globální úplnost historie zpráv.
- Úplný hlavní export byl naposledy živě ověřen 2026-09-07. Dva bezpečné validační
  exporty `isStarred` proběhly 2026-09-24 a zůstaly oddělenými `.partial` výstupy.
- Provozní běh 2026-09-25 požadoval 150, lazy-loading načetl 120 konverzací a raw
  výstup zůstal `.partial`; podrobnosti a přesné časování jsou v `docs/OPERATIONS.md`.

## 11. Bezpečný postup změny

1. Přečíst `HANDOVER.md`, tento dokument a relevantní rozhodnutí.
2. Zkontrolovat `git status` a pouze dotčené moduly/testy.
3. Neměnit read policy nebo probe hranice bez odpovídajících negativních testů.
4. Spustit `npm.cmd run check`, `npm.cmd audit --omit=dev` a plný `npm.cmd audit`.
5. Živý LinkedIn běh provést pouze po explicitním souhlasu vlastníka účtu; běžný
   Chrome nechat nedotčený.
6. Nezveřejnit ani necommitovat session, export nebo obsahovou diagnostiku.
7. Aktualizovat současnou dokumentaci; historické omyly nepřepisovat jako současnost.
