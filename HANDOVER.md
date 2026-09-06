# Handover: LinkedIn messages reader

Last updated: 2026-09-06 21:30 Europe/Prague

## Latest checkpoint (21:30)

The first complete real run succeeded. `npm run export -- --limit 100` performed
100 validated history GETs (one per conversation), with 0 read failures and no
pagination pages required by the observed unpaginated persisted operation. It
wrote `data/linkedin/messages.json` with 100 conversations, 158 messages,
`partial: false`, no empty conversations, 200/200 participant recruiter fields,
and no missing message directions. Message counts range from 1 to 20; 20
conversations have more than one message.

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
