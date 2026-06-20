# WRG Bot — Bugs & Errors Found
## Sky Graphics · Full Audit Report

Severity: 🔴 CRASH / 🟠 WRONG BEHAVIOUR / 🟡 SILENT FAIL / 🔵 MINOR

---

## index.js

---

### BUG-01 🔴 `senderTier` used but never defined
**File:** `index.js`
**Line:** ctx object passed to `handleAdminCommand`
**Code:** `senderTier` is passed in the ctx object but is never declared or computed anywhere in index.js.
**Effect:** `ctx.senderTier` is `undefined` in adminCommands.js. Any code that reads it gets `undefined`, causing the `tier` variable (used in `writeSetting`) to silently default to admin behaviour instead of creator behaviour.
**Fix:** Add before the ctx block:
```js
const senderTier = getTier(senderNumber, settings, senderJid)
```
And import `getTier` from permissions.js (it's already imported but `getTier` is included in the import).

---

### BUG-02 🟠 `isAdmin` computed with old logic — bypasses permissions.js entirely
**File:** `index.js`
**Line:** `const isAdmin = msg.key.fromMe || senderNumber === settings.adminNumber || settings.adminNumber === ''`
**Effect:** When no admin is set (`adminNumber === ''`), EVERYONE is treated as admin. This means any public user can trigger admin-gated behaviour before onboarding is complete. Also, this never calls `getTier()` from permissions.js, so the tier system is bypassed for all routing decisions in index.js.
**Fix:**
```js
const senderTier   = getTier(senderNumber, settings, senderJid)
const senderIsAdmin = senderTier === TIERS.ADMIN || senderTier === TIERS.CREATOR
```
Replace all uses of `isAdmin` in index.js with `senderIsAdmin`.

---

### BUG-03 🟠 `getGameState` called with 3 args — wrong signature
**File:** `index.js`
**Lines:** 3 occurrences — `getGameState(from, games, settings)`
**Effect:** `gameEngine.getGameState` now takes only 2 args `(chatId, games)`. The third `settings` arg is silently ignored by JavaScript, so it doesn't crash — but it's dead code and a maintenance trap. Any future overload of the signature could break these silently.
**Fix:** Change all to `getGameState(from, games)`

---

### BUG-04 🟠 `tag()` function uses `displayName()` — shows raw numbers, no (Creator)/(Admin) badge
**File:** `index.js`
**Code:**
```js
function tag(number) {
    return `@${displayName(number)}`
}
```
**Effect:** All in-game feedback messages (`✅ Correct!`, `❌ Wrong guess!`, DQ notices, instant win) use `tag()` which shows `@Name` or `@237682477421` (raw number if name not cached). It does NOT show `(Creator)` or `(Admin)` badges. It also prefixes with `@` which causes WhatsApp to attempt a mention link — but the mention JID may not match, showing the number instead of the name.
**Fix:** Replace `tag()` with:
```js
function tag(number) {
    return nameTag(number, nameCache, settings)
}
```
Import `nameTag` from permissions.js (already imported in index.js).

---

### BUG-05 🟠 `buildCtx` does not pass `nameCache` — gameEngine cannot tag players correctly
**File:** `index.js`
**Code:**
```js
function buildCtx(sock) {
    return { sock, games, settings, words, activeGameChatRef, persistGames, jidOf, tag, DEFAULT_WORDS }
}
```
**Effect:** `gameEngine.js` destructures `nameCache` from ctx in `startTurnCountdown`. Since `nameCache` is not in `buildCtx`, it is `undefined` inside gameEngine. `nameTag(number, undefined, settings)` then falls back to `'Player'` for every player name — losing all names in timeout messages.
**Fix:** Add `nameCache` to buildCtx:
```js
function buildCtx(sock) {
    return { sock, games, settings, words, activeGameChatRef, persistGames, nameCache, DEFAULT_WORDS }
}
```
Remove `jidOf` and `tag` — gameEngine no longer uses them.

---

### BUG-06 🟠 Lobby join message still shows raw `@number` format
**File:** `index.js`
**Code:** `✅ *@${senderNumber} (${senderName}) joined the lobby!*`
**Effect:** Displays the raw phone number in the join confirmation message. Should use `nameTag` for consistency with the rest of the game.
**Fix:**
```js
`✅ *${nameTag(senderNumber, nameCache, settings)} joined the lobby!* 🎉`
```

---

### BUG-07 🟠 Lobby auto-join still uses `@number` format in initial message
**File:** `index.js`
**Code:** `.map((num, i) => \`${i + 1}. @${num} (${gameState.playerNames[num] || num}) — Auto-joined 👑\`)`
**Effect:** Same as BUG-06 — shows raw number in the lobby open message.
**Fix:** Use `nameTag(num, nameCache, settings)` and remove `@${num}` prefix.

---

### BUG-08 🟠 `sendMatchReport` passed `tag()` which shows numbers and no role badge
**File:** `index.js`
**Lines:** All `matchSummary.sendMatchReport(...)` calls pass the local `tag` function.
**Effect:** Match report shows `@237682477421` instead of `Might Awa (Creator)`. If name is not in nameCache (new player), it shows the raw number.
**Fix:** Pass a wrapper that uses `nameTag`:
```js
(n) => nameTag(n, nameCache, settings)
```
Replace all `tag` references in sendMatchReport calls with this lambda.

---

### BUG-09 🟡 Boot DM only goes to admin — creator gets no boot notification
**File:** `index.js`
**Code:** `const bootTarget = settings.adminJid || settings.adminNumber`
**Effect:** When the bot restarts, only the admin gets a boot DM. The creator (you) gets nothing unless you are also the admin. If you've set a separate admin, you won't know the bot came back online.
**Fix:** Also send a boot DM to `CREATOR_JID` if it differs from adminJid.

---

## adminCommands.js

---

### BUG-10 🔴 `permissions.js` imported twice — double require, stale reference
**File:** `adminCommands.js`
**Lines 17-18 and 19-24:**
```js
const { isCreator: _checkCreator, isAdmin: _checkAdmin } = require('./permissions')
const { TIERS, getTier, isCreator: isCreatorFn, ... } = require('./permissions')
```
**Effect:** Two separate destructures from the same module. `_checkAdmin` is imported but never used. `isCreatorFn`, `isAdminFn` are imported but the actual `isCreator()` and `isAdmin()` used in the handler come from neither — they come from the local `isCreator()` wrapper function defined later. Causes confusion and wastes the import.
**Fix:** One single import:
```js
const { isCreator: _checkCreator, TIERS, difficultyBadge, writeSetting, nameTag } = require('./permissions')
```

---

### BUG-11 🔴 `tier` variable used in `writeSetting(tier, ...)` but never defined
**File:** `adminCommands.js`
**Effect:** `tier` is referenced in `/set difficulty`, `/set public`, `/set start` handlers but is never declared anywhere in `handleAdminCommand`. JavaScript resolves it as `undefined`. `writeSetting(undefined, key, value, settings)` falls into the `else` branch and writes to `settings` root — same as admin behaviour. Creator's settings can never go to `creatorOverrides` as intended.
**Fix:** Add at the top of `handleAdminCommand` after resolving `senderIsCreator`:
```js
const tier = senderIsCreator ? TIERS.CREATOR : TIERS.ADMIN
```

---

### BUG-12 🔴 `startTurnCountdown(activeGameChat)` — missing ctx argument
**File:** `adminCommands.js`
**Code:** In `/resume` handler: `startTurnCountdown(activeGameChat)`
**Effect:** `gameEngine.startTurnCountdown(chatId, ctx)` requires a ctx object as the second argument. Called with only one arg, ctx is `undefined` — the function immediately throws when it tries to destructure `const { sock, games, ... } = ctx`.
**Fix:**
```js
startTurnCountdown(activeGameChat, {
    sock, games, settings, activeGameChatRef, persistGames, nameCache: ctx.nameCache
})
```
Or pass the full ctx through to adminCommands from index.js so it can be forwarded here.

---

### BUG-13 🔴 `getGameState(activeGameChat)` — missing `games` argument
**File:** `adminCommands.js`
**Lines:** All 4 occurrences in `/pause`, `/resume`, `/end`, `/status`
**Effect:** `gameEngine.getGameState(chatId, games)` requires 2 args. Called with 1, `games` is `undefined` — the function throws `Cannot read properties of undefined` when it tries `games[chatId]`.
**Fix:** Change all to `getGameState(activeGameChat, games)` — `games` is available via ctx destructure.

---

### BUG-14 🟠 `replyTo` uses `creatorNumber` for creator — may fail as bare digits
**File:** `adminCommands.js`
**Code:** `const replyTo = senderIsCreator ? creatorNumber : adminJid`
**Effect:** `creatorNumber` is a bare digit string like `237682477421`. `sendSafeMessage` does handle bare numbers (appends `@s.whatsapp.net`), but this may fail if WhatsApp routes the creator via a LID. Commands like `/set difficulty`, `/pause`, `/resume`, `/end`, `/status`, `/reset`, word pool commands — all reply to `creatorNumber` instead of `senderJid`.
**Fix:** `const replyTo = senderJid` — always reply to whoever sent the command, using their already-resolved JID.

---

### BUG-15 🟠 All creator alert DMs use `creatorNumber` (bare digits) — 12 occurrences
**File:** `adminCommands.js`
**Effect:** Every notification sent to the creator (key request, registration confirm, approve/deny confirmations, inactivity auto-clear) uses `creatorNumber` which is bare digits. Same LID routing risk as BUG-14. Since the creator's `senderJid` is not always available in these async contexts (inactivity timer has no senderJid), this is harder to fix universally. Minimum fix: store `CREATOR_JID` env var directly and use it as-is (it's already a valid JID `@s.whatsapp.net`).
**Fix:** Replace `creatorNumber` with `creatorJid` (the full env var) in all `sendSafeMessage(sock, creatorNumber, ...)` calls.

