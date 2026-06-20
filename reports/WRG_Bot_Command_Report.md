# WRG Bot — Command & Hierarchy Report
## Sky Graphics · Three-Stage Breakdown

---

# STAGE 1 — THE CREATOR

## Who the Creator Is

The Creator is identified by the `CREATOR_JID` environment variable set in the Railway `.env` panel. This is a hardcoded permanent identity — it cannot be changed at runtime, cannot be revoked, and no command can override it. Every inbound message is checked against this value by `getTier()` in `permissions.js` before any other logic runs. If the phone number extracted from the sender matches the creator's number, they are assigned `TIERS.CREATOR` and all doors open unconditionally.

The creator is also detected via a LID fallback — if WhatsApp routes the creator's message through a `@lid` JID instead of the standard `@s.whatsapp.net` JID, the bot extracts the number from the JID suffix and compares it to the creator number before concluding the tier. This means the creator is never accidentally treated as public even on WhatsApp accounts that have been migrated to the LID system.

---

## What Happens When the Bot Starts

On every bot startup, after the WhatsApp connection opens, the creator receives a boot DM automatically:

> 🔁 *WRG Bot is back online!* ✅
> 👑 You're the *Creator* (unrestricted access).
> Type */help* to open your full dashboard.

This happens regardless of whether an admin is set. The admin also gets a separate boot DM if they are set and are a different person from the creator. The creator always knows when the bot comes online.

---

## Creator Commands — Full List

Every command is typed anywhere (any group, any DM, even self-chat) and the reply always comes to the creator's own DM. The group chat where the command was typed never sees a reply.

---

### `/admin`
**What it does:** Returns a creator identity confirmation message.

**Where the reply goes:** Creator's DM only.

**What it says:**
> 🔐 Sky Graphics Creator — Welcome back, Founder. You have unrestricted access to every function of this bot. Type /help to open the full dashboard.

**Effect on hierarchy:** None. Purely informational. No state is changed.

---

### `/help`
**What it does:** Returns the full admin dashboard with the live current config snapshot, including a creator-exclusive section showing `/approve` and `/deny`.

**Where the reply goes:** Creator's DM only.

**What it shows:** All settings commands, all word pool commands, all game control commands, creator-only commands, and the live values of difficulty, maxTries, publicVisible, publicCanStart, and whether an admin is set.

**Effect on hierarchy:** None. Purely informational.

---

### `/approve [number]`
**What it does:** Sends the pending access key to the requester identified by their phone number. This is the second half of the admin onboarding flow — after someone types `/admin` and their request arrives in the creator's DM, the creator uses this command to send them their key.

**Where the reply goes:** Two DMs are sent simultaneously:
1. The requester's DM receives the branded key delivery message with the UUID key and the instruction `/admin YOURKEY`.
2. The creator's DM receives a confirmation that the key was delivered.

**What happens if the key already expired:** The creator's DM gets a "Too late" notice. The requester's session is cleaned up automatically.

**What happens if the number has no active request:** Creator's DM gets "No active request found."

**Effect on hierarchy:** Enables the requester to activate their admin account. The key itself is not the admin slot — they still have to submit it correctly within 10 minutes for the slot to be filled.

---

### `/deny [number]`
**What it does:** Voids the pending key for a requester immediately, without giving them any reason.

**Where the reply goes:** Two DMs:
1. The requester's DM receives a neutral "your request could not be processed" message with no reason or details.
2. The creator's DM receives "Request denied and key voided."

**Effect on hierarchy:** The requester's session is deleted. `approvalQueue` and `pendingKeys` entries for them are removed. They cannot reuse the voided key. They would need to type `/admin` again to restart the process.

---

### `/set difficulty [easy/normal/difficult]`
**What it does:** Changes the active word difficulty for all future games.

**Where the reply goes:** Creator's DM.

**How it flows down the hierarchy:** Because the creator's tier writes to `settings.creatorOverrides` via `writeSetting(TIERS.CREATOR, ...)`, the creator's difficulty setting overrides whatever the admin has set. Even if the admin typed `/set difficulty normal`, if the creator types `/set difficulty easy`, the game will always pick easy words because `resolveSetting()` reads `creatorOverrides` first. The admin cannot override the creator.

