# Handover: LinkedIn messages reader

Last updated: 2026-09-07 16:49 Europe/Prague

## Latest checkpoint (16:49) — derived fallback reaches 99/100; prefer short probe target

Commit `c3b3c27` implements and tests the byte-preserving derived fallback. The
repeat then reached 99/100 complete, 200 pages and zero parser misses. The sole
failure is the one 55-message conversation; all other conversation histories
completed. Page arithmetic shows the long thread fetched its initial page and
one full older page, then failed before the third page. This strongly suggests
the server accepted the mixed raw delimiter encoding but ignored/repeated the
derived anchor. The complete main candidate remained unchanged with its prior
digest; only `.partial` was replaced.

The reason the server-emitted template disappeared is now clear in code:
`freshPreferredProbeConversation` and `preferredProbeIds` deliberately selected
only conversations with at least 20 messages, and sorted longest-first. Such a
target rendered one page without a usable scroller and emitted no older GET.
The earlier successful probes used a short read thread, for which LinkedIn
automatically emitted the terminal anchored GET while filling the viewport.

Next: change both preferences to a non-empty `<20` message history and choose
the shortest fresh, network-proven `read=true` candidate. Keep the derived path
as a fail-closed fallback, but require the actual server-emitted anchored
template for the 55-message thread. Rerun into the same complete candidate;
expect captured template count 1, 100/100 complete and unchanged digest.

## Previous checkpoint (16:43) — repeat preserved output; probe omitted continuation URL

The exact repeat run ended partial, and atomic persistence preserved the clean
complete candidate unchanged with the same content digest
`f3d0d7f2ba944afe31dc019ead3420fcc6bb69f6e6012a2a3d50f94dbe063d0b`.
It was not a data/deduplication difference. The probe safely opened one read
thread with zero hard violations but captured only the initial two-field
`messengerMessages` GET (`probeHistoryRequestUrls=1`), not an anchored
continuation. The reader consequently fetched one initial page for each target
and failed all 100 closed at `anchored history template unavailable`; zero parser
misses occurred and the partial candidate has zero complete histories.

Root cause: the UI sometimes automatically issues the anchored GET for a short
thread, but a 20-message target can render without a usable scroll container and
does not emit it. Next: add a byte-preserving derived fallback from the *current
run's observed initial GET* using the already live-validated contract. Require an
exact two-field initial `messengerMessages.<hash>` request, insert raw ASCII
`deliveredAt` at the beginning and `countBefore=20,countAfter=0` at the end,
change no other URL byte, then independently validate exact operation, method,
origin and one target identity before every GET. Add an integration test with no
captured continuation, rerun full export, and then repeat it.

## Previous checkpoint (16:38) — clean full candidate validated

Commit `99eb461` narrows rich renderer metadata: weak renderer types are not
attachments on ordinary text messages. The clean fresh-path live export now
passes with exit 0 and these schema-validated aggregates: `partial=false`,
100 conversations, 193 messages, 100 complete histories, 201 history pages,
0 parser misses, 0 missing timestamps, 0 duplicate conversation IDs, and
0 duplicate message IDs. Ten messages have strongly evidenced attachments;
the only empty-text message has an attachment. The only export warning is the
expected bounded `LIST_SCROLL_LIMIT`; list coverage still validates for the
requested 100.

The clean candidate is ignored at
`data/linkedin/messages-validated-candidate.json`. Its content-only SHA-256
(account + conversations, excluding `exportedAt`/stats) is
`f3d0d7f2ba944afe31dc019ead3420fcc6bb69f6e6012a2a3d50f94dbe063d0b`.

Next: rerun the exact command into the same candidate, recompute that digest,
and require equality. Then run the complete test/build/audit suite, promote the
validated candidate to `data/linkedin/messages.json` while keeping the prior
local file as a backup, and request the separate final code-review agent.

## Previous checkpoint (16:31) — complete candidate passes, attachment metadata needs narrowing

Commit `694ed32` added the bounded rich-content adapter and positive/negative
tests. The fresh live run succeeded with exit 0. Schema-only validation reports:
`partial=false`, 100 conversations, 193 messages, 100 complete histories,
0 missing timestamps, 0 duplicate conversation IDs and 0 duplicate message IDs.
Content-only SHA-256 is
`7df9751d5b989ef9a0bb6d907e205a2a81cd52cff069850d15faa07527bfcdd3`.