---

### BUG-16 🟠 `/admin` confirmed admin redirect goes to `adminJid` not `senderJid`
**File:** `adminCommands.js`
**Code:** `await sendSafeMessage(sock, adminJid, { text: buildHelpText(settings, false) })`
**Effect:** If a confirmed admin types `/admin` from a group, the reply goes to `settings.adminJid` (the JID captured when admin last messaged the bot) rather than to the JID of the message that just triggered the command. These could differ if the admin uses multiple devices.
**Fix:** `await sendSafeMessage(sock, senderJid, { text: buildHelpText(settings, false) })`

---

### BUG-17 🟡 `permissions.js` `isCreator`/`isAdmin` signatures don't match how adminCommands calls them
**File:** `permissions.js` exports `isCreator(senderNumber, settings)` (2 args).
**adminCommands.js** calls `_checkCreator(senderNumber, senderJid, {})` (3 args — passes empty `{}` for settings).
**Effect:** The `isCreator` in permissions.js only checks `senderNumber` vs CREATOR_JID (no JID fallback). The wrapper in adminCommands does pass `senderJid` as second arg, but permissions.js ignores it. The JID fallback logic discussed in the chat was added to the adminCommands wrapper but NOT to permissions.js `getTier` (which is what `isCreator` calls internally).
**Fix:** Update `getTier` in permissions.js to accept and use `senderJid` as a third argument with fallback logic (check number extracted from JID against creatorNum if senderNumber check fails).

