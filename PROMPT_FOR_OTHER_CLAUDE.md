# Prompt — Update index.js and adminCommands.js for WRG Bot

You are updating two files for a WhatsApp game bot (WRG — Word Riddle Game) built with Baileys.
A new file `permissions.js` now exists and is the single source of truth for all role/tier logic.
A new file `gameEngine.js` has been rewritten. Both are already done — do NOT touch them.
You are only updating `index.js` and `adminCommands.js`.

---

## What permissions.js exports (read-only — do not modify)

```js
const {
  TIERS,               // { CREATOR, ADMIN, PUBLIC }
  getTier,             // getTier(senderNumber, settings) → 'CREATOR'|'ADMIN'|'PUBLIC'
  isCreator,           // isCreator(senderNumber, settings) → bool
  isAdmin,             // isAdmin(senderNumber, settings) → bool (true for CREATOR too)
  isPublic,            // isPublic(senderNumber, settings) → bool
  canRunCommand,       // canRunCommand(tier, commandName) → bool
  difficultyBadge,     // difficultyBadge('easy') → '🟢 *Easy*'
  resolveSetting,      // resolveSetting(key, settings, default) → value (creator overrides win)
  writeSetting,        // writeSetting(tier, key, value, settings) — mutates settings in place
  getReplyTarget,      // getReplyTarget(tier, senderJid, settings) → JID (always sender's DM)
  nameTag              // nameTag(number, nameCache) → name string, never number
} = require('./permissions')
```

## What gameEngine.js now expects in ctx

