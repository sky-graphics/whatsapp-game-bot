# WRG Bot — Logic Flow Document
## Sky Graphics · Word Riddle Game

---

## File Roles

| File | Role | Depends On |
|---|---|---|
| `index.js` | Entry point. Bot connection, message routing, game play handler | All others |
| `adminCommands.js` | All `/` command handling, onboarding, key flow | `permissions.js` |
| `gameEngine.js` | Lobby, countdowns, board display, turn management | `permissions.js`, `matchSummary.js` |
| `permissions.js` | Tier resolution, nameTag, difficultyBadge, writeSetting | Nothing (pure) |
| `matchSummary.js` | DQ recording, last-standing check, match report sender | Nothing (pure) |

---

## Startup Flow

```
startBot()
  → useMultiFileAuthState('auth_info')
  → makeWASocket()
  → loadPersistedGames()        ← restores active game/lobby from games.json
  → connection.update listener
      → QR generated if not authenticated
      → on 'open':
          → seed own LID mapping (if Redis present)
          → send boot DM to admin (once per process, hasSentBootAdminConfirmation flag)
          → if active game/lobby persisted:
              → send recovery message to group
              → resume lobby countdown OR resume game board OR notify paused
```

---

## Message Routing Flow (every inbound message)

```
messages.upsert (type='notify')
  → skip if no msg.message
  → isDuplicateMessage(msgId) → skip if already seen
  → skip if from === 'status@broadcast'
  → extract: from, body, rawBody, sender
  → resolve senderNumber:
      Priority 1: msg.key.senderPn
      Priority 2: fromMe → CREATOR_JID number
      Priority 3: strip JID suffix (may be LID — unsafe for creator check)
  → resolve senderJid:
      fromMe → CREATOR_JID (so replies go to creator's DM)
      group → msg.key.participant
      DM → msg.key.remoteJid
  → rememberName(senderNumber, pushName) → writes nameCache
  → isAdmin check (old-style: fromMe OR adminNumber match OR adminNumber empty)
  → if not admin AND publicVisible=false AND not slash command → skip
  → refresh adminJid if admin sent message
  → ROUTE:
      body starts with '/' → handleAdminCommand(ctx)
      rawBody === 'WRG'   → start lobby flow
      rawBody.toUpper === 'WRG' (mixed case) → ping/info response
      body starts with 'wrg' → wrg join / wrg start / wrg help
      else → active game play handler
```

---

## Admin Onboarding Flow (/admin)

```
Anyone types /admin
  → adminCommands.handleAdminCommand()
  → senderIsCreator = isCreator(senderNumber, senderJid)
      uses _checkCreator from permissions.js
      checks senderNumber AND senderJid number portion vs CREATOR_JID

  IF creator:
    → DM to senderJid: "Welcome back Founder" message
    → return

  IF confirmed admin (isAdmin && adminNumber set):
    → DM to adminJid (NOT senderJid — BUG): buildHelpText

  IF admin already set, sender is not admin:
    → rate limit check (5 attempts → 10 min lockout)
    → DM: "bot already configured"
    → return

  IF no admin set + no key input:
    → rate limit check
    → generate UUID key
    → store in pendingKeys[senderJid] with 10-min expiry
    → store in approvalQueue[senderNumber]
    → DM sender: "enter key from Sky Graphics team"
    → DM creatorNumber: key + name + number + /approve /deny options

  IF no admin set + key submitted:
    → rate limit check
    → look up pendingKeys[senderJid]
    → check expiry, check JID match (bound to requester's JID)
    → track wrong attempts (3 → void session)
    → on correct key:
        → save adminNumber + adminJid
        → start 30-day inactivity timer
        → DM sender: "Access Granted"
        → DM creatorNumber: registration confirmed
```

---

## /approve and /deny Flow

```
Creator types /approve [number]
  → senderIsCreator check → silent if not creator
  → look up approvalQueue[number] → get targetJid
  → check pendingKeys[targetJid] still valid + not expired
  → send key delivery DM to targetJid (branded Sky Graphics)
  → confirm to creatorNumber

Creator types /deny [number]
  → senderIsCreator check → silent if not creator
  → delete pendingKeys[targetJid]
  → delete approvalQueue[number]
  → DM target: neutral rejection (no reason)
  → confirm to creatorNumber
```

