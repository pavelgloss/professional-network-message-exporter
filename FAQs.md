# FAQ — LinkedIn messages reader

Stav odpovědí: **2026-09-25**. Tento dokument konsoliduje praktické otázky z vývoje
projektu a rozlišuje, co nástroj dělá **dnes**, od změn pouze požadovaných v
[`BACKLOG.md`](BACKLOG.md). Při rozporu má přednost aktuální `HANDOVER.md`, zdrojový
kód a testy; dokumenty v `docs/history/` jsou archivní.

> **Kritické upozornění:** BL-006 blokuje důvěryhodný export obsahu. Současný parser
> může u InMail eventů uložit `subject` místo skutečného textu zprávy, takže existující
> reálné JSON exporty nepoužívejte pro obsahovou analýzu, dokud nebude chyba opravena,
> zrevidována a ověřena novým nezávislým exportem.

## Projekt, stav a důvěryhodnost

### Vznikl exporter v této konverzaci, nebo už existoval?

Projekt byl v této práci vytvořen od začátku podle `zadani.md`; následně se doplňovala
bezpečnost, stránkování, stabilní identity, `isStarred`, testy a dokumentace.

### Je projekt hotový a funguje?

Framework, autentizace, read-only načítání, schema, persistence a testy fungují, ale
projekt nyní **není hotový pro důvěryhodný obsahový export**, protože BL-006 může
zaměnit InMail subject za text zprávy.

### Jak si můžeme být jistí, že se export „nezačne rozbíjet“?

Absolutní jistotu u neveřejného LinkedIn API nelze dát; nástroj má fail-closed guardy,
schema a 157 testů, ale BL-006 zároveň dokazuje, že strukturálně validní JSON a zelené
testy samy o sobě nezaručují sémanticky správný obsah bez realistických fixtures a
živé validace.

### Proč byl vývoj tak složitý a dlouhý?

Nejtěžší byly neveřejné LinkedIn GET kontrakty, dokazování úplnosti, stránkování,
izolace účtu a ochrana proti mutacím; část času však vznikla i našimi vlastními
chybnými hypotézami, příliš komplikovaným postupem a chybějící InMail regresní fixture.

### Bránil se LinkedIn aktivně nebo pořád měnil odpovědi?

Během ověřování nebyla pozorována CAPTCHA ani rate limiting a základní odpovědi byly
poměrně konzistentní; nondeterministické bylo hlavně to, zda UI samo vyšle older-page
GET, zatímco kritická záměna subject/body je chyba našeho parseru.

### Je lazy loading vyřešený?

Historie threadů se umí stránkovat přímými GETy s klesající časovou kotvou, ale načtení
seznamu konverzací stále závisí na virtualizovaném LinkedIn UI a může skončit limitem,
stagnací nebo `.partial`; není tedy správné tvrdit, že všechny lazy-loading scénáře
jsou definitivně vyřešené.

### Má projekt testy a aktuální dokumentaci?

Ano: poslední kontrola prošla 157/157 testy, typecheckem a buildem; aktivní kontext je
v `HANDOVER.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`,
`docs/OPERATIONS.md`, tomto FAQ a backlogu, zatímco historické návrhy jsou označené v
`docs/history/`.

### Znamená 157 zelených testů, že jsou exportované texty správné?

Ne; testům chybí realistický InMail event se současným `subject` a nested body, proto
BL-006 prošel bez povšimnutí a musí dostat vlastní anonymizovanou regresní fixture.

### Umí nástroj stáhnout 200 posledních konverzací?

CLI přijímá `--limit 200` a povoluje nejvýše 500 konverzací, ale živě bylo kompletně
ověřeno pouze 100 a limit 200 proto zatím není end-to-end garantovaný.

### Znamená `--limit N` počet zpráv?

Ne, `--limit` znamená počet nejnovějších **konverzací**; každá vybraná konverzace může
obsahovat různý počet zpráv.

## Nový export, merge a výstupní soubory

