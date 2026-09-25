# FAQ — Message Exporter for LinkedIn®

Stručné odpovědi k aktuálnímu stavu projektu k **2026-09-25**. Implementované chování
je níže důsledně oddělené od změn, které jsou zatím pouze v [`BACKLOG.md`](BACKLOG.md).

## 1. Co přesně znamená `isStarred`?

`isStarred` je volitelný boolean celé **konverzace**, nikoli jednotlivé zprávy:
`true` znamená oblíbenou konverzaci označenou hvězdičkou, `false` prokazatelně
neoznačenou a chybějící pole znamená, že stav nebylo možné bezpečně určit.

## 2. Jak exporter hvězdičku pozná?

Čte přesný token `STARRED` z `categories[]` na důvěryhodném conversation-list objektu
vráceném aktuálním LinkedIn GETem; stav neodhaduje z CSS, textu ani ikony v DOM.

## 3. Může exporter hvězdičku přidat, odebrat nebo jinak změnit?

Ne, pouze ji čte; star/unstar/toggle-star operace jsou explicitně blokované stejně
jako ostatní mutační requesty.

## 4. Co se stane s `isStarred` při současném merge?

Nová explicitní hodnota `true` i `false` přepíše starou, zatímco chybějící hodnota
zachová poslední známý explicitní stav; hvězdička není součástí identity konverzace.

## 5. Bylo `isStarred` skutečně ověřeno v browseru?

Ano, dva izolované běhy nad 100 konverzacemi shodně získaly 8 `true`, 92 `false` a
0 neznámých či nevalidních hodnot; ověřuje to conversation metadata, nikoli správnost
textů zpráv.

## 6. Je dnes export zpráv jako celek důvěryhodný?

Ne: kritický BL-006 ukázal, že parser může u InMail eventů uložit společný `subject`
místo skutečného textu zprávy; v jednom exportu je takto podezřelých nejméně 107 z
253 zpráv, proto se po opravě musí vytvořit nový nezávislý export.

## 7. Jak export technicky získává konverzace a celé historie?

Spustí vlastní izolovaný Playwright Chromium, zachytí JSON z LinkedIn GET odpovědí a
při `--with-history-probe` otevře jeden potvrzeně přečtený thread, odpozoruje aktuální
history GET kontrakt a ostatní historie stránkuje přímými autentizovanými GETy. Tento
probe se teď nemá živě spouštět, dokud BL-007 neuzavře intermittent teardown race.

## 8. Používá exporter můj běžný Chrome nebo jeho přihlášení?

Ne, používá samostatnou Playwright session z `.auth/linkedin-storage-state.json`;
běžný Chrome nemusí běžet a jeho taby ani profil se nepoužívají, ale uložená session
může expirovat a potom je nutné zopakovat `npm.cmd run login`.

## 9. Je každý běžný export nový nezávislý snapshot?

Zatím ne: opakování do stejného `--output` implicitně merguje starší JSON a může
použít dříve prokázanou historii; kritický BL-003 požaduje nový izolovaný bundle při
každém běhu a merge pouze jako explicitní režim.

## 10. Jsou ID stabilní a ukládá se celý thread s timestampy?

LinkedIn message/conversation/participant ID a URN jsou preferované stabilní identity,
zatímco fallback hashe se mohou při doplnění lepších dat změnit; zamýšlený výstup
obsahuje celý thread, sendery, směry a `sentAt`, ale úplnost i text musí projít opravou
a novou validací BL-006.

## 11. Je vyřešený lazy loading a lze exportovat 200 konverzací?

Historie umíme stránkovat přímými GETy, ale virtualizovaný seznam může skončit
stagnací nebo `.partial`; CLI `--limit 200` podporuje, živě však bylo kompletně
ověřeno pouze 100 konverzací.

## 12. Jaké důležité části dat zatím chybějí?

BL-001 řeší skutečná jména místo `Unknown participant`, BL-002 lokální stažení příloh
(dnes se ukládají jen metadata a URL) a BL-004 pouze zkoumá možnost archivovaných
konverzací, které dnes cíleně podporované nejsou.

## 13. Který JSON je výsledek a co jsou staré date-range soubory?

Výchozí hlavní soubor je `data/linkedin/messages.json`, neúplný kandidát má příponu
`.partial`; oba soubory `messages-since-2026-05-01*.json` vznikly ad-hoc filtrací a
incremental mergem, nejsou nativní `--since` export a kvůli BL-006 jsou obsahově vadné.

## 14. Může LinkedIn poznat automatizaci a proč blokujeme tolik requestů?

Ano, automatizaci může poznat ze vzoru GETů či browseru; blokace POSTů, WebSocketů,
service workerů a nejasných endpointů neslouží ke skrytí, ale k fail-closed ochraně
účtu před vedlejšími změnami, i za cenu neúplného exportu.

## 15. Co má nový agent udělat jako první a kde získá kontext?

Má začít v `HANDOVER.md` a `BACKLOG_PROGRESS.md`, poté přečíst backlog, README, toto
FAQ a architekturu a pokračovat první nesplněnou checkpoint akcí; výchozí pořadí je
BL-007, BL-006, BL-003, BL-005, BL-001, BL-002 a research-only BL-004.
