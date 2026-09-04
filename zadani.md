Jsi seniorní software engineer / coding agent. Tvým úkolem je vytvořit **funkční Node.js řešení**, které z mého LinkedIn účtu získá moje nejnovější LinkedIn zprávy a uloží je lokálně jako strukturovaná JSON data.

## Cíl

Chci spustit aplikaci/script a získat přibližně **100 nejnovějších LinkedIn conversations/messages**.

Chci **všechny zprávy**, nikoliv pouze zprávy od recruiterů.

Výsledkem musí být **reálně fungující implementace**, ne návrh architektury, proof-of-concept nebo teoretický rozbor.

## Důležité zjištění o LinkedIn API

Pro běžnou vlastní aplikaci není veřejné LinkedIn API, které by umožňovalo načíst osobní LinkedIn Messaging inbox / DM historii.

Messaging API je dostupné pouze v omezených LinkedIn partner programech a specifických schválených use-casech.

Proto:

* neztrácej čas pokusy získat běžný public LinkedIn Messaging API access,
* jako primární řešení očekávám browser automation přes autentizovanou LinkedIn session,
* pravděpodobně použij Playwright,
* pokud při browser automation zjistíš, že LinkedIn Messaging používá interní API/network endpointy, které lze spolehlivě volat z autentizované session, můžeš je využít.

Preferuj nejspolehlivější praktické řešení.

## Jak máš postupovat

Sám zvol nejpraktičtější způsob implementace.

Můžeš použít například:

* Playwright nad přihlášeným LinkedIn účtem,
* persistent browser profile,
* cookies/session storage,
* network requesty prováděné LinkedIn web aplikací,
* kombinaci browser automation + interních API requestů.

Nedělej dlouhou analýzu alternativ.

Prozkoumej je pouze tolik, kolik potřebuješ k rozhodnutí, potom řešení implementuj a spusť.

## Interakce se mnou

Pracuj maximálně autonomně.

Nežádej mě o rozhodování o technických detailech.

Doptání se mě je **poslední možnost**.

Ptej se pouze tehdy, pokud bez mého vstupu objektivně nemůžeš pokračovat, například:

* potřebuji, abys provedl LinkedIn login,
* LinkedIn vyžaduje MFA,
* LinkedIn zobrazil CAPTCHA,
* potřebuji získat konkrétní cookie nebo session,
* potřebuješ credential, který nemůžeš získat jinak.

Pokud ode mě něco potřebuješ, dej mi **jednu konkrétní instrukci**, co přesně mám udělat.

Například:

> Otevři Chrome → LinkedIn → DevTools → Application → Cookies → linkedin.com → zkopíruj hodnotu cookie `li_at` a vlož ji sem.

Neptej se mě obecně na preference typu:

> Jaký způsob autentizace preferujete?

Rozhodni to sám.

## Funkční požadavky

Aplikace musí:

1. autentizovat se k mému LinkedIn účtu,
2. otevřít LinkedIn Messaging,
3. projít nejnovější conversations,
4. načíst přibližně **100 nejnovějších conversations nebo odpovídající množství zpráv**,
5. načíst všechny dostupné messages uvnitř těchto conversations,
6. uložit je jako strukturovaný JSON,
7. zachovat identifikátory potřebné pro pozdější práci s danou conversation,
8. označit, zda je odesílatel pravděpodobně recruiter.

## Data

Pro každou conversation chci pokud možno:

* LinkedIn conversation ID,
* URL conversation, pokud existuje,
* participants,
* jméno každého participant,
* LinkedIn profile URL,
* headline / position, pokud je dostupná,
* timestamp poslední aktivity,
* seznam jednotlivých messages.

Pro každou message chci minimálně:

* message ID, pokud existuje,
* conversation ID,
* sender,
* sender profile URL,
* timestamp,
* text,
* direction:

  * `inbound`
  * `outbound`
* pořadí message v conversation.

Pokud LinkedIn poskytuje další užitečná metadata, zachovej je.

Důležité je zejména zachovat stabilní LinkedIn identifikátory, protože tato data bude později používat **jiný AI agent, který může analyzovat conversations a případně na zprávy odpovídat**.

## Probably recruiter flag

U každého externího participant / sender vytvoř:

```json
{
  "probablyRecruiter": true
}
```

nebo:

```json
{
  "probablyRecruiter": false
}
```

Toto je pouze heuristická klasifikace.

Použij dostupné informace:

* headline,
* job title,
* company,
* profile informace,
* text zpráv.

Indikátory mohou být například:

* recruiter,
* recruitment,
* talent acquisition,
* talent partner,
* headhunter,
* hiring,
* staffing,
* sourcing,
* HR,
* people partner,

nebo obsah zpráv nabízející:

* job opportunity,
* role,
* position,
* interview,
* career opportunity,
* contract,
* freelance opportunity,
* leadership role,
* salary / compensation diskusi.

Pokud si nejsi jistý, raději nastav `probablyRecruiter: false`.

Nevynechávej ale žádné conversations podle této klasifikace.

**Exportují se všechny zprávy.**

## Output

Data ukládej například do:

```text
./data/linkedin/
```