### Co uživatel myslí „úplně novým exportem“?

Nový export má být samostatný snapshot získaný v jednom běhu, který nečte ani
nepřebírá záznamy z žádného staršího JSON; toto je požadované budoucí chování BL-003.

### Je každý dnešní běh CLI automaticky nezávislý?

Ne: současný default zapisuje stále do `data/linkedin/messages.json` a pokud soubor
existuje, `export-store.ts` jej automaticky načte a merguje s novým výsledkem.

### Co přesně se dnes merguje?

Úplný běh merguje nový výsledek s existujícím hlavním JSON, neúplný běh s existujícím
`.partial` nebo hlavním JSON, a history reader může za přísných podmínek převzít
dříve prokázanou kompletní historii stejného threadu.

### Je `.partial` pouze dočasný soubor jednoho běhu?

Ne v současné implementaci: je to bezpečně uložený neúplný kandidát a při dalším běhu
do stejné výstupní cesty může být použit jako merge baseline; BL-003 požaduje, aby
pracovní soubory patřily právě jednomu runu a nebyly skrytým vstupem dalšího snapshotu.

### Jak dnes technicky vytvořit opravdu nezávislý export?

Je nutné použít dosud neexistující unikátní cestu, například
`--output data/linkedin/run-<čas>/messages.json`; BL-003 má později zajistit unikátní
bundle automaticky a přesunout merge do explicitního režimu.

### Co se má podle backlogu změnit?

BL-003 požaduje nový immutable bundle při každém běžném spuštění a případný merge jen
přes explicitní volbu typu `--incremental-from`; starší export se pak bez této volby
vůbec neotevře.

### Když někdo na LinkedIn upraví zprávu, získá nový export aktuální text?

Skutečně nezávislý běh, který danou zprávu znovu pokryje, má stáhnout aktuální serverový
obsah pod stejným message ID; současný implicitní merge však může zachovat starší
nepřekrývající se data, což je další důvod pro BL-003.

### Ukládá jedna konverzace celý thread včetně odpovědí obou stran a timestampů?

To je zamýšlený model: `Conversation.messages[]` obsahuje inbound i outbound zprávy,
sendera, `sentAt`, směr a pořadí; úplnost se smí tvrdit jen při prokázaném konci
historie a po opravě obsahového parseru BL-006.

### Je výsledek jeden JSON soubor a kde se ukládá?

Ano, dnešní výchozí výstup je jeden `data/linkedin/messages.json` obsahující všechny
vybrané konverzace a jejich zprávy; neúplný běh zapisuje sousední
`data/linkedin/messages.json.partial` a přílohy se zatím jako soubory nestahují.

### Který běžný soubor je výsledek a co znamená `.partial`?

`data/linkedin/messages.json` je hlavní schema-validní výstup, zatímco
`messages.json.partial` znamená bezpečně uložený neúplný kandidát, který nesmí být
zaměněn za prokázaně úplný export.

### Co byly `messages-since-2026-05-01-updated.json` a jeho `.source.json.partial`?

`.source.json.partial` byl neúplný nativní kandidát použitý jako zdroj ad-hoc
transformace a `-updated.json` byl následně filtrovaný a explicitně inkrementálně
sloučený date-range artefakt; oba jsou nyní kvůli BL-006 obsahově nedůvěryhodné.

### Proč vznikl `-updated.json` sloučením s předchozím exportem?

Bylo to jednorázové rozhodnutí při ad-hoc date-range aktualizaci, protože fresh seznam
120 konverzací nepřekročil požadovanou datumovou hranici; nebyla to nativní funkce
`--since`, ale současné CLI má vedle toho i vlastní implicitní merge stejné output cesty.

### Umí CLI export OD–DO nebo posledních N zpráv?

Ne; aktuálně umí limit nejnovějších konverzací, nikoli nativní datumový rozsah ani
globálních posledních N zpráv.

### Jak proběhla dřívější filtrace od 1. 5. 2026?

