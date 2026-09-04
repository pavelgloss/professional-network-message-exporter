# LinkedIn messages reader

Lokální read-only export LinkedIn zpráv do validovaného JSON. Nástroj nic neodesílá,
nemaže, nearchivuje ani nemění profil. V exportním režimu blokuje všechny HTTP metody
kromě `GET`, `HEAD` a `OPTIONS`, veškeré WebSockety; service workery jsou vypnuté. Používání automatizace
se řídí podmínkami LinkedIn a odpovědností vlastníka účtu.

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
nepoužívá.

## Export

Bezpečný network-first režim:

```powershell
npm.cmd run export -- --limit 100
```

Každý export vytvoří fresh ephemeral Chromium context, načte pouze storage state,
zakáže service workery a nainstaluje HTTP/WebSocket guardy před vytvořením stránky.

Úplný výsledek je v `data/linkedin/messages.json`; reálný export, session i diagnostika
jsou v `.gitignore`. Neúplný běh vrátí nenulový exit code `5`, uloží bezpečný kandidát
do `data/linkedin/messages.json.partial` a poslední úplný export nezmění. Opakovaný
běh sloučí data podle LinkedIn ID nebo deterministického fallback ID a zachová dříve
načtenou historii.

LinkedIn často načte celou historii až po otevření konkrétního vlákna. Výchozí běh
vlákna neotevírá a může být označen `partial`. Po vědomém přijetí rizika, že samotné
zobrazení threadu může změnit serverový stav read/unread, použijte:

```powershell
npm.cmd run export:threads
```

Tento opt-in nepovoluje odesílání ani jiné mutace; request guard zůstává aktivní.
Limit lze změnit proměnnou `LINKEDIN_LIMIT` v lokálním `.env`.
Při vlastním `--output` zajistěte, aby cílový JSON, jeho `.partial` kandidát i sousední
`diagnostics/` byly ignorované vaším Gitem.
LinkedIn může měnit neveřejné endpointy/DOM. Striktní blokace POST může zablokovat i
read-only GraphQL POST, protože jej bez stabilního veřejného kontraktu nelze bezpečně
odlišit od mutace; v takovém případě export raději skončí neúplný.

Kontrola projektu:

```powershell
npm.cmd run check
```