**Effect on game:** Takes effect at the next word pick — even if a lobby is already open. The word is only chosen when the lobby closes and the game starts, so a difficulty change mid-lobby applies to that game.

---

### `/set admin [number]` → `/confirm` → `/cancel`
**What it does:** Directly assigns an admin by number without going through the key onboarding flow.

**Where the reply goes:** Creator's DM for the confirmation prompt, then creator's DM for the confirm/cancel result. The newly assigned admin also receives a welcome DM telling them they have been made admin.

**Flow:**
1. Creator types `/set admin 237XXXXXXXXX`
2. Bot DMs creator: "Confirm Admin Change? Type /confirm or /cancel."
3. Creator types `/confirm`
4. `settings.adminNumber` is set. `settings.adminJid` is cleared (will be re-captured when the new admin next sends a message).
5. New admin receives a DM: "You've been assigned as WRG Bot administrator."
6. 30-day inactivity timer starts from this moment.

**If creator types `/cancel`:** Pending change is discarded. No state is changed.

**Effect on hierarchy:** The person at this number now has ADMIN tier. Replaces any previously set admin.

---

### `/set public [on/off]`
**What it does:** Controls whether non-admins can interact with the bot at all.

**Where the reply goes:** Creator's DM.

**OFF behaviour:** Any message from a PUBLIC tier user is silently ignored — except `/admin` which always passes through for onboarding. Non-admins cannot see game updates, cannot join lobbies, cannot play.

**ON behaviour:** All messages from all users are processed normally.

**How it flows down:** Creator's override wins. If creator sets public OFF, admin cannot turn it ON via their own `/set public on` because `resolveSetting()` returns `creatorOverrides.publicVisible` first.

---

### `/set start [on/off]`
**What it does:** Controls whether non-admins can open a lobby by typing `WRG`.

**Where the reply goes:** Creator's DM.

**OFF behaviour (default):** Only admin or creator can type `WRG` to open a lobby. If a public user types `WRG`, they get: "Game Locked — the admin hasn't enabled public game starts."

**ON behaviour:** Anyone can type `WRG` to open a lobby.

**Effect on hierarchy:** Creator override wins over admin setting.

---

### `/set maxtries [number]`
**What it does:** Sets how many wrong letter guesses a player gets before being disqualified for exhausting attempts.

**Where the reply goes:** Creator's DM.

**Effect on game:** Takes effect immediately for the next round's word pick. Mid-game rounds keep the `maxTries` value that was active when that round started (it's read from `settings.maxTries` each time a wrong guess happens, so a live change mid-round does apply immediately).

**Note:** This does NOT affect skip-based disqualification (3 missed turns), which is hardcoded at 3 and cannot be changed via command.

---

### `/clearadmin`
**What it does:** Removes the admin slot — clears `adminNumber` and `adminJid` — without touching word pools or any other settings.

**Where the reply goes:** Creator's DM.

**Effect:** Admin slot is empty. The 30-day inactivity timer is stopped. Any future `/admin` requests restart the onboarding flow from zero. The creator's overrides and all word pools are untouched.

---

### `/reset`
**What it does:** Full wipe. Resets all settings to defaults, resets all word pools to the default word lists, kills any active game or lobby, deletes `settings.json` and `games.json` from disk.

**Where the reply goes:** Creator's DM.

**Effect on hierarchy:** Admin slot is cleared. All `creatorOverrides` are cleared. Difficulty reverts to easy. maxTries reverts to 10. publicVisible reverts to true. publicCanStart reverts to false. Any running game is killed immediately. The bot is back to factory state.

---

### `/addword`, `/removeword`, `/listwords`, `/setwords`, `/clearwords`, `/setallwords`
**What they do:** Manage the word pools for each difficulty level (easy, normal, difficult). Creator can add, remove, replace, or clear word pools. `/clearwords` has a safety guard — it refuses to clear the last pool that contains words, preventing a game-breaking state where no words exist to pick from.