Lokální `jq` transformace ponechala zprávy od UTC ekvivalentu hranice, odstranila
prázdné konverzace a přepočítala sekvence a statistiky; nebyla součástí nativního CLI.

### Dělal filtraci a merge skript, nebo LLM ručně?

Samotnou transformaci dat provedl deterministický lokální skript spuštěný agentem;
LLM navrhl a spustil postup, ale nepřepisoval jednotlivé zprávy ve svém kontextu.

### Co znamenalo měření „filtrace a sloučení 0,562 sekundy“?

Šlo o wall-clock čas lokálního `jq` procesu bez času LLM uvažování, exportu z LinkedIn
nebo následné kontroly.

### Jak dlouho běžel tehdejší aktualizační export samotný?

Nativní exportní proces 2026-09-25 trval 3:57.842 a následná transformace 0.562 s;
jde o historické měření běhu, jehož obsah je dnes kvůli BL-006 označený za vadný.

### Jaký byl historický rozdíl old vs. updated date-range export?

Strukturálně přibylo 7 konverzací a 18 zpráv a žádné dřívější message ID nechybělo,
ale tento diff nesmí být interpretován jako důkaz správného textu kvůli BL-006.

## Identity, duplicity a metadata

### Jsou conversation, thread, message a participant ID stabilní mezi exporty?

Skutečná LinkedIn ID/URN mají být pro stejnou entitu stabilní, ale jde o neveřejný
kontrakt; lokální fallback ID jsou deterministická pouze dokud se nezmění jejich
vstupní data nebo nejsou nahrazena silnější LinkedIn identitou.

### Jsou „conversation“ a „thread“ dvě různé identity?

V tomto projektu označují prakticky stejnou konverzační entitu; `conversationId` se
odvozuje z LinkedIn conversation/thread URN nebo route.

### Které hodnoty nejsou stabilní identitou?

`sequence` je pouze pořadí ve výsledném threadu a po filtraci či novém seřazení se může
změnit; profilová URL nebo jméno rovněž nemají nahrazovat stabilní person ID/URN.

### Proč některé záznamy obsahují `Unknown participant`?

History event často přinese stabilní sender ID bez display name a současný enrichment
jej neumí vždy bezpečně propojit s list/profile daty; zlepšení bez hádání identity je
v BL-001.

### Ukládá se hvězdička jako `isStarred`?

Ano, `isStarred` je volitelné pole celé konverzace získané z důvěryhodného
conversation-list `categories[]`; není to tag jednotlivé zprávy a export ji nemění.

### Jsou opakované texty typu `AI Architect @ČEPS` skutečné duplicity?

Nejde o duplicitní message ID, ale o kritickou chybu parseru BL-006: různé eventy mají
vlastní ID, timestamp a směr, avšak parser do `text` nesprávně vloží společný InMail
subject.

### Jak velký je známý dopad BL-006?

V jednom aktualizovaném date-range souboru bylo nejméně 107 z 253 zpráv ve 28
konverzacích silně podezřelých; skutečný rozsah může být vyšší, protože jednoduchá
kontrola zachytila jen opakované texty.

### Vznikla tato chyba při merge?

Ne, vadný text byl už ve `.source.json.partial`, takže vznikl při network parsování
před následnou datumovou filtrací a explicitním date-range mergem.

## Browser, přihlášení a session

### Otevírá export browser a musí běžet můj běžný Chrome?

Export spouští vlastní izolovaný Playwright Chromium, defaultně headless, a běžný
Chrome ani jeho otevřené taby nepotřebuje, nepoužívá a nesmí zavírat.

### Jak probíhá login?

`npm.cmd run login` otevře samostatné viditelné Chromium, uživatel ručně dokončí
přihlášení/MFA/CAPTCHA a po potvrzení autentizace se uloží storage state a okno se
záměrně zavře.

### Kde jsou cookies pro autentizaci?

Jsou v ignorovaném `.auth/linkedin-storage-state.json`, který obsahuje Playwright
cookies a local storage; export nepřebírá cookies z běžného Chrome.

