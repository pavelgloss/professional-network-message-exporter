# LinkedIn messages reader

Lokální read-only export LinkedIn zpráv do validovaného JSON. Nástroj nic neodesílá,
nemaže, nearchivuje ani nemění profil. V exportním režimu blokuje všechny HTTP metody
kromě `GET`, `HEAD` a `OPTIONS`; service workery jsou vypnuté. Používání automatizace
se řídí podmínkami LinkedIn a odpovědností vlastníka účtu.

## Instalace

Vyžaduje Node.js 22+:

```powershell
npm install
npx playwright install chromium
```

## Jednorázové přihlášení

```powershell
npm run login
```

Dokončete login, MFA nebo CAPTCHA ručně pouze v otevřeném Chromium. Aplikace heslo
nečte. Session se uloží do ignorované složky `.auth/linkedin-chromium/`.

## Export

Bezpečný network-first režim:

```powershell
npm run export -- --limit 100
```

Výsledek je v `data/linkedin/messages.json`; reálný export, session i diagnostika
jsou v `.gitignore`. Opakovaný běh sloučí data podle LinkedIn ID nebo deterministického
fallback ID a zachová dříve načtenou historii.

LinkedIn často načte celou historii až po otevření konkrétního vlákna. Výchozí běh
vlákna neotevírá a může být označen `partial`. Po vědomém přijetí rizika, že samotné
zobrazení threadu může změnit serverový stav read/unread, použijte:

```powershell
npm run export -- --limit 100 --allow-thread-open
```

Tento opt-in nepovoluje odesílání ani jiné mutace; request guard zůstává aktivní.
LinkedIn může měnit neveřejné endpointy/DOM. Striktní blokace POST může zablokovat i
read-only GraphQL POST, protože jej bez stabilního veřejného kontraktu nelze bezpečně
odlišit od mutace; v takovém případě export raději skončí neúplný.

Kontrola projektu:

```powershell
npm run check
```

