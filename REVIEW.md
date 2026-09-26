# Aktuální review projektu a dokumentace

Aktualizováno: **2026-09-26 Europe/Prague**

BL-007 je uzavřen: runtime `43ec961`, testová oprava `27b9fc4`, nezávislé
review a re-review bez otevřeného blokujícího nálezu. Tři plné check běhy
165/165 PASS; pět finálních samostatných stress procesů ověřilo server-hit-0
i po cleanupu. Produkční audit 0, plný audit 2 známé moderate dev-only.

BL-006 stále blokuje obsahově důvěryhodný export. Starší schema-validní JSON může
obsahovat subject místo body; je nutná oprava a nový nezávislý živý export.
Živá kompatibilita nového BL-007 brokeru zatím nebyla ověřena.

Autoritativní požadavky jsou v BACKLOG.md, checkpoint a první nedokončená akce
v BACKLOG_PROGRESS.md, provozní hranice v AGENTS.md a docs/ARCHITECTURE.md.
Následují BL-006, BL-003, BL-005, BL-001, BL-002 a research-only BL-004.
