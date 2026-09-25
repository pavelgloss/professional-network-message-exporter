# LinkedIn messages reader

Lokální read-only export LinkedIn zpráv do validovaného JSON. Nástroj nic neodesílá,
nemaže, nearchivuje ani nemění profil. V exportním režimu blokuje všechny HTTP metody
kromě `GET`, `HEAD` a `OPTIONS`, veškeré WebSockety; service workery jsou vypnuté. Používání automatizace
se řídí podmínkami LinkedIn a odpovědností vlastníka účtu.

> **Aktuální kritický blocker:** Parser může u InMail eventů uložit top-level
> `subject` místo skutečného textu zprávy. Existující reálné JSON exporty proto nejsou
> důvěryhodné pro práci s obsahem, dokud nebude opraven a ověřen
> [BL-006](BACKLOG.md#bl-006--kritické-inmail-subject-se-chybně-exportuje-jako-text-zprávy).
>
> **Aktuální bezpečnostní blocker:** Intermittent selection-page teardown race může
> před history probe propustit cizí messaging GET bez záznamu guardu. Do opravy
> [BL-007](BACKLOG.md#bl-007--kritické-deterministicky-uzavřít-síť-selection-stránky-před-history-probe)
> nespouštějte živý history probe.

## Dokumentace a předání projektu

Pro běžné použití pokračujte tímto README. Nový vývojář nebo AI agent má začít v
[`HANDOVER.md`](HANDOVER.md), potom přečíst autoritativní
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) a
[`docs/DECISIONS.md`](docs/DECISIONS.md). Poslední živé běhy a odvozené lokální
výstupy jsou v [`docs/OPERATIONS.md`](docs/OPERATIONS.md). Úplný rozcestník včetně
jasně oddělených historických dokumentů je v [`docs/README.md`](docs/README.md).
Konsolidované odpovědi na praktické otázky jsou v [`FAQs.md`](FAQs.md).
Restartovatelný stav implementace backlogu a přesná další akce jsou v
[`BACKLOG_PROGRESS.md`](BACKLOG_PROGRESS.md).

Dokumenty v `docs/history/` zachycují vývoj, slepé cesty a staré review. Nejsou
aktuálními provozními instrukcemi.

## Instalace

Vyžaduje Node.js 22+:

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

## Jednorázové přihlášení

```powershell
npm.cmd run login
```

Dokončete login, MFA nebo CAPTCHA ručně pouze v otevřeném Chromium. Aplikace heslo
nečte. Login používá nový dočasný browser context se zakázanými service workery a
atomicky uloží pouze cookies/local storage do tajného, ignorovaného souboru
`.auth/linkedin-storage-state.json`. Staré persistentní browser profily aplikace
nepoužívá. Jde o samostatnou LinkedIn session, nikoli kopii session z běžného Chrome.
Export případné serverem obnovené cookies neukládá zpět do tohoto souboru; pokud
snapshot expiruje nebo je serverem revokován, spusťte login znovu.

## Export

Do opravy BL-006 slouží následující část jako popis současného CLI, ne jako potvrzení,
že jeho reálný výstup má správný text všech zpráv.

Bezpečný network-first režim:

```powershell
npm.cmd run export -- --limit 100
```

Tento výchozí příkaz neotevře žádné vlákno a při chybějící historii bezpečně
vytvoří jen `.partial` kandidát. Pro úplný export je nutný samostatný vědomý opt-in,
který otevře nejvýše jedno serverem potvrzené již přečtené vlákno, zachytí jeho
read-only GET šablony a stejným během načte historie:

```powershell
npm.cmd run export -- --limit 100 --with-history-probe
```

Každý export vytvoří fresh ephemeral Chromium context, načte pouze storage state,
zakáže service workery a nainstaluje HTTP/WebSocket guardy před vytvořením stránky.
Probe použije jeden již přečtený thread k zachycení aktuálního počátečního GET a,
pokud ji UI odešle, i šablony starší stránky. Jinak se dříve živě ověřený anchored
kontrakt odvodí vložením polí do aktuálního počátečního GET bez překódování zbytku.
Další historie se čte přes izolovaný request context: vždy stejnou pozorovanou
operací `messengerMessages`, s kotvou `deliveredAt` nejstarší dosud načtené zprávy.
Nástroj zachovává ostatní bajty URL, připustí právě jedno ID
cílové konverzace, vyžaduje klesající kotvu a skončí až na serverové stránce kratší
než pozorované `countBefore`. Cizí ID, parser miss, cyklus, redirect, nejednoznačná
šablona nebo limit 250 stránek zneplatní úplnost daného vlákna.

Úplný výsledek je v `data/linkedin/messages.json`; reálný export, session i diagnostika
jsou v `.gitignore`. Neúplný běh vrátí nenulový exit code `5`, uloží bezpečný kandidát
do `data/linkedin/messages.json.partial` a poslední úplný export nezmění. Opakovaný
běh sloučí data podle LinkedIn ID nebo deterministického fallback ID a zachová dříve
načtenou historii. Pokud LinkedIn při opakovaném běhu nevydá starší stránkovací
operaci, aktuální první stránka se sloučí s předchozí serverově prokázanou úplnou
historií stejného conversation ID. To se nepoužije při parser missu ani pro novou
konverzaci; první export proto zůstává striktně fail-closed.

Každá konverzace může mít volitelné top-level pole `isStarred`. `true` znamená, že
důvěryhodná aktuální conversation-list GET odpověď obsahovala v `categories[]` přesný
token `STARRED` (bez ohledu na velikost písmen); `false` znamená validní pole kategorií
bez tohoto tokenu. Chybějící nebo nerozpoznaný údaj se vynechá, aby nebyl zaměněn za
`false`. Při merge nová explicitní hodnota přepíše starou, zatímco chybějící hodnota
zachová poslední explicitní stav. Jde o vlastnost celé konverzace, nikoli jednotlivé
zprávy. Export hvězdičku pouze čte; star/unstar requesty zůstávají blokované.

LinkedIn často načte celou historii až po otevření konkrétního vlákna. Výchozí
exportní běh vlákna nikdy neotevírá a při nepotvrzené úplnosti skončí jako
`partial`; pouze varianta s `--with-history-probe` má popsaný one-thread opt-in.

Samostatný, výchozím stavem vypnutý probe lze použít pouze k nalezení redigované
šablony GET dotazu na historii:

```powershell
npm.cmd run probe:read-thread
```

Probe nic neexportuje do hlavního ani `.partial` JSON. Z pasivní network odpovědi
vybere pouze konverzaci s explicitním `read === true`, otevře právě jeden její URL
jediným navigation callem a do ignorovaného diagnostického manifestu uloží jen
redigovaný tvar pozorovaných GET history query (bez hodnot parametrů). Když již
přečtený stav nelze explicitně prokázat, skončí bez otevření vlákna. Otevření i již
přečteného vlákna je vědomý opt-in; HTTP/WebSocket/service-worker guard zůstává
aktivní. Probe není součástí běžného exportu.

Před browserovým načtením cíle probe provede jediný exact GET preflight bez
přesměrování. Pouze odpověď `200 text/html` bez `Location` se jednou zobrazí z kopie
držené v paměti; browser proto neposílá druhý document GET. Jakýkoli serverový nebo
client-side redirect, popup či pokus přejít na jiný thread ukončí probe fail-closed.

Limit lze změnit proměnnou `LINKEDIN_LIMIT` v lokálním `.env`.
Všechny JSON výstupy přímo v `data/linkedin/`, jejich `.partial` kandidáti i sousední
`diagnostics/` jsou ignorované Gitem. Při vlastním `--output` mimo tento adresář
zajistěte totéž ručně.
LinkedIn může měnit neveřejné endpointy/DOM. Striktní blokace POST může zablokovat i
read-only GraphQL POST, protože jej bez stabilního veřejného kontraktu nelze bezpečně
odlišit od mutace; v takovém případě export raději skončí neúplný.

Guard zachytí zakázaný request před odesláním na síť. Ne každý blokovaný POST je
mutace; mnoho z nich je pravděpodobně telemetrie. Blokace je bezpečnostní pojistka,
nikoli ochrana před detekcí automatizace. LinkedIn může způsob použití poznat i ze
vzoru povolených GET požadavků.

## Export od konkrétního data

CLI aktuálně nemá přepínač `--since`. Soubory s
`exportType: "linkedin-message-date-range"` vytvořené během živých běhů 2026-09-24 a
2026-09-25 jsou následně filtrované a slučované lokální `jq` výstupy, nikoli nativní
výstup `ExportSchema`. Nesmějí se použít jako vstup pro `export-store.ts`.

Přesná provenience, anonymní počty, časování a omezení tvrzení o úplnosti jsou v
[`docs/OPERATIONS.md`](docs/OPERATIONS.md). Pokud má být date-range export běžnou
funkcí, musí vzniknout samostatný otestovaný `--since` nebo verzovaný transformační
nástroj; současná CLI dokumentace takovou funkci neslibuje.

## Známá omezení

- Kritický BL-007: stress test jednou reprodukoval síťový únik requestu staré
  selection stránky bez hard-failure counteru; živý probe je do opravy blokovaný.
- Kritický BL-006: u InMail zpráv může být `subject` zaměněn za `Message.text`; schema,
  unikátní ID ani `partial=false` tuto sémantickou chybu neodhalí.
- Živě byl ověřen úplný export 100 konverzací. `--limit 200` je podporovaný, ale
  export 200 konverzací zatím nebyl end-to-end ověřen na tomto účtu.
- LinkedIn během ověřování nevykazoval aktivní blokování (CAPTCHA ani rate limit).
  Proměnlivé bylo pouze to, zda jeho UI samo odešle interní GET pro starší stránku.
- Když tento starší operation template při úplně prvním běhu nevznikne a není k
  dispozici předchozí úplný snapshot, dlouhá historie může skončit jako `.partial`.
  Nástroj v takovém případě nepřepíše poslední úplný `messages.json`.
- Pokud je zadaný limit vyšší než skutečný počet dostupných konverzací, konzervativní
  kontrola nemusí umět z DOM bezpečně dokázat globální úplnost a může rovněž vrátit
  `.partial`.
- Opakovaný běh může předchozí úplnou historii použít pouze pro stejné conversation
  ID, při překryvu alespoň jednoho stabilního message ID/URN a bez parser missu.
- Neveřejné LinkedIn endpointy nebo DOM se mohou v budoucnu změnit; očekávané
  chování při nerozpoznané změně je bezpečné selhání a diagnostika, ne tichý
  neúplný export.
- `isStarred` je dostupné jen tehdy, když LinkedIn vrátí dobře utvořené `categories`
  v důvěryhodné list odpovědi. Absence pole znamená „neznámé“, ne automaticky `false`.
- Storage state se při exportu neobnovuje na disku a může vypršet; očekávaná náprava
  je nový ruční `npm.cmd run login` v izolovaném Chromium.

Kontrola projektu:

```powershell
npm.cmd run check
```