Do **not** promote this first successful candidate yet. Validation also showed
88 messages with attachments because the adapter treated a generic
`renderContent.type` renderer discriminator as an attachment even on ordinary
text messages. This does not lose messages, but it overstates attachment
metadata. Narrow it so explicit `attachments` remain accepted, while
`renderContent` on a text message requires strong file evidence (ID, name, safe
URL, or MIME-like type). A weak renderer discriminator may be retained only on
the content-only message whose otherwise empty text caused the original miss.
Write the corrected result to a fresh path so prior overclassified metadata
cannot survive idempotent merge.

## Previous checkpoint (12:46) — remaining miss is rich/attachment content

Commit `0ab3a21` added values-free element contract diagnostics and the repeated
full run reproduced exactly the same aggregates: 99/100 complete histories,
201 pages, 192 messages, one miss in `older-parse`. The diagnostic contains no
field values. It shows that every event on that page has stable message,
conversation, sender/actor, timestamp and body fields. The only relevant schema
variants are `renderContent` arrays (some non-empty) and one auxiliary summary
array; body text is structurally present but may be empty. This is consistent
with one attachment/rich-content-only message, which the parser deliberately
rejected because it did not yet preserve attachments.

Next: add a bounded adapter that extracts only stable attachment fields from
`attachments`/`renderContent` subtrees (`id`, `name`, `type`, safe URL), accepts
an empty text only when at least one meaningful attachment was preserved, and
keeps the existing fail-closed behavior for `{ attachments: [{}] }` or unknown
content. Add positive and negative parser tests, then run the full candidate.

## Previous checkpoint (12:37) — full run is 99/100; one parser shape remains

Commit `e839897` contains the anchored reader, exact request-policy additions,
navigation-race fix, mocked three-page reader test, README update, and a broad
`data/linkedin/*.json*` ignore rule. Typecheck, the anchored reader test, focused
probe tests, and all 38 navigation tests pass.

The first fresh full run completed safely as a partial candidate and did not
replace the existing main export. Aggregates: 100 conversations requested,
99 histories complete, 1 failed, 201 history pages, 192 parsed messages, and one
parser miss. The safe failure class is `history-page-failure:older-parse:FAILED`.
This proves request rebinding/pagination across the set; one older page contains
a currently unsupported message/event representation. The candidate is ignored
at `data/linkedin/messages-complete-candidate.json.partial`.

Next: add a diagnostics-only element structural signature (allowlisted/redacted
key names and primitive types only; never values), rerun once to identify that
event contract, implement and test its parser adapter, then repeat the full run.
Do not weaken completion: the one miss must reach zero before promotion.

## Previous checkpoint (12:25) — anchored history works end to end

The 11:52 sync-token conclusion immediately below is **superseded and wrong**.
Safe operation-shape diagnostics proved that both observed URLs use the same
`messengerMessages.<hash>` operation. The second URL is the real older-page
request with Rest.li fields, in observed order:
`deliveredAt,conversationUrn,urn,countBefore=20,countAfter=0`.
`messengerMessagesBySyncToken` is an incremental-sync path, not older-history
pagination, and its experimental implementation has been removed.

The active implementation preserves every raw URL byte and rebinds only the
validated target identity plus the unique 13-digit `deliveredAt` anchor. It
fetches the initial page, anchors each next request to the oldest parsed message,
requires the anchor to decrease, rejects cycles/foreign identities/parser
misses, and treats a raw page shorter than `countBefore` as bounded evidence of
the beginning of history. The cap is 250 pages per conversation. Completion is
represented by contiguous hashed page evidence; raw URLs, tokens, IDs, names,
and message text never enter diagnostics.

A fresh isolated-browser `--limit 1 --with-history-probe` run succeeded:
one selected already-read thread, zero hard safety violations, one anchored
template, two history pages, one complete conversation, and zero parser misses.
The only warning was the bounded list-scroll limit. Focused verification passes
55/55 tests, including all 38 navigation tests and their 30-run teardown race;
typecheck also passes.

Active uncommitted implementation files are `src/linkedin/history-reader.ts`,
`src/linkedin/probe-navigation.ts`, `src/linkedin/probe-request-policy.ts`,
`src/linkedin/probe.ts`, `tests/unit/probe-request-policy.test.ts`, and
`tests/unit/probe.test.ts`. Ignored local probe outputs are under
`data/linkedin/`. Do not commit or expose those account-derived files.

