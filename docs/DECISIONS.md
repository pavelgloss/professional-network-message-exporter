# Architektonická rozhodnutí a jejich vývoj

Stav: **aktuální k 2026-09-25**. Tento soubor shrnuje výsledná rozhodnutí. Podrobný
chronologický důkaz je v `docs/history/HANDOVER_CHECKPOINTS.md` a
`docs/history/CODE_REVIEW_LOG.md`.

## D1 — Ephemeral context se storage state místo persistentního profilu

**Rozhodnutí:** Login uloží Playwright storage state. Každý export vytvoří nový
Chromium context a načte jen tento stav.

**Proč:** Izoluje export od běžného Chrome a nepřenáší persistentní service worker ani
jiný profilový stav. Umožňuje instalovat guard před první exportní stránkou.

**Vývoj:** Původní plán počítal s persistentním profilem. Runtime test prokázal, že
uložený service worker představuje obtížně dokazatelný kanál mimo původní HTTP guard;
návrh byl nahrazen storage-state izolací.

**Důsledek:** Staré zmínky o persistentním profilu jsou historické. Běžný Chrome se
nesmí používat ani zavírat. Export storage state na disku neobnovuje; po expiraci či
revokaci je nutný nový explicitní login. Relace běžného Chrome a Playwright jsou
samostatné, ale globální bezpečnostní revokace může ukončit obě.

## D2 — Fail-closed síťová politika

**Rozhodnutí:** Export připouští jen read-like `GET`/`HEAD`/`OPTIONS`, blokuje mutační
vzory, WebSockety a service workery. Přímé requesty mají užší allowlist a zakázané
redirecty.

**Proč:** Hlavní požadavek je nic na LinkedIn neměnit. Úplnost exportu má nižší
prioritu než bezpečnost účtu.

**Důsledek:** I legitimní read-only POST může být zablokován. Nejasnost vede k chybě
nebo `.partial`, nikoli k rozšíření oprávnění.

**Co rozhodnutí neřeší:** Guard není anti-detection mechanismus. Část blokovaných
POSTů je pravděpodobně telemetrie a LinkedIn může automatizaci rozpoznat ze vzoru
povolených GETů. Cílem je kontrola vedlejších efektů, nikoli neviditelnost.

## D3 — Network identity je autoritativní, DOM je doplněk

Viz také D13 pro transportní hranici speciálního probe contextu.

**Rozhodnutí:** Conversation/message/participant identity se bere primárně z network
odpovědí. Inertní DOM řádky bez URL/URN nesmí dostat ID odvozené z viditelného textu.

**Proč:** Text, jméno a preview nejsou stabilní a vytvářely by duplicity. DOM však
pomáhá scrollovat virtualizovaný seznam a jednoznačně doplnit jméno.

**Důsledek:** Nevyřešený DOM řádek může způsobit `.partial`; to je záměrně
konzervativní.

## D4 — Otevření nejvýše jednoho aktuálně potvrzeného read threadu

**Rozhodnutí:** Výchozí export thread neotevírá. Explicitní `--with-history-probe`
smí otevřít jeden target s aktuálním network `read=true` a bez konfliktu.

**Aktualizace 2026-09-26:** BL-007 je uzavřen lifetime transportní bariérou (D13),
opakovanými server-hit-0 testy a nezávislým review. BL-005 později mění opt-in na
default bez oslabení one-thread/read-evidence hranice.

**Proč:** Otevření unread vlákna by mohlo změnit serverový stav. Postupné DOM
proklikávání všech threadů by zvětšilo riziko i počet navigací.

**Vývoj:** Původní obecný `--allow-thread-open` byl nahrazen přesně omezeným
one-thread workflow s phase-specific request policy a navigation gate.

## D5 — History template se zachytí jednou, historie se čtou přímými GET

**Rozhodnutí:** Probe získá aktuální persisted GET kontrakt; historie všech vybraných
konverzací pak čte izolovaný request context přepisem právě jedné identity a klesající
časové kotvy.