**Where replies go:** Creator's DM.

**Effect on hierarchy:** Word pool changes are shared — both creator and admin draw from the same pools. However, the creator can clear a pool that an admin might rely on, and the admin cannot restore a pool the creator removed if `publicVisible` is OFF.

---

### `/pause`, `/resume`, `/end` / `/stop`, `/status`
See Stage 3 — these are shared with the admin tier and their game-level effects are described there.

---

## Creator's Position in the Hierarchy

The creator sits above every other tier permanently. `resolveSetting()` always checks `creatorOverrides` before `settings` (admin-layer). `writeSetting(TIERS.CREATOR, ...)` writes to `creatorOverrides`, not to the root settings object, so the creator's preferences never get overwritten by admin actions. The only thing the admin can do that the creator cannot override at the settings level is nothing — every settings key the admin can touch, the creator can trump.

---
---

# STAGE 2 — ADMIN ONBOARDING AND ADMIN COMMANDS

## The Onboarding Flow

The admin slot is empty by default. It must be filled through a key-based approval flow that requires creator involvement. There is no backdoor — no default admin, no first-come-first-served — except in one edge case described below.

---

### Step 1 — Requester Types `/admin`

Anyone who types `/admin` with no argument triggers the onboarding request.

**Rate limiting:** 5 attempts per 10 minutes. If a person types `/admin` 5 times without completing onboarding, they are silently locked out for 10 minutes. The bot does not tell them they are locked.

**What the requester receives (their DM):**
> 🔐 Admin Configuration — You're attempting to access the Bot Administration Panel. To proceed, enter the access key provided to you by the Sky Graphics team: `/admin YOURKEY`

**What the creator receives (their DM):**
> 🔔 Admin Access Request
> Name: [pushName]
> Number: [phone number]
> Key: [UUID key]
> Use `/approve [number]` to send them the key, or `/deny [number]` to void it.
> Key auto-expires in 10 minutes.

**What is stored internally:**
- `pendingKeys[senderJid]` = `{ key, expiresAt, senderNumber, senderName }`
- `approvalQueue[senderNumber]` = `senderJid`

---

### Step 2 — Creator Approves or Denies

**If creator types `/approve [number]`:**
- The key is delivered to the requester's DM.
- Creator receives a delivery confirmation.
- The key remains in `pendingKeys` — the requester still has to submit it.

**If creator types `/deny [number]`:**
- Key is deleted immediately from `pendingKeys` and `approvalQueue`.
- Requester receives a neutral rejection with no reason.
- Creator receives a void confirmation.

**If creator does nothing for 10 minutes:**
- `cleanExpiredKeys()` runs on every command received and removes the expired session automatically.
- Requester is not notified of expiry.

---

### Step 3 — Requester Submits the Key

Once they have the key (delivered via `/approve`), they type `/admin [UUID-key]`.

**Security checks in order:**
1. Is there a `pendingKeys[senderJid]` session? If not → "No active configuration session."
2. Has the session expired? If yes → "Session Expired." Session is deleted.
3. Does the JID match the session JID (the one who originally requested)? The key is bound to the requesting JID — someone else with the key cannot use it.
4. Is the key correct? If not → wrong attempt logged. After 3 wrong attempts → "Session Voided." Creator is notified. Session deleted.

**On correct key:**
- `settings.adminNumber` = the requester's phone number
- `settings.adminJid` = the requester's JID
- `settings.json` is saved to disk
- 30-day inactivity timer starts
- Requester DM: "Access Granted — Welcome, Administrator!"
- Creator DM: "Admin Registration Complete — Name, Number."
- Session is deleted from `pendingKeys` and `approvalQueue`

---

### The Edge Case — Admin Slot Already Set

If someone types `/admin` when an admin is already registered:

- **If the sender IS the registered admin:** They receive their help dashboard (same as `/help`).
- **If the sender is NOT the admin:** Rate limit is checked. If not locked, they receive: "This bot is already configured. Contact the group admin for assistance." No key is generated. The creator is not notified.

---