Next: commit this documentation checkpoint, add a mocked multi-page anchored
reader integration test, update the README, commit the implementation, then run
a fresh full 100-conversation export twice and compare a content-only digest for
idempotence. Only after schema/completeness validation should the validated
candidate replace `data/linkedin/messages.json` (keeping a local backup).

## Previous checkpoint (11:52, superseded) — mistaken sync-token inference

The target policy now narrowly proxies only two observed GET-only renderer
dependencies (`messengerSeenReceipts` and `messengerQuickReplies`) when they
carry exactly one target-matching conversation reference. POST, WebSocket,
foreign references, selection-phase use, and every mutation-shaped operation
remain blocked. Typecheck, 7 policy tests, and all 38 navigation integration
tests pass.

A real probe then completed with one already-read target, zero hard violations,
one initial history template shape, and **two distinct validated history request
URLs** in memory. Static literal-ID count remained zero, as expected. Because
`observedHistoryQueryTemplate` only accepts requests whose policy kind is
`conversation-history`, and the only newly accepted such operation is the exact
`messengerMessagesBySyncToken.<hash>` two-variable contract, the second URL is
the real older/sync persisted operation emitted by LinkedIn. Its hash/token/URL
were neither logged nor persisted; `ObservedHistoryGet.continuationUrls` carries
it only inside the process.

Next: select exactly one continuation URL that independently passes the sync
operation contract for the probe target. For every exported conversation, fetch
the ordinary initial page, use its parsed exact `conversationUrn` and
`newSyncToken` to instantiate the captured continuation template, then follow
response `prevCursor` until `fullyLoaded === true`. Require identity match,
zero parser misses, no cursor cycles, and a 250-page cap. Emit contiguous
history evidence so only proven-complete threads can make the main export.

## Previous checkpoint (11:39) — separate persisted query ID conclusively required

The bounded limit-1 experiment now passed every local URL/origin/method/identity
guard and issued the corrected `(conversationUrn,syncToken)` GET. LinkedIn
returned HTTP 400 when it used the initial `messengerMessages.<hash>` query ID.
No mutation was attempted and the candidate remained partial. This conclusively
rules out reuse of the initial persisted query ID; a separate operation ID is
required.

The reliable implementation now constructs the new variables from the parsed
response's exact `conversationUrn`, verifies that it resolves to the one target
ID, preserves every non-variables URL byte, and re-runs the exact GET policy.
The earlier raw-encoding guesses can be deleted from history; do not return to
them. Diagnostics expose only stage plus `HTTP_400`, never response bodies or
token values.

Next: broaden the in-memory static-artifact lookup from a hex-only suffix to the
actual persisted-ID alphabet and run one safe probe. If exactly one literal is
found, use it only in memory. If still zero, inspect the public query registry's
module/dataflow rather than trying further server requests with guessed IDs.

## Previous checkpoint (11:31) — sync request stopped locally; encoding fixed

A full 100-conversation diagnostic run and several limit-1 runs all remained
partial and preserved the existing main export. The 100 run completed 100/100
ordinary history GETs (100 pages, 0 failures, still 158 messages). The corrected
sync experiment initially never reached LinkedIn: schema-only diagnostics showed
`history-sync-contract:instantiate:READ_POLICY_BLOCK_CONVERSATION_IDENTITY`.

The observed variables report as Rest.li fields in this order:
`conversationUrn,urn`, but their inner separators may be percent-encoded in the
raw URL. The active `history-reader.ts` edit now decodes the whole raw variables
value once, extracts the validated two-field initial contract in either safe
order, rebuilds exactly `(conversationUrn,syncToken)`, encodes that whole value,
and subjects the result to the existing exact-target GET policy before any
request. Typecheck and the 10 focused probe tests pass. The next immediate action
is one limit-1 run; manifest diagnostics record only the stage/error class and
aggregate counts.

Active uncommitted files now include `src/linkedin/probe.ts` (preserves observed
field order in schema-only diagnostics), `src/linkedin/history-reader.ts`, the
subagent's unreviewed optional `src/linkedin/probe-request-policy.ts` support for
a literal separate operation, and `tests/unit/probe.test.ts`. Do not discard them
without reviewing this checkpoint.

## Previous checkpoint (00:05) — corrected sync variables; active edits tracked

The literal operation-ID hypothesis is now explicitly **unconfirmed**. Scanning
both public scripts and the cached target HTML found zero literal
`messengerMessagesBySyncToken.<hex>` IDs. One attempt failed closed before any
thread opened; the next opened exactly one already-read thread and ended with
zero hard safety violations. The temporary HTML scan was reverted because it
provided no value.