**Proč:** LinkedIn UI lazy loading older-page requestu je nondeterministický. Přímý
GET je po získání správného kontraktu determinističtější a nevyžaduje otevírat každé
vlákno.

**Vývoj a slepé cesty:** DOM scroll threadu, synchronizační tokeny a několik
nesprávných pagination hypotéz nedávaly úplný nebo reprodukovatelný výsledek. Ukázalo
se, že starší stránka používá samostatnou persisted operaci s anchored contractem.

## D6 — Úplnost je dokazovaná, ne odhadovaná

**Rozhodnutí:** `partial=false` vyžaduje úplnost seznamu, kompletní historii každé
konverzace a nulové relevantní parser misses. Samotná stagnace scrollu nestačí.

**Proč:** Tichý neúplný export je horší než explicitní `.partial`.

**Důsledek:** Účet s méně konverzacemi než požadovaný limit nebo fresh běh bez older
template může zůstat partial, i když získaná data vypadají rozumně.

## D7 — Neúplný kandidát nikdy nepřepíše úplný export

**Rozhodnutí:** Úplné výsledky se zapisují do `messages.json`, neúplné do sousedního
`messages.json.partial`. Existující soubor se před merge runtime validuje a zápis je
atomický.

**Proč:** Chrání poslední známý dobrý výsledek proti parser regresi, změně LinkedIn i
přerušenému zápisu.

## D8 — Idempotentní merge a přísný snapshot recovery

**Rozhodnutí:** Stabilní ID/URN mají přednost; fallback ID jsou deterministická.
Předchozí kompletní history snapshot lze znovu použít jen pro stejné conversation ID,
bez parser missů a se sdíleným stabilním message ID/URN.

**Proč:** Samotná shoda threadu nebo textového fingerprintu nedokazuje, že mezi starým
a novým oknem nechybí zprávy.

## D9 — Diagnostika je strukturální a redigovaná

**Rozhodnutí:** Výchozí diagnostika ukládá názvy/shape/counts, ne hodnoty, bodies,
cookies nebo zprávy. Screenshot/sanitizované HTML vyžaduje explicitní přepínač.

**Proč:** Debuggability nesmí způsobit únik credentials nebo soukromé komunikace.

## D10 — Historie dokumentace zůstává dostupná, ale není aktivní

**Rozhodnutí:** Původní plán, review, code-review log a průběžné checkpointy jsou v
`docs/history/` s výrazným archivním upozorněním. Aktivní dokumenty jsou krátké a
odkazují na archiv jen pro vysvětlení vývoje.

**Proč:** Historické omyly a slepé cesty jsou užitečné při regresi, ale v aktivním
handoveru mátly nové agenty starými `Next:` kroky a překonanými `NO-GO` verdikty.

## D11 — Hvězdička je volitelný stav konverzace z trusted list response

**Rozhodnutí:** Export ukládá optional `Conversation.isStarred`. Hodnota vzniká jen z
`categories[]` přímého elementu důvěryhodné pozorované Dash conversation-list GET
odpovědi. Exact case-normalized token `STARRED` znamená `true`, validní pole bez něj
`false`; chybějící nebo malformed pole znamená neznámý stav.

**Proč:** LinkedIn hvězdičku modeluje na konverzaci, nikoli na jednotlivé zprávě.
Recursive hledání `STARRED` by mohlo zaměnit tracking, message metadata nebo budoucí
nesouvisející objekt za stav konverzace. CSS/DOM indikace není autoritativní.

**Merge a kompatibilita:** Nová explicitní hodnota přepisuje starou, `undefined`
zachová poslední explicitní stav. Flag není součást identity. Zůstává optional v
`schemaVersion: 1`, takže existující exporty bez pole jsou validní. Pokud během
jednoho běhu přijde pro stejnou identitu více explicitních hodnot, vyhraje poslední
pozorovaná: může jít o legitimní změnu stavu mimo nástroj a pořadí capture je jediná
dostupná časová evidence. Malformed nebo nedůvěryhodný údaj naproti tomu stav vůbec
nepřepisuje.

