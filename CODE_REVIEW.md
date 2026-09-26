# Aktuální stav code review

Aktualizováno: **2026-09-26 Europe/Prague**

Runtime: `43ec961`; testová oprava: `27b9fc4`.

BL-007: **GO**, uzavřená syntetická bezpečnostní validace a nezávislé review.
BL-006: **NO-GO pro důvěryhodný obsahový export**, parser stále může zaměnit InMail
subject za body. Conversation-level isStarred zůstává samostatně ověřené.

## BL-007 review a evidence

Nový read-only reviewer zkontroloval transport proxy, broker, generation/ownership,
drain, finální hard stav a testy proti backlogu. Nenalezl runtime síťový průnik.
Jediný P2: stress assertions před cleanupem mohly přehlédnout pozdní request.
Commit `27b9fc4` přidal kontrolu po každé iteraci a odstranil mazání counteru.
Nezávislé re-review: **žádné otevřené blokující nálezy**.

- Tři plné `npm.cmd run check`: PASS 165/165, typecheck/build PASS.
- Finálních 5 oddělených procesů: vždy původních 30 + nových 55 timing iterací,
  úmyslný HTTP/CONNECT bypass a nulové foreign/unread server hity i po cleanupu.
- Produkční audit: 0; plný audit: 2 známé moderate dev-only Vitest položky.
- Žádný živý LinkedIn test během BL-007. Kompatibilita nového asset brokeru se
  ověří při autorizované BL-006 validaci.

Proxy nemá forwarding cestu, selection generation se revokuje před drainem,
brokery ji kontrolují těsně před sítí a finální audit se pořizuje po context.close.
One-thread/current read=true, POST/WS/SW/redirect hranice zůstávají zachované.

## Další práce

BL-006, BL-003, BL-005, BL-001, BL-002, research-only BL-004 podle
BACKLOG_PROGRESS.md. Staré exporty neopravovat mergem; jsou obsahově nedůvěryhodné.
Historické review záznamy jsou v docs/history/CODE_REVIEW_LOG.md.