The bundle dataflow does prove the exact older/sync variables object is
`{conversationUrn, syncToken}`. This exposed a flaw in the earlier dead-end
experiment: it had sent `{conversationUrn, urn, syncToken}` by appending the
token and retaining the initial viewer `urn`. Active edits in
`history-reader.ts` now replace the initial viewer field so the request uses
only `(conversationUrn,syncToken)` while keeping the observed query ID and all
other URL bytes. Typecheck and the focused 10-test probe suite pass. The next
live step is a single bounded GET through the existing export path to determine,
using aggregate/schema-only diagnostics, whether this yields distinct older
messages and exposes `prevCursor`/`fullyLoaded`.

The implementation subagent started an additional uncommitted fail-closed
parser/policy implementation for a possible literal
`messengerMessagesBySyncToken.<hash>` operation in
`src/linkedin/probe-request-policy.ts`, but hit its usage limit before supplying
tests. Review and test that diff before retaining it; it may be unnecessary if
the corrected same-query-ID call succeeds. Current uncommitted files at this
checkpoint are `src/linkedin/history-reader.ts`,
`src/linkedin/probe-request-policy.ts`, and `tests/unit/probe.test.ts`.

## Previous checkpoint (22:26) — direct operation-ID regex was a dead end

Commit `e19760b` added the in-memory-only exact-string capture and passed
typecheck plus 16 focused tests. A real `probe:read-thread` then completed with
one target thread navigation, zero hard safety violations, and one initial
history template, but `probeOlderHistoryOperationIds=0`. The public bundle has
the `messengerMessagesBySyncToken` client function and its variables, but does
not contain a literal adjacent `messengerMessagesBySyncToken.<hex>` string. Do
not repeat the exact-string regex approach.

Next: use the observed initial `messengerMessages.<hex>` operation as a public,
non-personal lookup key against only the already-downloaded relevant bundle
sources held in memory. Identify how the query registry associates imported
artifacts/IDs with operation names, record only counts/structural facts, and
derive exactly one older-operation ID without logging or persisting its value.
In parallel, the implementation subagent is adding fail-closed policy/parser
support and tests for the known separate operation; it must not access LinkedIn
or edit the history reader/probe.

## Previous checkpoint (22:21) — exact older-page binding identified

The allowlisted tokenized bundle-context pass completed without storing any
LinkedIn content, identities, URLs, cookies, token values, or operation hashes.
It shows that the separate persisted operation is called
`messengerMessagesBySyncToken.<hash>` and takes exactly these semantic variables:

```text
conversationUrn, syncToken
```

The older-page response/client state uses `prevCursor`; completion uses
`fullyLoaded`. The initial `messengerMessages.<hash>` response's `newSyncToken`
is therefore the starting input for the separate operation; subsequent backwards
requests must use the prior response's `prevCursor` and stop only when
`fullyLoaded === true`. Never substitute the returned `newSyncToken` into the
initial operation again; that experiment was already proven to be incremental
refresh rather than older-history paging.

Active uncommitted work in `src/linkedin/probe.ts` extracts only the exact
`messengerMessagesBySyncToken.<hex>` persisted-operation identifier from already
downloaded static JavaScript and keeps it in process memory. The identifier must
not be logged. The manifest records only how many unique matching operation IDs
were found. Next: typecheck/test this capture, run one guarded known-read probe to
prove exactly one operation ID is available, then implement the GET-only chain in
the parser/history reader and validate it first on one bounded thread.

## Previous checkpoint (22:13) — separate older-history operation found

Schema-name inspection of JavaScript bundles already downloaded by the guarded
page found the missing client contract. Relevant identifiers cluster together:

```text
messengerMessagesBySyncToken, syncToken, newSyncToken, prevCursor, older,
fullyLoaded, shouldClearCache, ADD_OLDER_MESSAGES, syncMessagesToMessageStates
```

Thus the original `messengerMessages.<hash>` operation is only initial load, and
the previously tested `newSyncToken` is for incremental sync. Older pages use a
separate persisted `messengerMessagesBySyncToken` operation with client
`prevCursor`; completion is represented by `fullyLoaded`. Next action is one
tokenized bundle-context pass (only allowlisted identifier names plus punctuation;
all other identifiers/literals become `x`) to determine the exact variable
binding. Then add the new operation to the exact GET policy and parser, with no
acceptance unless it is cryptographically/structurally chained from the initial
target response token/cursor.