---

### BUG-18 🟡 `/clearadmin` and `/status` not in `COMMAND_TIERS` in permissions.js
**File:** `permissions.js`
**Effect:** `canRunCommand(tier, 'clearadmin')` and `canRunCommand(tier, 'status')` both return `false` for all tiers — these commands are treated as "unknown" and denied. If any code ever uses `canRunCommand` as a gate for these, they would silently fail.
**Fix:** Add to `COMMAND_TIERS`:
```js
clearadmin: TIERS.ADMIN,
status:     TIERS.ADMIN,
```

---

### BUG-19 🟡 `nameTag` in `permissions.js` uses `nameCache` as second arg but gameEngine passes `gameState.playerNames`
**File:** `gameEngine.js` correctly passes `gameState.playerNames` as the nameCache arg — this is intentional and correct since `playerNames` is the per-game name store. But `permissions.js` comments say "nameCache" suggesting it's the global bot nameCache. Both are `{number: name}` maps so it works, but it's an undocumented assumption. No code bug — just a documentation/naming risk.

---

## matchSummary.js

---

### BUG-20 🟠 `tag(number)` in match report uses index.js local function — shows numbers not role badges
**File:** `matchSummary.js`
**Effect:** The `tag` function passed to `sendMatchReport` is `index.js`'s local `tag()` which calls `displayName(number)` — returning the raw number if nameCache doesn't have the entry. No `(Creator)` or `(Admin)` badge. All participant lines in the match report show inconsistent formatting.
**Fix:** Callers in `index.js` should pass `(n) => nameTag(n, nameCache, settings)` instead of `tag`. In `gameEngine.js` this is already done correctly for DQ notices but the match report call still uses the lambda `(n) => nameTag(n, gameState.playerNames, settings)` — which is correct for game context since it uses the game's name store.