gameEngine.js no longer receives `jidOf` or `tag` in ctx.
It now receives `nameCache` (the bot's name cache object `{ [number]: name }`).
`playerJids` is now stored on `gameState` itself — added at join time in index.js.
`getGameState` now takes only `(chatId, games)` — no `settings` argument.

---

## Changes to index.js

### 1. Add import at top
```js
const { getTier, isAdmin, isCreator, nameTag, difficultyBadge, TIERS } = require('./permissions')
```

### 2. Remove the inline isCreatorNumber helper function
It no longer exists in index.js — getTier() from permissions.js replaces it.

### 3. Fix senderNumber extraction — always use senderPn
```js
const senderNumber = (msg.key.senderPn || '')
    .split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
    || sender.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
```

### 4. Fix isAdmin line
Replace:
```js
const isAdmin = msg.key.fromMe || senderNumber === settings.adminNumber || ...
```
With:
```js
const senderTier = getTier(senderNumber, settings)
const senderIsAdmin = isAdmin(senderNumber, settings)  // true for CREATOR too
```
Use `senderIsAdmin` everywhere `isAdmin` was used. Use `senderTier` when you need the exact tier.

### 5. Fix tag() function — name only, never number
Replace the existing `tag()` function with:
```js
function tag(number) {
    return nameTag(number, nameCache)
}
```
This means all in-game mentions show only the player's name — never a number or JID.

### 6. Fix buildCtx — pass nameCache, remove jidOf and tag
```js
function buildCtx(sock) {
    return {
        sock,
        games,
        settings,
        words,
        activeGameChatRef,
        persistGames,
        nameCache    // gameEngine uses this for nameTag()
        // do NOT pass jidOf or tag — gameEngine no longer uses them
    }
}
```

### 7. Fix getGameState calls in index.js
gameEngine's getGameState now takes only 2 args: `(chatId, games)`.
Remove the `settings` argument everywhere getGameState is called in index.js.

### 8. Fix player join — store JID on gameState.playerJids at join time
When a player types `wrg join`, after adding them to `gameState.players`, also do:
```js
gameState.playerJids[senderNumber] = sender  // sender is the raw JID from msg
```
Also do this for the auto-join of the creator/admin when the lobby opens.

### 9. Fix WRG (all caps) lobby open — show difficulty in opening message
When the lobby opens, read difficulty live and include it:
```js
const difficulty = settings.difficulty || 'easy'
// Include difficultyBadge(difficulty) in the lobby open message
```
Example text line to add:
```
`🎯 Mode: ${difficultyBadge(difficulty)}\n`
```

### 10. Fix auto-join logic — creator always auto-joins, not adminNumber
Replace the auto-join block that checks `settings.adminNumber` with:
```js
// Creator always auto-joins regardless of who the admin is
if (process.env.CREATOR_JID) {
    const creatorNum = process.env.CREATOR_JID.split('@')[0].split(':')[0]
    if (!gameState.players.includes(creatorNum)) {
        gameState.players.push(creatorNum)
        gameState.playerNames[creatorNum] = nameCache[creatorNum] || 'Creator'
        gameState.playerJids[creatorNum]  = process.env.CREATOR_JID
    }
}
// Admin also auto-joins if they are a different person from the creator
if (settings.adminNumber && settings.adminNumber !== creatorNum) {
    if (!gameState.players.includes(settings.adminNumber)) {
        gameState.players.push(settings.adminNumber)
        gameState.playerNames[settings.adminNumber] = nameCache[settings.adminNumber] || 'Admin'
        gameState.playerJids[settings.adminNumber]  = settings.adminJid || `${settings.adminNumber}@s.whatsapp.net`
    }
}
```

### 11. Fix wrong-letter guess block — use currentPlayerNumber (not senderNumber) for attempts key
In the wrong letter guess handler, the variable `currentPlayerNumber` must be resolved BEFORE
the turn rotation. The attempts key must be `currentPlayerNumber` (the player whose turn it is),
not `senderNumber`. The existing index.js already does this correctly — just verify it.

### 12. Fix /set difficulty — write via writeSetting, read via resolveSetting
When processing `/set difficulty` in adminCommands.js (see below), use `writeSetting` so
creator overrides are respected. In gameEngine.js, `settings.difficulty` is already read live
at word-pick time — so no other change is needed for the difficulty fix.

### 13. Pass ctx correctly to handleAdminCommand
```js
const ctx = {
    ...buildCtx(sock),
    pendingAdminChangeRef,
    saveSettings,
    saveWords,
    sendSafeMessage,
    getGameState: (chatId) => getGameState(chatId, games),
    startTurnCountdown: (chatId) => startTurnCountdown(chatId, buildCtx(sock)),
    fs,
    senderNumber,
    senderName,
    senderJid: sender,
    senderTier,          // ADD THIS — the resolved tier from permissions.js
    sender: from,
    body,
    isAdmin: senderIsAdmin
}
```

---

## Changes to adminCommands.js

### 1. Add import at top
```js
const {
    TIERS, getTier, isCreator, isAdmin, canRunCommand,
    difficultyBadge, writeSetting, resolveSetting, getReplyTarget, nameTag
} = require('./permissions')
```

### 2. Remove the inline isCreator() function entirely
It no longer lives here. Use `isCreator(senderNumber, settings)` from permissions.js.

### 3. Replace all inline isCreator/isAdmin checks with getTier
At the top of handleAdminCommand, resolve tier once:
```js
const tier = ctx.senderTier || getTier(ctx.senderNumber, settings)
const senderIsCreator = tier === TIERS.CREATOR
const senderIsAdmin   = tier === TIERS.ADMIN || tier === TIERS.CREATOR
const creatorJid      = process.env.CREATOR_JID
const replyTo         = ctx.senderJid   // ALWAYS reply to sender's own DM
```

### 4. Fix /help gate — confirmed admin must work
The current bug is that when an admin is already set and they type /help, nothing happens.
The fix: check `senderIsAdmin` (which is true for both ADMIN and CREATOR tiers) not just `senderIsCreator`.

```js
if (cmd[0] === 'help') {
    if (!senderIsAdmin) return  // total silence for PUBLIC
    await sendSafeMessage(sock, replyTo, {
        text: buildHelpText(settings, senderIsCreator)
    })
    return
}
```

### 5. Fix /admin message — must come from bot, not relayed from creator
The bot sends to the person's own JID using `sendSafeMessage(sock, ctx.senderJid, {...})`.
This is already how it works — the message goes from sock (the bot) to the user's JID.
If it appears to come from the creator's number, the issue is that `ctx.senderJid` is
resolving to the creator's JID instead of the requester's. 
Fix: in the /admin handler, use `ctx.senderJid` as the target (the JID of whoever typed /admin),
never `creatorJid` as the target for messages going to the requester.

### 6. Fix creator alert — show PN not JID
In the creator alert (when someone types /admin), show senderNumber (plain digits) not senderJid.
The pendingKeys session already stores `senderNumber` — use that in the message text.

### 7. Fix /set difficulty — use writeSetting
```js
if (cmd[0] === 'set' && cmd[1] === 'difficulty') {
    const newDiff = cmd[2]
    if (['easy', 'normal', 'difficult'].includes(newDiff)) {
        writeSetting(tier, 'difficulty', newDiff, settings)
        saveSettings()
        await sendSafeMessage(sock, replyTo, {
            text: `⚙️ Difficulty set to: ${difficultyBadge(newDiff)} 🎯`
        })
    } else {
        await sendSafeMessage(sock, replyTo, {
            text: `⚠️ Invalid option. Choose: \`easy\` · \`normal\` · \`difficult\``
        })
    }
    return
}
```
Apply the same `writeSetting(tier, key, value, settings)` pattern to `/set public`, `/set start`, `/set maxtries` so creator overrides are scoped separately from admin settings.

### 8. Fix /approve and /deny — creator only, verified via canRunCommand
```js
if (cmd[0] === 'approve' || cmd[0] === 'deny') {
    if (!canRunCommand(tier, cmd[0])) return  // silent — public and admin see nothing
    // ... rest of approve/deny logic unchanged
}
```

### 9. Use nameTag() not raw number in any user-facing message inside adminCommands
Where the admin's name appears in messages (e.g. confirmation DMs), use:
```js
nameTag(senderNumber, ctx.nameCache || {})
```
Pass `nameCache` through ctx from index.js if not already there.

---

## Summary of what must NOT change

- matchSummary.js — do not touch
- gameEngine.js — already rewritten, do not touch  
- permissions.js — already written, do not touch
- The Redis/LID setup in index.js — do not touch
- The sendSafeMessage function in index.js — do not touch
- The game play logic (letter guess, word guess, instant win) in index.js — only fix the tag() usage and getGameState() call signature

---

## Files to output
- index.js (updated)
- adminCommands.js (updated)