## Previous checkpoint (22:09) — target DOM scrolling is a dead end

The ignored partial candidate contains one 20-message conversation with fresh
(`<=30min`) `read=true/readEvidence=network-explicit`. Probe can use that only as
a local selection hint while still applying exact URL/identity validation, an
isolated GET preflight, fresh ephemeral Chromium, and one target maximum. The
navigation gate was also fixed so only a canonicalized route resolving to the
same conversation identity can be treated as equivalent; a foreign thread
navigation is now fatal. The 38 navigation integration tests and typecheck pass.

Two successful real probes of that long thread each had: one target navigation,
zero hard safety violations, one distinct history URL, the expected 20-message
response (observed twice by the page), but **zero DOM elements with any vertical
scroll range**, even after testing all visible elements rather than only
`overflow:auto|scroll`. The strict target page does not render a message list,
likely because auxiliary messaging endpoints are deliberately denied. Therefore
UI scrolling cannot reveal the older-history request under the current safe gate;
do not repeat this approach.

One failed selection-list-scroll experiment opened zero threads and failed closed
after a proxied UI response changed; also do not repeat it. Next: inspect only
identifier/schema hints around `messengerMessages`, `newSyncToken`, paging/anchor
terms in already downloaded static LinkedIn JavaScript bundles. No message/identity
content may be recorded. Use those hints to construct one bounded same-operation
GET experiment, or conclude that complete history cannot be proven under the
non-mutating GET-only boundary.

## Previous checkpoint (21:56) — sync-token dead end proven

Commit `f57a589` added a one-GET, in-memory-only experiment for the one plausible
`newSyncToken` binding. A fresh 100-conversation partial run reached a 20-element
history, added `syncToken` to the otherwise byte-identical Rest.li variables, and
received: 1 element, 1 parsed message, **0 distinct stable aliases** relative to
the initial page, and `shouldClearCache=false`. This proves that `newSyncToken` is
an incremental refresh/cache token, not an older-history cursor. Do not build
history pagination from it. The experimental continuation was not merged into
output and the result remained partial.

The request variables are now also structurally confirmed as raw Rest.li with
fields `conversationUrn,urn`; their URN entity types are `msg_conversation` and
`fsd_profile`. The `urn` variable is therefore the viewer/profile context, not a
history anchor.

Next action: select a currently server-confirmed read thread known from the local
ignored partial candidate to have a 20-message initial window. The selection page
may scroll only the conversation list (safe GETs, no thread open), then must retire
as before. Open exactly that one thread and perform DOM scrollTop-only attempts in
the fresh guarded target page; capture safe operation/variable shapes for any
additional `messengerMessages` GET. Never click, type, or issue a non-GET. This is
the required observation of LinkedIn's separate older-history operation.

## Previous checkpoint (21:50) — live response contract identified

Commit `59af6c6` contains the review fixes and resumption checkpoint. A fresh,
explicitly authorized run of
`npm.cmd run export -- --limit 100 --with-history-probe` then completed exactly
one safe thread navigation and 100/100 direct history GETs with zero read
failures. It correctly wrote only `messages.json.partial` (100 conversations / 158
messages, `partial:true`); the main JSON was not changed.

Safe schema-only diagnostics across all 100 current history responses show this
exact collection contract:

```text
collection: _recipeType, _type, elements[1..20], metadata
metadata: _recipeType, _type, deletedUrns[], newSyncToken<string>,
          shouldClearCache=true
```

No `total`, `start`, `end`, `hasNextPage`, `nextCursor`, or response link is
present. `newSyncToken` is therefore the only server-provided continuation/sync
candidate in the current persisted operation. Its value was never logged or
written. Next: add a tightly bounded in-memory contract probe for this token and
compare only response counts/stable message aliases. If it returns a distinct
older page, formalize its exact variable binding and completion evidence; if it
is merely an incremental-refresh token, the UI must be observed while scrolling
one explicitly-read long thread to capture the separate older-history operation.

## Previous checkpoint (21:46) — review findings fixed locally

The CRH-01..03 fixes are implemented and locally verified:

- unpaginated `messengerMessages` responses are no longer assigned synthetic
  totals/end markers; without explicit server evidence they remain partial;
- raw URL rebinding uses sentinel-based semantic reference detection and changes
  only byte ranges parsed as conversation identities, leaving tracking values and
  persisted query bytes untouched;
- default export performs no thread probe; complete-history discovery now requires
  explicit `--with-history-probe`, and one invocation can navigate at most one
  target because all three broad retries were removed;
