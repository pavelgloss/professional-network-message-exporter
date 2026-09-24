# Aktuální stav code review

Předchozí baseline: **GO — Critical 0 / High 0 / Medium 0**

Aktuální změna `isStarred`: **GO — Critical 0 / High 0 / Medium 0**

Reviewovaný code baseline: **`b611a61` (2026-09-07)**

Stav znovu ověřen: **2026-09-24**

Od `b611a61` do tohoto dokumentačního review nedošlo ke změně implementace. Následné
commity upravovaly pouze `README.md`, handover a review dokumentaci. Proto finální
bezpečnostní re-review tohoto code baseline zůstává platné.

## Co finální review uzavřelo

- Export používá fresh context ze storage state; nepřenáší persistentní service
  worker a nesahá na běžný Chrome.
- POST, WebSocket a service worker cesty jsou zablokované a testované.
- One-thread probe vybírá target pouze z aktuální network evidence `read=true`,
  kontroluje konflikt `read=false` a připustí jedinou target navigaci.
- Probe selection a target fáze jsou izolované proti redirectům, popupům, History API,
  location změnám, cizím thread referencím a race podmínkám.
- History GET je omezený na přesný target/kontrakt; pagination selhává uzavřeně.
- Snapshot recovery vyžaduje stejnou konverzaci a stabilní překryv message ID/URN.
- Strukturální diagnostika neukládá citlivé hodnoty ani numeric/boolean hodnoty
  kontraktu, ze kterých by šel rekonstruovat obsah.
- Parser miss, neúplná historie nebo nedokázaná list coverage nemohou vytvořit tichý
  úplný export.

## Současná automatická evidence

`npm.cmd run check` dne 2026-09-24 po změně `isStarred` prošel:

- TypeScript typecheck;
- 16 testovacích souborů;
- 157/157 unit a integration testů;
- build.

`npm.cmd audit --omit=dev` hlásí 0 vulnerabilities. Plný audit nově hlásí 2 moderate
zranitelnosti ve vývojové závislosti `vitest`/`@vitest/mocker`; nejde o změnu
aplikačního code-review verdiktu, ale je evidována jako volitelný maintenance úkol v
`PLAN.md`.

### Rozšíření `isStarred` (2026-09-24)

- Optional boolean je na `Conversation`, nikoli na `Message`; schemaVersion zůstává 1
  a staré exporty bez pole jsou validní.
- Parser přijímá exact case-normalized `STARRED` jen z `categories[]` přímého
  trusted conversation-list objektu. Missing/malformed/untrusted/message objekty
  hodnotu nevytvářejí.
- Raw i persistent merge používá čerstvé explicitní `true`/`false`; `undefined`
  zachovává starší explicitní stav. Hodnota se nepodílí na identitě.
- Sdílený mutation-like guard blokuje star/unstar/toggle-star GET operace, ale
  povoluje conversation-list query s read kategorií `STARRED`.
- První nezávislé review našlo High mezeru ve star-action GET guardu a Medium ztrátu
  trusted evidence na explicitně následované pagination stránce. Obojí bylo opraveno
  s regresními testy; následné nezávislé re-review dalo technické GO bez nálezů.
- Cílené testy parseru, pagination, domain merge a obou guard vrstev prošly; celý
  suite má 157/157 testů, typecheck i build jsou zelené.
- Dva izolované read-only live běhy daly shodně 8 starred a 92 unstarred konverzací,
  žádné unknown/invalid hodnoty, duplicitní ID ani parser miss. Výstupy zůstaly
  `.partial` jen kvůli neprokázané úplnosti historie zpráv; hlavní export se nezměnil.

## Reziduální rizika mimo verdikt

- LinkedIn endpointy a DOM nejsou veřejný stabilní kontrakt.
- Otevření i read threadu může mít server-side read-state efekt; proto je opt-in.
- Live scale 200 nebyla ověřena.
- Automated suite nemůže dokázat budoucí chování LinkedIn serveru; implementace proto
  při nejasnosti selhává uzavřeně.

## Úplná historická stopa

Všechny původní nálezy, dočasné `NO-GO` verdikty, opravy a re-review jsou zachované v
`docs/history/CODE_REVIEW_LOG.md`. Tento archiv čtěte při hledání původu konkrétního
guardu nebo regresního testu. Jeho starší verdikty nejsou současný stav projektu.