### Nezestárne storage state?

Ano, může expirovat nebo být LinkedInem revokován; očekávaný výsledek je
`AUTH_REQUIRED` a řešením je nový ruční `npm.cmd run login`.

### Aktualizuje export uložené cookies na disku?

Ne; serverem obnovené cookies platí jen uvnitř aktuálního dočasného contextu a do
`.auth/linkedin-storage-state.json` se po exportu nezapisují.

### Ovlivní logout v běžném Chrome Playwright session?

Běžné odhlášení pouze jedné Chrome session ji obvykle neovlivní, ale globální logout,
změna hesla nebo bezpečnostní revokace mohou ukončit i uloženou Playwright session.

### Co je „browser Codexu“ a jak souvisí s Playwrightem projektu?

Je to samostatný volitelný browser ovládaný agentovým rozhraním; nemá vztah k
Chromiu, které si tento Node/Playwright skript spouští sám, a jeho nedostupnost export
neblokuje.

## Jak se zprávy technicky získávají

### Co je LinkedIn network odpověď?

Je to JSON, který LinkedIn server vrátí prohlížeči na interní API GET, například se
seznamem konverzací nebo eventy konkrétního threadu.

### Je history „template“ HTML stránka?

Ne; je to aktuálně odpozorovaný vzor interního GET URL, proměnných a bezpečných
hlaviček, který browser vyšle při načtení jednoho threadu.

### Obsahuje načtené HTML předem přesné GET URL pro prvních 100 zpráv?

Ne; browser za běhu vyšle list/history API dotazy, jeden history response vrací dávku
message eventů a nástroj z jednoho ověřeného kontraktu vytváří cílené stránkované GETy
pro jednotlivé konverzace.

### Proč se template odpozorovává místo pevného endpointu?

LinkedIn používá neveřejný persisted GraphQL `queryId`/hash a proměnné s identitou
konverzace a stránkovací kotvou, které se mohou s frontend deploymentem změnit.

### Dělá se history probe při každém dnešním exportu?

Pouze pokud je zadán `--with-history-probe`; BL-005 požaduje, aby jeden fresh probe
byl v budoucnu default každého nového exportu a existoval explicitní opt-out.

### Co přesně probe otevře?

V odděleném izolovaném contextu otevře nejvýše jeden thread, který aktuální serverová
odpověď explicitně potvrzuje jako přečtený, zachytí jeho GET kontrakt a pro tento běh
jej předá history readeru.

### Otevírá se potom každá konverzace přes Chromium UI?

Ne; ostatní historie se čtou sekvenčně přímými autentizovanými GETy přes Playwright
`APIRequestContext`, přičemž se bezpečně dosazuje právě jedna cílová identita.

### Nebylo by jistější dělat každý GET přes vykreslenou Chromium stránku?

Ne: navigace a render každého threadu by byly výrazně pomalejší a stále by trpěly
nondeterministickým UI lazy loadingem, zatímco přímý request context používá stejnou
autentizovanou session bez proklikávání všech vláken.

### Jak se získávají další stránky historie?

Reader používá odpozorovaný nebo bezpečně odvozený anchored GET, nastaví `deliveredAt`
na nejstarší dosud načtenou zprávu, vyžaduje klesající kotvu a pokračuje, dokud server
nevrátí důkaz konce nebo nenastane bezpečnostní/stránkovací limit.

### Používá nástroj delay kvůli throttlingu?

Ano, ale jen jako mírné sekvenční pacing: history stránky čekají přibližně 100–199 ms,
list pagination 250–499 ms a DOM scroll typicky 600–700 ms; nejde o záruku proti
rate limitu ani mechanismus skrývající automatizaci.

### Pozná LinkedIn, že se mnoho zpráv čte skriptem?

Může; guardy chrání proti změnám účtu, nikoli proti detekci, a LinkedIn může vyhodnotit
automatizovaný browser, rychlost nebo vzor povolených GETů.