- the selection renderer now has a lower-level Chromium denylist and is retired in
  freeze/fence/drain/close order. The 30-iteration race and all 38 navigation-gate
  integration tests pass with zero forbidden local-server hits;
- focused parser/config/probe tests pass (38/38) and TypeScript typecheck passes.

`history-reader.ts` now records only safe response schema field names/types/array
lengths as `history-contract:*` strategies. The next action is one explicitly
approved `--with-history-probe` partial diagnostic run. Inspect only those safe
contract strings to identify the real cursor/end fields; do not print payloads,
URLs, IDs, names, or messages. Then implement explicit pagination proof.

## Previous checkpoint (21:42) — do not treat the current export as complete

Independent review of commit `ae0ae78` found two High and one Medium issue; the
full report is appended to `CODE_REVIEW.md` as CRH-01..03. The existing ignored
`data/linkedin/messages.json` is schema-valid (100 conversations / 158 messages),
but it is **not a trustworthy complete result**: the largest thread has exactly
20 messages and the code invented `total=count`, `end=true`, and
`historyComplete=true` merely because the initial request/response exposed no
recognized next link. Do not publish, delete, or overwrite this file as a
complete export until the server provides explicit completion evidence.

Immediate blockers and next actions:

1. Remove the fabricated unpaginated-completion inference in
   `src/linkedin/history-reader.ts`; absence of paging evidence must remain
   incomplete.
2. Rebind only the validated conversation-identity location inside the raw
   `variables` query parameter. The current global textual replacement can also
   alter tracking/query fields. Preserve all unrelated URL bytes.
3. Prevent export retry from ever opening multiple threads. A retry may occur
   only when list capture failed before target selection/navigation; any error
   after arming/opening the target is terminal for that invocation.
4. Safely inspect only response structure/key names from one already-read
   thread, determine the current `messengerMessages.<hash>` cursor contract, and
   implement pagination until the response explicitly proves the beginning/end
   and complete contiguous coverage.
5. Then run a real 100-conversation export twice, compare stable-ID/count
   digests, run `npm.cmd run check` and audit, and only then mark the result done.

Uncommitted safety work adds a Chromium-level denylist plus
freeze/fence/drain/close ordering for the disposable selection renderer. The
30-iteration teardown race now passes. Three integration assertions still need
updating because lower-level CDP blocking correctly prevents requests before
Playwright counters see them; all relevant local test servers saw zero forbidden
requests. No normal Chrome process or profile was used.

## Previous checkpoint (21:30; superseded by 21:42 review)

The first complete-looking real run succeeded. `npm run export -- --limit 100` performed
100 validated history GETs (one per conversation), with 0 read failures and no
pagination pages required by the observed unpaginated persisted operation. It
wrote `data/linkedin/messages.json` with 100 conversations, 158 messages,
`partial: false`, no empty conversations, 200/200 participant recruiter fields,
and no missing message directions. Message counts range from 1 to 20; 20
conversations have more than one message. The later review proved that this is
only an incomplete default response window, not completion evidence.

The final file validates against `ExportSchema`. The normalized output initially
omitted the internal per-conversation `historyComplete` evidence even though the
pre-write coverage check used it. `normalizeConversation` has now been patched to
preserve safe conversation `sourceMetadata`; the required second idempotence run
will rewrite the complete file with that auditable evidence. After that, compare
the stable-ID digest, run full tests/build/audit, update old integration
expectations for confirmed-abort semantics, and commit.

## Previous checkpoint (20:23)

Commit `4d1fb85` contains the successful real probe and its safety-policy fixes.
After that commit, uncommitted work adds `src/linkedin/history-reader.ts`, returns
the validated history request from `probeReadThread` only in process memory, and
wires it into `exportMessages` through an isolated authenticated GET-only request
context.

The first integrated `npm run export -- --limit 100` safely reached 100 list
conversations but all 100 history reads failed before any page was accepted, so
only `messages.json.partial` was updated (100 conversations / 100 preview
messages); no incomplete data replaced the final path. The likely cause was
rebuilding the observed nested Rest.li query through `URLSearchParams`, which
changed LinkedIn's exact percent encoding. `instantiateObservedHistoryUrl` has
now been changed to preserve the raw observed URL byte-for-byte and substitute
only exact raw/encoded forms of the validated conversation ID. Next action is a
focused real retry, then inspect only aggregate history counts.

## Previous checkpoint (20:12)