---

### BUG-21 🟡 `recordDisqualification` removes from `playerNames` and `skipStreaks` but not `playerJids` or `attempts`
**File:** `matchSummary.js`
**Effect:** After a skip-3 DQ via `recordDisqualification`, `gameState.playerJids[number]` and `gameState.attempts[number]` are left behind as orphaned keys. `gameEngine.js` does manually delete them after calling `recordDisqualification` — so it's handled, but inconsistently. If any future caller uses `recordDisqualification` without the manual cleanup, it will leave stale data.
**Fix:** Add cleanup inside `recordDisqualification`:
```js
delete gameState.playerJids?.[number]
delete gameState.attempts?.[number]
```

---

## permissions.js

---

### BUG-22 🟡 `getTier` has no `senderJid` fallback — LID routing breaks creator detection
**File:** `permissions.js`
**Effect:** `getTier(senderNumber, settings)` only checks `senderNumber`. If WhatsApp routes the creator's message via a LID and `senderPn` is not populated, `senderNumber` may be the LID digits (e.g. `777xxxxx`) which don't match `237682477421` from CREATOR_JID. The creator is then treated as PUBLIC.
**Fix:** Add optional third arg:
```js
function getTier(senderNumber, settings, senderJid) {
    // ... existing senderNumber check ...
    // fallback: extract number from JID and compare
    const jidNum = (senderJid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
    if (creatorNum && jidNum && jidNum === creatorNum) return TIERS.CREATOR
    // ... admin check ...
}
```

---

## Cross-File Contract Violations

| # | Description | Cause |
|---|---|---|
| X-01 | `buildCtx` omits `nameCache` — gameEngine gets `undefined` | index.js |
| X-02 | `senderTier` passed in ctx but never computed | index.js |
| X-03 | `getGameState` called with 3 args in index.js, 1 arg in adminCommands.js — correct signature is 2 args | index.js + adminCommands.js |
| X-04 | `startTurnCountdown` called with 1 arg in adminCommands.js — requires 2 | adminCommands.js |
| X-05 | permissions.js `isCreator(senderNumber, settings)` but called as `_checkCreator(senderNumber, senderJid, {})` — JID arg is accepted but ignored | permissions.js |
| X-06 | `tag()` in index.js not equivalent to `nameTag()` from permissions.js — match reports and game feedback use different tagging logic | index.js |
