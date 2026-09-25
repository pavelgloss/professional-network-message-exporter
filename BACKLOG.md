# Backlog

Tento soubor obsahuje požadované budoucí změny, které nejsou součástí aktuálního
hotového baseline. Položka se smí označit jako dokončená až po implementaci, testech,
review a odpovídající aktualizaci dokumentace.

## BL-001 — Doplnit skutečná jména místo `Unknown participant`

- **Stav:** TODO
- **Priorita:** vysoká
- **Požadavek uživatele:** Ve zprávách a účastnících exportu získat zobrazované jméno,
  které je vidět v LinkedIn Messages, místo současného `Unknown participant`.

### Kontext

Historie zpráv často obsahuje stabilní sender/participant ID, ale ne display name ve
stejném objektu. LinkedIn UI jméno zná z conversation-list, profile nebo included
entity dat. Současný enrichment je doplní jen při bezpečné jednoznačné shodě; při
nejistotě správně ponechá `Unknown participant`. Živý běh 2026-09-25 zaznamenal
`DOM_PREVIEW_NAME_AMBIGUOUS`. Neznámé jméno se může objevit i u vlastní odchozí
zprávy, přestože identita účtu je známá.

### Požadované řešení

1. Zmapovat všechny důvěryhodné zdroje jména v aktuálních list/history/profile
   network odpovědích a propojit je přes stabilní person/profile ID nebo URN.
2. Propagovat ověřené jméno do `Participant.name` a `Message.senderName` ve všech
   zprávách stejné identity.
3. Pro vlastní sender ID vždy použít ověřené jméno exportovaného účtu.
4. DOM enrichment ponechat pouze jako bezpečný fallback s jednoznačnou vazbou na
   conversation ID; jméno nikdy nehádat z podpisu, textu zprávy nebo pořadí řádků.
5. Při konfliktu zdrojů zachovat fail-closed `Unknown participant` a uložit pouze
   redigovaný diagnostický důvod.

### Akceptační kritéria

- Jméno viditelné v LinkedIn Messages a dostupné v zachycených důvěryhodných datech
  se objeví u odpovídajícího participant ID i všech jeho zpráv.
- Vlastní odchozí zprávy nepoužívají `Unknown participant`, pokud je účet bezpečně
  identifikovaný.
- Stejné jméno se nesmí přiřadit jiné osobě pouze podle textu, preview nebo podpisu.
- Group konverzace, stejné preview texty, chybějící profilová entita a konfliktní
  evidence mají samostatné testy.
- Parser, normalizace a merge mají unit testy; integrační fixture ověří oddělenou
  profile entity a propagaci jména do historie.
- Read-only politika se nemění: žádné nové POSTy, WebSockety, service workery ani
  otevírání dalších threadů.
- Živá validace se provede jen s explicitním souhlasem uživatele a porovná anonymní
  počty `Unknown participant` před/po bez logování jmen nebo textů zpráv.
- `npm.cmd run check`, nezávislé code review a relevantní dokumentace projdou před
  uzavřením položky.

### Pravděpodobně dotčené oblasti

- `src/linkedin/network/response-parser.ts`
- `src/linkedin/exporter.ts`
- `src/linkedin/dom/conversation-list.ts`
- `src/domain/normalize.ts`
- anonymní parser/domain/integration fixtures v `tests/`