---

## Game Start Flow (WRG all caps)

```
WRG typed
  → check isAdmin OR publicCanStart
  → check no activeGameChat already running
  → getGameState(from, games, settings)  ← 3 args (BUG: gameEngine takes 2)
  → reset lobby state
  → auto-join creator (from CREATOR_JID)
  → auto-join admin if different from creator
  → send lobby open message with difficulty badge
  → set activeGameChatRef.value = from
  → startLobbyCountdown(from, ctx)
      → every 10s: send countdown update with difficulty + player list
      → at 0s: startActualGame()
```

---

## Game Round Flow

```
startActualGame(chatId, ctx)
  → read difficulty LIVE from settings.difficulty
  → pick word from words[difficulty] (falls back to DEFAULT_WORDS if empty)
  → reset: attempts={}, skipStreaks={}, disqualified=[], currentTurnIndex=0
  → send "Game On" message with difficulty + player lineup
  → sendGameBoard()

sendGameBoard(chatId, feedback, extraMentions, ctx)
  → read current player from gameState.players[currentTurnIndex]
  → nameTag(currentPlayerNumber, gameState.playerNames, settings)
      → shows "Name (Creator)" or "Name (Admin)" or "Name"
  → show word, attempts left for THIS player, whose turn, who's next
  → startTurnCountdown()

startTurnCountdown(chatId, ctx)
  → 30-second interval
  → at 20s: warn current player by name
  → at 10s: urgent warning
  → at 0s:
      → increment skipStreaks for currentPlayer
      → if skipCount >= 3:
          → recordDisqualification(SKIPPED_3)
          → remove from players, playerNames, playerJids, skipStreaks, attempts
          → checkLastPlayerStanding → if winner: end game
          → if no players: end game no winner
          → else: adjust currentTurnIndex, sendGameBoard
      → else: rotate turn, sendGameBoard
```

---

## Letter/Word Guess Flow (index.js)

```
Message received during active game
  → verify senderNumber === currentPlayerNumber (or admin bypass)
  → reset skipStreaks[currentPlayer] = 0

  IF body.length === 1 (letter guess):
    → search targetWord for first unrevealed match
    → if found:
        → reveal in hiddenWord
        → if word complete → VICTORY → sendMatchReport
        → else → rotate turn → sendGameBoard
    → if not found:
        → gameState.attempts[currentPlayer]++
        → if attempts >= maxTries:
            → recordDisqualification(ATTEMPTS_EXHAUSTED)
            → remove from all tracking objects
            → checkLastPlayerStanding
            → if winner: end game
            → if no players: end game no winner
            → else: adjust index, sendGameBoard
        → else: rotate turn, sendGameBoard

  IF body === targetWord (full word guess):
    → INSTANT WIN → sendMatchReport
```

---

## Match Report Flow

```
sendMatchReport(sock, chatId, gameState, outcome, tag)
  → builds participant list from gameState.players + gameState.disqualified
  → outcome types: winner_letter / winner_instant / last_standing / no_winner
  → tag(number) is used for all name display ← uses index.js tag() which
    calls displayName() which returns nameCache[number] || number
    (does NOT use nameTag from permissions — so no (Creator)/(Admin) badges
    and may show raw numbers if name not cached)
  → sends formatted report to chatId with mentions
```

---

## 30-Day Inactivity Timer

```
startAdminInactivityTimer(settings, saveSettings, sock, sendSafeMessage)
  → runs every hour
  → if 30 days elapsed since last admin command:
      → clear adminNumber and adminJid
      → DM creatorNumber: auto-cleared notification
      → stop timer
  → adminLastActive updated on every admin/creator command entry
```

---

## Settings Write Flow

```
/set difficulty easy
  → writeSetting(tier, 'difficulty', 'easy', settings)
      tier = undefined (BUG — never computed in adminCommands.js)
      → if tier === CREATOR: write to settings.creatorOverrides
      → else: write to settings root
  → since tier is undefined → writes to settings root (same as admin)
  → saveSettings()
  → game picks up new difficulty at next word-pick (LIVE read in gameEngine)
```