### Admin Inactivity Auto-Clear

Once the admin slot is filled, a timer runs every hour in the background. If 30 days pass without any admin or creator command being typed, the admin slot is auto-cleared:
- `settings.adminNumber` and `settings.adminJid` are set to empty string
- `settings.json` is saved
- Creator receives a DM: "Admin Slot Auto-Cleared — [number] has been inactive for 30 days."
- The bot returns to unconfigured state for the next onboarding request

The 30-day clock resets every time any `/` command is received from either the creator or the admin.

---

## Admin Commands — Full List

The admin has access to every setting command, every word pool command, and every game control command. The only commands the admin cannot run are the creator-exclusive ones: `/approve`, `/deny`, and anything the creator has overridden via `creatorOverrides`.

All admin command replies go to the admin's own DM. The group chat never sees a reply to any `/` command.

---

### `/admin` (when already admin)
Returns the help dashboard. Same as `/help` for admin.

---

### `/help`
Returns the full command dashboard with live config snapshot. Does NOT include the `/approve` and `/deny` section — those are creator-only and not shown to the admin.

---

### `/set difficulty [easy/normal/difficult]`
Changes difficulty. Reply: "Difficulty set to: 🟢 *EASY*" (or the chosen level).

**Important:** If the creator has already set a difficulty override via `creatorOverrides`, the admin's change goes to the root settings but the game still uses the creator's override. The admin cannot see that a creator override exists — they get a confirmation reply but the game ignores their setting. This is by design.

---

### `/set admin [number]` → `/confirm` → `/cancel`
Allows the admin to change the admin slot to a different number. This replaces themselves. The flow is identical to when the creator uses it — a confirmation step is required before the change applies.

**Note:** After `/confirm`, the old admin number is replaced. If the admin changes the slot to someone else, they lose admin access immediately.

---

### `/set public [on/off]`
Toggles public visibility. Blocked by creator override if the creator has set it.

---

### `/set start [on/off]`
Toggles whether the public can open lobbies. Blocked by creator override if set.

---

### `/set maxtries [number]`
Changes the attempt budget per player per round.

---

### `/clearadmin`
Clears the admin slot. The admin can clear their own slot. After this, the bot is unconfigured and onboarding starts fresh for the next request.

---

### `/reset`
Full factory reset. Clears everything. Admin loses access immediately after this command executes.

---

### Word Pool Commands: `/addword`, `/removeword`, `/listwords`, `/setwords`, `/clearwords`, `/setallwords`
Identical behaviour to when the creator uses them. Admin writes to the same shared word pools.

---

### `/status`
Returns the live game state in the admin's DM. If no game is active, shows the current config. If a lobby is open, shows time remaining and the player list. If a game is in progress, shows the current hidden word, whose turn it is, how many wrong guesses have been made, and whether the game is paused.

---

### `/pause`
Freezes the turn timer. The current player's 30-second countdown stops. The game board is not resent. The group chat receives: "Game paused by the admin. Sit tight — we'll be right back! ☕"

No guesses are accepted while paused. Admin DM receives: "Game paused ✅"

---

### `/resume`
Unfreezes the turn timer. The 30-second countdown restarts from 30 (not from where it was paused). The group chat receives: "Game resumed by the admin! Back in action — keep guessing! 🔥". Admin DM receives: "Game resumed ✅". The game board is not resent automatically.

---

### `/end` / `/stop`
Terminates the active game or lobby immediately. All timers are cleared. All player data is wiped. `activeGameChatRef` is set to null. The group chat receives: "Game terminated by the admin. Thanks for playing, everyone! 👋". Admin DM receives: "Game terminated ✅". No match report is sent.

---
---

# STAGE 3 — PARTICIPANTS, GAME COMMANDS, AND HOW CREATOR/ADMIN SETTINGS AFFECT THEM

## Who Participants Are

Any WhatsApp user who is not the creator and not the registered admin is a PUBLIC tier user. Their access to the bot depends entirely on two settings that the creator and admin control:

