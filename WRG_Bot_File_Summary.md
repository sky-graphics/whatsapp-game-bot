# WRG Bot — File Summary
*Sky Graphics · Word Riddle Game Bot*

---

## permissions.js

The single source of truth for who's allowed to do what. Every other file asks this one for tier decisions instead of checking numbers itself.

- Resolves a sender's tier — Creator, Admin, or Public — by comparing their number (and a LID fallback) against CREATOR_JID and the saved admin number.
- Holds `resolveSetting()` / `writeSetting()` — the logic that lets a Creator override always beat whatever the Admin has configured.
- Provides shared display helpers: `difficultyBadge()` for the 🟢🟡🔴 mode badges, and `nameTag()` so Creator/Admin show with a role label everywhere.j

*Depends on nothing else in this project. **Everything else depends on it.***

---

## index.js

The orchestrator. Connects to WhatsApp, receives every message, and decides where it should go — it doesn't run the game or the admin commands itself.

- Opens the WhatsApp connection, sends the boot DM to Creator (and Admin, if different), and recovers any in-progress game after a restart.
- Resolves each sender's real phone number from the message — including LID lookups — then asks permissions.js for their tier.
- Routes `/` commands to adminCommands.js, and `wrg` commands (join, start, help) to the participant-facing game flow.
- Owns the live letter-guessing and full-word-guessing logic during an active round, and hands off to matchSummary.js when a round ends.
- Persists `settings.json`, `words.json`, `games.json`, `names.json`, and `lidcache.json` to disk.

---

## adminCommands.js

Every `/` command lives here — onboarding, settings, word pools, and game control.

- Runs the admin onboarding flow: key request → Creator approves or denies → requester submits the key → Admin slot is filled.
- Handles all `/set` commands (difficulty, public, start, maxtries, admin) plus `/clearadmin` and `/reset`.
- Manages word pools (`addword`, `removeword`, `listwords`, `setwords`, `clearwords`, `setallwords`), including the guard that blocks emptying the last pool with words.
- Runs game controls — `/pause`, `/resume`, `/end`/`/stop`, `/status` — each replying to the sender's DM and, where relevant, announcing in the group.
- Enforces rate limiting on `/admin` attempts and auto-clears an inactive admin slot after 30 days.

---

## gameEngine.js

Pure game logic — the lobby countdown, the board, and the turn timer. No admin logic lives here.

- `getGameState()` creates and returns the per-chat game object — players, hidden word, attempts, timers.
- `startLobbyCountdown()` runs the 60-second join window and posts reminders every 10 seconds.
- `startActualGame()` picks the word, sets the attempt budget from `settings.maxTries`, and kicks off the first turn.
- `sendGameBoard()` renders the current board state and starts the 30-second turn timer via `startTurnCountdown()`.
- `startTurnCountdown()` handles timeouts, skip-streak disqualification, and the 20-second/10-second warnings.

---

## matchSummary.js

Bookkeeping for how a round ends. Never owns game state — it just reads and writes the gameState object it's handed.

- `recordDisqualification()` removes a player and logs why — skipped 3 turns, or used all wrong guesses — cleaning up their JID and attempt count too.
- `checkLastPlayerStanding()` detects when only one player remains after a disqualification, so the round can end immediately.
- `sendMatchReport()` builds and sends the final 🏆 *WRG MATCH COMPLETE* message — winner, full participant list with DQ reasons, the revealed word, and match stats.
