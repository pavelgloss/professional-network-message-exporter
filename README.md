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

Tento výchozí příkaz neotevře žádné vlákno a při chybějící historii bezpečně
vytvoří jen `.partial` kandidát. Pro úplný export je nutný samostatný vědomý opt-in,
který otevře nejvýše jedno serverem potvrzené již přečtené vlákno, zachytí jeho
read-only GET šablonu a stejným během načte historie:

```powershell
npm.cmd run export -- --limit 100 --with-history-probe
```

Každý export vytvoří fresh ephemeral Chromium context, načte pouze storage state,
zakáže service workery a nainstaluje HTTP/WebSocket guardy před vytvořením stránky.

Úplný výsledek je v `data/linkedin/messages.json`; reálný export, session i diagnostika
jsou v `.gitignore`. Neúplný běh vrátí nenulový exit code `5`, uloží bezpečný kandidát
do `data/linkedin/messages.json.partial` a poslední úplný export nezmění. Opakovaný
běh sloučí data podle LinkedIn ID nebo deterministického fallback ID a zachová dříve
načtenou historii.

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
Při vlastním `--output` zajistěte, aby cílový JSON, jeho `.partial` kandidát i sousední
`diagnostics/` byly ignorované vaším Gitem.
LinkedIn může měnit neveřejné endpointy/DOM. Striktní blokace POST může zablokovat i
read-only GraphQL POST, protože jej bez stabilního veřejného kontraktu nelze bezpečně
odlišit od mutace; v takovém případě export raději skončí neúplný.

Kontrola projektu:

```powershell
npm.cmd run check
```