| Setting | Default | Who controls it | Effect on public |
|---|---|---|---|
| `publicVisible` | ON | Admin (creator can override) | OFF = total silence for all public messages |
| `publicCanStart` | OFF | Admin (creator can override) | OFF = public cannot type WRG to open a lobby |

If `publicVisible` is OFF, every message from a public user is silently dropped — no reply, no acknowledgement — **except** `/admin`, which always passes through so onboarding is never blocked even when the bot is locked down.

---

## Public User Commands

### `WRG` (all caps — exact match)
Opens a game lobby in the current chat.

**Gate 1 — publicCanStart:** If this is OFF and the user is not admin or creator, the bot replies: "Game Locked — the admin hasn't enabled public game starts." Nothing else happens.

**Gate 2 — Active game check:** If a game is already running anywhere (even in a different chat), the user gets "A game is currently running in another chat." The admin also receives a DM alerting them to the duplicate attempt.

**If both gates pass:**
- A 60-second lobby opens in the current chat
- The creator auto-joins immediately (always, unconditionally)
- The admin auto-joins immediately if they are a different person from the creator
- Auto-joined players are displayed with their role badge: "Might Awa (Creator) — Auto-joined 👑"
- The lobby open message shows the difficulty badge (which reflects the effective difficulty — creator override wins)
- `activeGameChatRef.value` is set to this chat — no other chat can start a game until this one ends

---

### `wrg` (lowercase — any variation of case except all-caps)
Triggers a ping/info response. Replies in the same chat with a bot identity message showing response time in milliseconds.

---

### `wrg join`
Joins the open lobby in the current chat.

**If no lobby is open:** "No active lobby to join! Type WRG (all caps) to start one."

**If already joined:** "You're already in the lobby! Sit tight."

**On successful join:**
- Player's number, name, and JID are added to `gameState.players`, `gameState.playerNames`, `gameState.playerJids`
- The group chat receives an updated lobby list showing all current players with role badges
- The player is shown as their name only (no badge unless they are creator or admin)

---

### `wrg start`
Force-starts the game immediately without waiting for the 60-second lobby timer.

**Gate:** Only players who have already joined the lobby, or the admin/creator, can trigger an early start. A random person in the group who has not joined cannot type `wrg start` to force the game.

**Effect:** `startActualGame()` runs immediately. The lobby timer is cancelled.

---

### `wrg help` or `wrg`
Returns the public-facing how-to-play guide in the current chat. Shows rules, commands, and how scoring works. No admin content is shown.

---

## How a Game Round Plays Out for Participants

### When the Lobby Closes (60 seconds or `wrg start`)