**Bezpečnost:** Implementace žádnou hvězdičku nemění. Star/unstar/toggle-star
operation-like GET se nově explicitně blokují, zatímco list query nebo kategorie
`STARRED` zůstává povoleným čtecím údajem.

## D12 — Date-range JSON je odvozený artefakt, nikoli skrytá CLI funkce

**Rozhodnutí:** Současné CLI zůstává limit-based a nemá `--since`. Lokální soubory s
`exportType: "linkedin-message-date-range"` z běhů 2026-09-24/25 jsou explicitně
označený postprocessing pomocí `jq`, ne nativní `ExportSchema` výstup.

**Proč:** Zpětně vydávat jednorázovou transformaci za implementovanou funkci by mátlo
uživatele i další agenty. Strict schema navíc jiný top-level kontrakt právem odmítne.

**Důsledek:** Tyto soubory se nesmějí použít jako vstup `export-store.ts` a jejich
`range.complete` má užší, v `docs/OPERATIONS.md` popsaný význam. Opakovaně podporovaný
date-range workflow vyžaduje samostatnou implementaci, testy a verzované schema.

## D13 — Probe nikdy nemá přímý browserový síťový fallback (BL-007)

Provozní follow-up 2026-09-26 přidává pouze uzavřené asset failure důvody do
redigované diagnostiky. První BL-006 live pokus bezpečně skončil před targetem;
samotný důvod asset-broker neprokazuje login ani transport escape. Konkrétní
status/timeout/type evidence musí předcházet případné opravě, policy se neuvolňuje.

**Rozhodnutí:** Probe má od vytvoření contextu neforwardující loopback proxy.
Povolené resources se načítají izolovanými GET/HEAD brokery bez redirectů. Selection
generation se revokuje před drainem a zavřením; worker bez owning frame nemá broker
oprávnění. Proxy zůstává až do context.close a každý její hit vyvolá hard state.

**Důkaz příčiny:** Instalované Playwright `coreBundle.js` obsahuje cestu, která při
chybějícím frame volá `Fetch.continueRequest` před vytvořením aplikační Route; při
page closing se také přeskakují route handlery. Request naplánovaný selection
rendererem tedy může po zániku frame obejít JavaScript guard. Přesné CDP časování
původního incidentu nebylo zachyceno; nebylo by správné je vydávat za změřené.
Deterministický test místo toho úmyslně volá route.continue a ověřuje nulový hit
skutečného serveru pro HTTP loopback i HTTPS CONNECT a auditovatelný hard state.

**Důsledek:** Samotné CDP freeze/Network.setBlockedURLs není autoritativní bariéra.
Nepodporovaný asset či nová LinkedIn závislost může omezit funkčnost, ale nesmí
způsobit rozšíření API policy nebo přímý fallback. CLI a data schema se nemění.

## D14 — Subject není message body a metadata nejsou příloha (BL-006)

**Rozhodnutí:** Nahradit obecný textový fallback explicitními body hranami
`body` → `messageBody` → `attributedBody` → `eventContent` → `content` → `commentary`
→ `text`, s omezením hloubky a visited setem. Subject se neukládá a schema v1 zůstává.
Obecné renderer metadata nejsou důkaz attachment-only zprávy; podporované přílohy
musí být uvnitř explicitní attachments nebo známého media discriminantu.

**Proč:** Předchozí parser kontaminoval zprávy InMail subjectem ještě před merge.
Úspěšné schema/ID kontroly chybu neodhalí. Přesné texty, časy, směry a přílohy nově
ověřuje anonymní quality gate až přes persistence. Miss jakéhokoli relevantního
kandidáta musí zneplatnit úplnost včetně generic nested/id-less cesty.

**Důkazní hranice:** Implementace a syntetické testy neopravují staré JSONy. BL-006
se uzavře až po nezávislém review, plné validaci a nezávislém živém obsahovém důkazu.