Preferovaný hlavní soubor:

```text
./data/linkedin/messages.json
```

Navrhni rozumnou JSON strukturu například:

```json
{
  "exportedAt": "2026-09-04T14:00:00Z",
  "account": {
    "name": "..."
  },
  "conversations": [
    {
      "id": "...",
      "url": "...",
      "lastActivityAt": "...",
      "participants": [
        {
          "id": "...",
          "name": "Jane Doe",
          "profileUrl": "https://www.linkedin.com/in/...",
          "headline": "Senior Technical Recruiter",
          "probablyRecruiter": true
        }
      ],
      "messages": [
        {
          "id": "...",
          "senderId": "...",
          "senderName": "Jane Doe",
          "sentAt": "2026-08-14T10:32:00Z",
          "direction": "inbound",
          "text": "Hi, I came across your profile..."
        }
      ]
    }
  ]
}
```

Toto je pouze příklad.

Pokud navrhneš lepší datový model pro následné zpracování jiným agentem, použij ho.

Výstup musí být:

* validní JSON,
* deterministic,
* dobře parsovatelný programově,
* bez zbytečných prezentačních dat.

## Opakované spuštění

Řešení musí být možné spouštět opakovaně.

Při dalším spuštění:

* nevytvářej duplicitní messages,
* zachovej stabilní IDs,
* aktualizuj existující conversations,
* přidej nové messages,
* aktualizuj metadata participantů, pokud se změnila.

Použij LinkedIn conversation/message identifier, pokud existuje.

Pokud stabilní ID není dostupné, vytvoř deterministic vlastní ID.

## Budoucí odpovídání na messages

Tento úkol zatím **nemusí implementovat automatické odpovídání**.

Datový model a implementace ale mají zachovat vše potřebné, aby další agent mohl později:

1. najít konkrétní conversation,
2. přečíst celý její kontext,
3. identifikovat poslední inbound message,
4. otevřít stejnou LinkedIn conversation,
5. případně do ní napsat odpověď.

Proto nezahoď LinkedIn IDs, URLs nebo jiné identifikátory, které mohou být pro tento krok užitečné.

## Bezpečnost credentials

Credentials/cookies:

* nedávej do source code,
* ukládej přes `.env`, persistent browser profile nebo lokální session file,
* přidej je do `.gitignore`,
* nikdy je nevypisuj celé do logu,
* neukládej credentials do exportovaného JSON.

Pokud lze použít persistent browser session, preferuj ji před ručním kopírováním cookies při každém spuštění.

## Technologie

Použij Node.js.

Preferuji:

* TypeScript,
* npm,
* Playwright.

Ale zvol technologii podle toho, co skutečně funguje.

## Robustnost

Počítej s tím, že:

* Messaging používá lazy loading / infinite scroll,
* conversations se mohou načítat dynamicky,
* jednotlivé thready mohou lazy-loadovat starší messages,
* některé messages mohou být InMail,
* DOM LinkedInu se může měnit,
* LinkedIn může používat GraphQL nebo jiné interní API requesty.

Nevytvářej řešení závislé pouze na jednom fragilním CSS selectoru, pokud existuje robustnější možnost.

Preferuj podle situace:

* network/API responses autentizované LinkedIn aplikace,
* accessibility selectors,
* role/text selectors,
* stabilní identifikátory v DOM nebo network datech.

## Debugging

Pokud první implementace nefunguje:

1. spusť ji,
2. zjisti konkrétní problém,
3. oprav ho,
4. spusť ji znovu.

Pokračuj, dokud nebude fungovat end-to-end nebo dokud nenarazíš na blokaci, kterou skutečně musím vyřešit já.

V případě problémů můžeš ukládat:

* screenshoty,
* relevantní HTML,
* network metadata,
* debugging logy.

Neukládej credentials ani session secrets do debug výstupů.

## Deliverables

Na konci očekávám minimálně:

```text
package.json
tsconfig.json
src/
  ...
data/
  linkedin/
    messages.json
.env.example
.gitignore
README.md
```

README má obsahovat pouze praktické informace:

* instalace,
* případný jednorázový login/setup,
* příkaz pro spuštění,
* kde jsou výsledná data.

## Definition of Done

Úkol není hotový tím, že napíšeš kód.

Úkol je hotový, když:

* dependencies jsou nainstalované,
* aplikaci lze spustit,
* autentizace funguje,
* LinkedIn Messaging je skutečně načten,
* je načteno přibližně 100 nejnovějších conversations/messages podle dostupnosti,
* jsou exportovány všechny messages z těchto conversations,
* JSON obsahuje skutečný text messages,
* obsahuje sender + timestamp + direction,
* participants mají `probablyRecruiter`,
* další spuštění nevytváří duplicity,
* data jsou použitelná jiným programem / AI agentem.

Neukončuj práci pouze větou typu:

> Zde je implementace, kterou si můžete vyzkoušet.

Pokud máš možnost aplikaci spustit a ověřit, **udělej to sám**.

Pokud narazíš na jedinou věc, kterou musím udělat já, zastav se pouze na ní a dej mi přesnou instrukci.

Po mém vstupu pokračuj v implementaci.
