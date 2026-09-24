# ARCHIV: původní review zadání

> **Historický předimplementační dokument.** Zachovává interpretaci původního zadání,
> ale jeho technický návrh není aktuální — zejména zmínka o persistentním Chromium
> profilu. Pro současný stav čtěte [`../../REVIEW.md`](../../REVIEW.md), pro výslednou
> architekturu [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

# Původní obsah: Review zadání

## Interpretace cíle

Projekt bude lokální Node.js/TypeScript CLI nad Playwrightem. Z autentizované LinkedIn
session načte nejnovější konverzace, jejich dostupnou historii a sloučí je do
`data/linkedin/messages.json`. Primárním limitem bude 100 konverzací; export vždy
zahrne všechny zprávy, které se pro vybrané konverzace podaří načíst.

## Bezpečnostní hranice

- Nástroj je striktně read-only: neodesílá zprávy, nemaže obsah a nemění profil ani
  nastavení účtu.
- Automatizace smí provádět jen navigaci, otevření konverzace, scrollování a čtení.
  Nesmí klikat na odeslání, reakce, archivaci, označení, mazání ani jiné mutační akce.
- Nepoužije přímé zápisové interní API. Zachycené síťové odpovědi lze pouze číst.
- Session, cookies, browser profil, diagnostické snímky a reálný export zůstanou mimo
  Git. Logy nesmí obsahovat celé cookies ani jiné credentials.
- Samotné otevření konverzace může na LinkedIn změnit serverový stav `read/unread`.
  Proto implementace nebude otevírat vlákna klikáním, pokud lze data získat z
  read-only odpovědí webové aplikace. Pokud je otevření nutné, README toto omezení
  výslovně uvede; žádná bezpečná browser automatizace nemůže garantovat, že LinkedIn
  při GET/navigaci stav přečtení nezmění.

## Technické rozhodnutí

Nejspolehlivější cesta je hybridní:

1. persistentní Chromium profil pro jednorázové ruční přihlášení,
2. načtení Messaging stránky v Playwrightu,
3. zachycení autentizovaných read-only network odpovědí a jejich tolerantní parsování,
4. DOM fallback opřený o více accessibility/stabilních atributů místo jediného CSS
   selektoru,
5. normalizace, deterministická náhradní ID a idempotentní merge do JSON.

Interní LinkedIn API není veřejný kontrakt, proto parser i DOM fallback musí selhat
srozumitelně, ukládat bezpečnou diagnostiku a mít izolované selektory/adaptéry.

## Upřesněná akceptační kritéria

- Standardní běh nesmí obsahovat žádnou zápisovou operaci vůči LinkedIn.
- Export je validní a deterministicky seřazený; opakované spuštění neduplikuje
  konverzace ani zprávy.
- Každá zpráva má stabilní nebo deterministické ID, conversation ID, text, směr,
  odesílatele, čas (pokud jej LinkedIn zpřístupní) a pořadí.
- Externí účastníci mají konzervativní boolean `probablyRecruiter`.
- Projekt má unit/integration testy pro normalizaci, klasifikaci a idempotentní merge.
- End-to-end test bez reálné session může ověřit start aplikace a bezpečné zastavení;
  skutečný obsah inboxu lze potvrdit až v přihlášené session uživatele.

## Rizika a realistická omezení

- LinkedIn DOM a neveřejné endpointy se mohou změnit a vyžádat aktualizaci adaptéru.
- CAPTCHA, MFA nebo chybějící session jsou legitimní blokace vyžadující ruční krok.
- LinkedIn může automatizaci omezovat; běh proto musí být pomalý, bez obcházení
  bezpečnostních mechanismů a bez vysoké paralelizace.
- Některá metadata nebo celá starší historie nemusí být webovým klientem dostupná.
- Použití automatizace se řídí podmínkami LinkedIn a odpovědností vlastníka účtu.

## Nejasnost vyřešená pro implementaci

Formulaci „100 nejnovějších conversations/messages“ vykládám jako až 100 nejnovějších
konverzací a všechny dostupné zprávy uvnitř nich. Když účet obsahuje méně konverzací,
exportuje se vše dostupné a výsledek obsahuje skutečný počet i případná varování.