The real one-thread probe now succeeds. Aggregate result: 20 list conversations,
12 explicitly read candidates, exactly 1 target navigation, exactly 1 validated
`messengerMessages.<hash>` history template, and 0 hard safety violations. The
probe never touched the user's normal Chrome and every observed POST was blocked.

The final issue was not a request reaching LinkedIn: after the cached target
loaded, LinkedIn attempted another document navigation. Playwright aborted it,
Chromium retained the exact target URL in an inert renderer, but the old check
mistook the missing in-page guard marker for a safety escape. Target safety now
accepts that inert exact-URL state while the authoritative Node route guard stays
active. Safe redacted reason counters remain available for future regressions.

Next active work: return the validated raw history GET only in process memory,
instantiate it for each of the 100 list conversation IDs, retrieve all pages with
isolated authenticated GET-only request contexts, and prove complete coverage.
The focused integration suite still has old expectations that treat successfully
aborted target requests as fatal; update those expectations to the implemented
invariant (zero server hits + exact target state), then run the full suite.

## Objective and non-negotiable safety boundary

Build and run the TypeScript/Playwright exporter from `zadani.md`: export about 100 newest LinkedIn conversations with complete message histories to `data/linkedin/messages.json`, including stable IDs, participants, sender, timestamp, direction, text, and recruiter classification. Repeated runs must merge idempotently.

Never delete, send, react, archive, mark read/unread, or change the LinkedIn profile. Never attach to or close the user's normal Chrome. Real runs use Playwright's isolated headless Chromium context with `.auth/linkedin-storage-state.json`. The global guard blocks non-GET HTTP methods, WebSockets, and service workers. Auth data, message content, names, and identifiers must not enter Git or logs.

The user explicitly approved the one-thread probe. Selection is restricted to a conversation whose trusted list GET reports `unreadCount === 0` (or `read === true`). The user also explicitly stated that a GET for an already-read conversation is acceptable.

## Repository and completed workflow requirements

- Git was initialized locally; branch is `master`.
- Assignment review: `REVIEW.md`.
- Implementation plan: `PLAN.md`.
- Independent code review record: `CODE_REVIEW.md`.
- The requested separate planning, implementation, and review subagents were used in earlier turns.
- Dependencies are installed. `npm audit` most recently reported 0 vulnerabilities.
- `.auth/`, diagnostics, final/partial exports, and credentials are ignored by Git.

## What already works

- Login/storage state works. Do not ask the user to log in again unless `AUTH_REQUIRED` is observed.
- The ordinary exporter can load LinkedIn Messaging and previously produced an ignored partial candidate containing 100 conversations, but only one preview message per conversation. It is not Definition-of-Done because histories are incomplete.
- Current list endpoint is an exact GET to `/voyager/api/voyagerMessagingGraphQL/graphql` with persisted operation `messengerConversations.<hex hash>`.
- Its variables include a canonical non-conversation `mailboxUrn`; the narrow policy exception is covered by tests.
- The current list response parses 20 conversations per first page. Twelve of the current first 20 are proven already read via `unreadCount === 0`.
- Current conversation IDs use valid padded ASCII (`=`); `msg_conversation` composite URNs and padded route IDs are now parsed.
- The probe now successfully performs exactly one target preflight and exactly one cached browser navigation to a proven already-read thread. No normal Chrome process is used.
- Latest real probe aggregate: selection conversations 20, explicitly read 12, target preflight 1/1, thread navigations 1, POST requests blocked, one remaining hard safety condition after target load.
- The current target emits a GET persisted operation `messengerMessages.<hex hash>`. The parser finds exactly one conversation reference and it matches the selected target. The policy still blocks it because another conservative reference-validity check fails.

## Previous blocker (resolved at 20:12)

The one-thread target page used to end in `READ_POLICY_BLOCK`. The current exact
hashed request is accepted and the real probe now captures one history template.

The post-load hard flag was traced with safe reason counters and resolved as
described in the latest checkpoint above.

The immediate functional route is:

1. For exact target-phase GET `messengerMessages.<32..128 hex>`, allow it only when the parser found exactly one conversation ID and that ID is in `targetIds`. Do not let unrelated invalid non-conversation metadata veto this already exact persisted operation; typed foreign/multiple/no conversation IDs must still block.
2. Attach target network capture and retain the exact allowed GET URL only in process memory. Parse its response and pagination.
3. Generalize the observed URL by replacing the one validated target conversation reference with each of the 100 validated list conversation IDs. Perform only direct GETs through the authenticated Playwright `APIRequestContext`; preserve the exact persisted operation and other variables.
4. Fetch every page until server paging proves completion. Feed all payloads through `parseNetworkPayload`, merge with `coalesceRaw`, validate `historyComplete`, normalize, and atomically write the final export.
5. Rerun the export and compare stable conversation/message IDs and counts to verify idempotence.

