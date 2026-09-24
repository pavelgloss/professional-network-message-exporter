# Pokyny pro AI agenty

Než začnete pracovat, přečtěte v tomto pořadí:

1. `HANDOVER.md` — současný stav a otevřené položky;
2. `docs/README.md` — autorita a rozcestník dokumentace;
3. `docs/ARCHITECTURE.md` — skutečná implementovaná architektura;
4. `docs/DECISIONS.md` — důvody současných řešení;
5. relevantní modul a jeho testy podle mapy v architektuře.

Soubory v `docs/history/` jsou historické. Obsahují staré `NO-GO`, `Next:` kroky,
původní persistentní profil a `--allow-thread-open`; nic z toho není současná
instrukce. Použijte je pouze při pátrání po vývoji rozhodnutí nebo slepé cestě.

Nepřekročitelné hranice:

- nástroj musí zůstat read-only a fail-closed;
- nepovolujte POST, WebSocket, service worker, redirect nebo nejasný endpoint kvůli
  úplnosti exportu;
- výchozí export nesmí otevřít thread; opt-in smí otevřít nejvýše jeden target s
  aktuálním network důkazem `read=true`;
- nepoužívejte ani nezavírejte běžný Chrome uživatele;
- nespouštějte živý LinkedIn test bez explicitního souhlasu uživatele;
- nečtěte, nevypisujte a necommitujte `.auth`, `.env`, reálné exporty ani obsahové
  diagnostics, pokud to úkol výslovně nevyžaduje. Pro ověření preferujte agregáty;
- `.partial` nikdy nesmí přepsat poslední úplný export.

Před dokončením změny spusťte:

```powershell
npm.cmd run check
npm.cmd audit --omit=dev
npm.cmd audit
git diff --check
git status --short
```

Plný audit k 2026-09-24 obsahuje dvě známé moderate položky pouze ve vývojovém
Vitest řetězci; produkční audit je čistý. Automatický major upgrade neprovádějte jako
vedlejší efekt jiného úkolu.

Při změně architektury, CLI, bezpečnosti nebo persistence aktualizujte ve stejném
commitu `README.md`, `HANDOVER.md`, `docs/ARCHITECTURE.md`, případně
`docs/DECISIONS.md`, a odpovídající testy.