### Proč se blokují POSTy, WebSockety a service workery?

Protože browserová stránka může na pozadí spustit telemetrii nebo stavovou operaci a
hlavní požadavek projektu je nic na účtu neměnit; nejasná operace proto raději skončí
fail-closed než aby byla odeslána.

### Mohlo by obyčejné čtení změnit hvězdičku nebo odeslat reakci?

Samotný správný read GET by to dělat neměl, ale obecná LinkedIn stránka může aktivovat
další requesty; blokace je defense-in-depth, ne tvrzení, že čtení běžně hvězdičkuje
nebo reaguje.

### Může se zpráva označit jako přečtená?

Otevření unread threadu by tento stav změnit mohlo, proto probe vybírá pouze thread s
aktuálním explicitním serverovým důkazem `read=true`; přímé history GETy neproklikávají
ostatní thready v UI.

### Je tedy lepší současné blokování zachovat?

Ano pro deklarovaný požadavek „nic na účtu neměnit“, i když může způsobit `.partial`
nebo selhání, pokud LinkedIn přesune potřebnou read operaci na nerozlišitelný POST.

## Přílohy, archiv a rozsah dat

### Stahují se PDF a jiné přílohy lokálně?

Ne, současný export ukládá jen metadata a LinkedIn URL; BL-002 požaduje defaultní
lokální download s CLI opt-outem a samostatným adresářem každého exportního bundle.

### Umí export archivované konverzace?

Nejsou cíleně podporované ani živě ověřené; BL-004 je pouze volitelný research task a
neznamená rozhodnutí tuto funkci implementovat.

### Jsou recruiter flagy jisté profesní údaje?

Ne, `probablyRecruiter` je konzervativní heuristika založená na profile/message
signálech a není autoritativní LinkedIn klasifikací.

## GitHub, soukromí a právní hranice

### Lze zdrojový repozitář zveřejnit na GitHubu?

Technicky ano, pokud se předem ověří, že commit neobsahuje `.auth`, cookies, `.env`,
reálné exporty ani obsahové diagnostics; `.gitignore` tyto lokální artefakty nyní
vylučuje, ale stav a historii je nutné před publikací zkontrolovat.

### Je lokální použití automaticky v pořádku jen proto, že nejde o SaaS?

Ne; lokální versus SaaS provoz sám nerozhoduje o souladu s LinkedIn podmínkami nebo
právem, takže zveřejnění kódu ani způsob nasazení není právní záruka a tento projekt
neposkytuje právní stanovisko.

### Commitují se reálné zprávy nebo session?

Ne; `.auth/`, `.env`, `data/linkedin/*.json*`, diagnostics a logy jsou ignorované a
nesmějí se přidat do Gitu ani vložit do AI kontextu.

## Další vývoj a předání

### Je lepší pokračovat v této dlouhé session, nebo začít novou?

Pro další implementaci je lepší nová session ve stejném repozitáři, protože aktuální
kontext je uložený v commitech a dokumentaci a dlouhý chat obsahuje i později opravená
tvrzení.

### Co má nový agent přečíst jako první?

Po `AGENTS.md` má číst `HANDOVER.md`, potom `README.md`, architekturu, rozhodnutí,
operations, backlog a toto FAQ; historické checkpointy jen při cíleném pátrání.

### Jaký je první další úkol?

Nejdřív BL-006: opravit subject/body parser, přidat realistické regresní testy, udělat
nezávislé code review a teprve s explicitním souhlasem vytvořit nový živý export.

### Jaké další požadavky jsou v backlogu?

BL-003 zavádí nezávislé snapshoty, BL-005 defaultní one-thread probe, BL-001 doplnění
jmen, BL-002 lokální přílohy a BL-004 pouze research archivovaných konverzací.

### Kde jsou staré návrhy a slepé cesty?

Jsou v `docs/history/`; mohou vysvětlit vývoj rozhodnutí, ale nesmějí přebít aktuální
handover, architekturu, backlog nebo zdrojový kód.