If no one joined except the auto-joined creator and admin, the game proceeds with just them. If the lobby has zero players (which only happens if creator and admin are the same person and they didn't join manually), the game is cancelled: "No one joined the lobby in time."

The game starts:
- Difficulty is read LIVE from settings at this exact moment — any last-minute `/set difficulty` change applies here
- A word is picked randomly from the appropriate pool
- If the admin-set pool for that difficulty is empty, the built-in DEFAULT_WORDS list is used as fallback
- `attempts`, `skipStreaks`, `disqualified` are all reset to zero
- The game board is sent to the group

---

### The Game Board

Sent to the group chat on every turn. Shows:
- Current hidden word state: `_ _ _ _ _` with revealed letters filled in
- Current difficulty badge
- Whose turn it is (with role badge if creator or admin)
- Who is next (with role badge)
- How many wrong guesses the current player has used vs their budget
- "You have 30 seconds" countdown reminder

---

### Turn Timer — 30 Seconds

After the board is sent, a 30-second countdown starts silently.

- At 20 seconds: Group chat gets a warning mentioning the current player by name
- At 10 seconds: Group chat gets an urgent warning
- At 0 seconds: Turn is skipped. Skip streak for the current player increases by 1.

The skip streak counter resets to 0 whenever a player makes any guess (letter or word), whether right or wrong.

---

### Letter Guess (single character)

Only the player whose turn it is can guess. If an admin who is not currently playing sends a letter guess while it is another player's turn, the admin's message is treated as the current player's guess (admin bypass — this allows admins to unstick a frozen round without using `/end`).

**Correct letter:**
- First unrevealed occurrence of that letter is revealed
- The player's skip streak resets
- Turn advances to the next player
- New board is sent
- If the word is fully revealed → victory: match report sent, game ends

**Wrong letter:**
- Player's `attempts` count increases by 1
- Feedback shows how many they have used vs their budget
- If attempts reach `maxTries` → player is disqualified for attempts exhausted
- Turn advances (even on disqualification)

---

### Full Word Guess

If a player types the entire target word exactly (lowercase, as it appears in the pool):

- Instant win — no further turns
- Group chat: "INSTANT WIN! [Name] guessed the full word [WORD]!"
- Match report sent immediately

---

### Disqualification Paths

**Path 1 — Skip streak reaches 3:**
After 3 consecutive missed turns (timeouts), the player is removed:
- Removed from `players`, `playerNames`, `playerJids`, `skipStreaks`, `attempts`
- Added to `disqualified` with reason "Skipped 3 turns in a row"
- Group chat notified

**Path 2 — Attempts exhausted:**
After using all `maxTries` wrong guesses:
- Same removal process
- Added to `disqualified` with reason "Used all wrong guesses"

**After any disqualification, three outcomes are checked:**

1. **One player remains:** Last player standing. Game ends. Match report sent with outcome type `last_standing`.
2. **Zero players remain:** Game over with no winner. Match report sent with outcome type `no_winner`.
3. **Multiple players remain:** Game continues. Turn index adjusts to stay in bounds.

---

### Match Report

Sent to the group chat at the end of every game. Contains:

- Outcome header (Match Complete / Game Over)
- Winner line (or No Winner)
- Full participant list — every player who joined, including those disqualified, showing their display name with role badge and their disqualification reason if applicable
- The revealed target word
- Match statistics: total players, total disqualified, winner count

All names in the match report use `nameTag(number, nameCache, settings)` — meaning creator and admin are shown as "Name (Creator)" and "Name (Admin)". Regular participants show just their name. If the name is not in the cache (new contact), it falls back to "Player".

---

## How Creator and Admin Settings Ripple Down to Participants

| Creator/Admin Action | Participant Experience |
|---|---|
| `/set difficulty easy` (creator) | Next game picks easy words regardless of admin's difficulty setting |
| `/set difficulty normal` (admin) | Next game picks normal words — unless creator has set an override |
| `/set maxtries 5` | Players now only get 5 wrong guesses before disqualification |
| `/set public off` | Public users become completely invisible to the bot — game commands ignored, no replies |
| `/set public on` | Public users can interact normally |
| `/set start off` (default) | Public cannot type WRG to open a lobby. Only admin/creator can |
| `/set start on` | Anyone can open a lobby |
| `/pause` | Turn timer freezes. Current player's countdown stops. No one can guess until resumed |
| `/resume` | Turn timer restarts at 30 seconds for the current player |
| `/end` or `/stop` | Game ends immediately. No winner, no report. All player data wiped |
| `/addword difficult algorithm` | Next difficult game has one more word in the pool to pick from |
| `/clearwords easy` (if other pools have words) | Easy games now use DEFAULT_WORDS fallback instead of custom pool |
| `/reset` | Everything resets. Any active game dies mid-round. Public returns to default (visible, cannot start) |

---

## Summary of the Hierarchy in Plain Terms

**Creator** is the permanent owner. Set in the environment, unrevokable, always detected. Can override any admin setting. Auto-joins every game. Gets every notification the admin gets, plus the key approval flow. Cannot be locked out.

**Admin** is the tenant operator. Set through the key onboarding flow, lasts 30 days of activity. Has full game and settings control within the bounds the creator has left open. If the creator overrides a setting, the admin's version of that setting is silently ignored. The admin can clear themselves and can be auto-cleared by inactivity.

**Participants** are the audience. Their entire experience is gated by two switches the admin and creator control. Within those gates, they play the game — join lobbies, guess letters, compete to be last standing. They have no visibility into admin commands and receive no replies to slash commands.