## Important safety design and successful tests

- Probe selection document is first fetched in a disposable API context, cached, and fulfilled from memory.
- Selection messaging GETs are proxied through disposable API contexts so response cookies cannot mutate the browser cookie jar.
- POST, PUT, PATCH, DELETE, WebSocket, service worker, redirects, legacy REST messaging endpoints, ambiguous encodings, and foreign conversation references are covered by unit/integration tests.
- Selection and target pages are different Page objects.
- Before closing selection, a prepared CDP session calls `Network.setBlockedURLs(['*'])`; only then is the old Page closed. This prevents the previously reviewed `page.close()` late-fetch race without using the user's Chrome.
- A 30-iteration randomized teardown-race integration test exists. It passed under the prior inert-page implementation. After switching to CDP-fence-then-close, one test assertion still expected both Pages; that assertion was corrected, but the full integration file must be rerun.
- Target/selection POST requests seen in logs are blocked by the global guard. A blocked request is not evidence it reached LinkedIn.

## Dead ends / lessons

- Do not use the user's running Chrome or its profile. Earlier testing used separate Playwright Chromium only.
- Waiting for DOM selectors in the probe caused about 15 seconds of churn and late SPA navigations. The probe now waits directly for the trusted list network response and immediately retires selection.
- The list operation is hashed (`messengerConversations.<hash>`), not the old bare query name.
- Treating every `*Urn` as a conversation identity blocked legitimate `mailboxUrn`; only exact `mailboxUrn`/`inboxUrn` with a parsed known non-conversation LinkedIn URN is exempt.
- LinkedIn provides `unreadCount`, not `read`, in the current list response. `unreadCount === 0` is now trusted only for the exact observed list GET.
- Conversation IDs contain Base64-style padding. Restricting IDs to letters/numbers/underscore/dot/hyphen rejected all real candidates.
- `Runtime.terminateExecution` followed by CDP `Page.navigate('about:blank')` hung on the real renderer. The stuck process tree was identified by parent PID and terminated without touching normal Chrome. Current code uses CDP network fence then `page.close()`.
- Initial `about:blank` on a new Page does not always run context `addInitScript`; do not require `guardReady` until the cached target document is actually navigated. The target document itself does receive the init script.
- The normal exporter currently proves list coverage but not thread-history coverage. Do not call the existing `.partial` file complete.

## Working tree at this checkpoint

Committed HEAD before the active edits: `632a01a fix: support current padded conversation identities`.

Active uncommitted edits are in:

- `src/linkedin/probe-navigation.ts`
- `src/linkedin/probe-request-policy.ts`
- `src/linkedin/probe.ts`
- `tests/integration/probe-navigation.test.ts`
- `tests/unit/probe-request-policy.test.ts`

They implement CDP-fence-then-close selection retirement, tolerant confirmed-abort handling, target structural diagnostics, exact target list behavior, and corresponding test updates. Review `git diff`, run targeted tests, then commit them before larger exporter work.

## Commands and verification checklist

```powershell
git status --short
git diff --check
npm.cmd run typecheck
npm.cmd test -- --run tests/unit/probe.test.ts tests/unit/probe-request-policy.test.ts tests/integration/probe-navigation.test.ts
npm.cmd run probe:read-thread
npm.cmd run check
npm.cmd audit --audit-level=high
npm.cmd run export -- --limit 100
```

Inspect real results only with aggregate scripts; do not print message text, names, cookies, URLs, or IDs. Final checks must prove:

- final `data/linkedin/messages.json` exists (not only `.partial`), parses against `ExportSchema`, and has `partial === false`;
- approximately 100 newest conversations unless the server proves fewer exist;
- every exported conversation has complete history and at least one message;
- messages have sender identity/name, direction, sequence, text, and timestamp where LinkedIn supplies it;
- every participant has `probablyRecruiter` and `recruiterSignals`;
- a second run preserves stable IDs and creates no duplicate messages;
- full test/build/audit pass and `git status --short` is clean except ignored runtime data.

Update this document after each material checkpoint so a context-free agent can continue from the repository alone.
