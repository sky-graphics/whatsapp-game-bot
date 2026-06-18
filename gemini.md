# GEMINI AGENT BRIEFING — WhatsApp Game Bot Project
**Owner:** Strength Awa  
**Date updated:** June 18, 2026  
**Purpose:** Handoff and instruction document for the Gemini agent to manage, modify, and deploy the WhatsApp Game Bot.

---

## 🎮 CURRENT GAME LOGIC: Word Riddle Game (WRG)
The bot currently runs a word-guessing game called **Word Riddle Game (WRG)** in WhatsApp chats. 

### Core Mechanics
*   **Settings Persistence:** Configurations are saved in `settings.json` (admin number, difficulty, max tries, prefixes).
*   **Difficulty levels:**
    *   `easy`: 5-letter words (e.g., apple, cloud, dance).
    *   `hard`: longer tech-related words (e.g., algorithm, blockchain, cryptography).
*   **Game Commands (prefixed with `wrg`):**
    *   `wrg` or `wrg help`: Display how to play.
    *   `wrg join`: Add the player to the lobby.
    *   `wrg easy` or `wrg hard`: Change the difficulty.
    *   `wrg start`: Pick a random word from the chosen pool, show it as hidden letters (e.g., `_ _ _ _ _`), and start the guessing round.
    *   `wrg end`: Forcefully end the active game and clear the player list.
*   **Guessing Rules:**
    *   When a game is active, registered players (or the admin) can guess.
    *   Guessing a **single letter** reveals all occurrences of that letter if correct.
    *   Guessing the **exact word** wins the game instantly.
*   **Admin Commands (prefixed with `/`):**
    *   `/help`: View admin tools.
    *   `/set difficulty [easy/hard]`: Set game difficulty.
    *   `/set admin [number]`: Set the admin WhatsApp ID.
    *   `/reset`: Reset configurations.

---

## 🛠️ AGENT COMMAND PROTOCOLS

### 1. The `continue` Command
When the user types `continue`, the agent **must**:
1. Read the [progress.md](file:///C:/Users/Strength Awa/Desktop/BUSINESS/whatsapp-game-bot/progress.md) file in the workspace root.
2. Determine the exact point where work stopped, including current errors, tasks in progress, and planned steps.
3. Automatically resume the next logical task without asking the user for introductory questions.
4. **Important:** The agent must update [progress.md](file:///C:/Users/Strength Awa/Desktop/BUSINESS/whatsapp-game-bot/progress.md) at the end of every response to document the latest work state.

### 2. The `restart` Command
When the user types `restart` or requests a restart, the agent **must**:
1. Check for and kill any background tasks running `node index.js` using the `manage_task` tool.
2. Delete the `auth_info/` directory to clear any cached sessions.
3. Start a new background process executing `node index.js` via `run_command`.
4. Wait for the terminal output containing the QR code.
5. Capture and print the QR code in the chat terminal, explaining clear instructions on how the user should scan it.

---

## 📂 PROJECT FILE LISTING
```
whatsapp-game-bot/
├── auth_info/           ← generated local WhatsApp login credentials (DO NOT commit)
├── node_modules/        ← Node dependency folder (DO NOT commit)
├── .gitignore           ← ignores auth_info and node_modules
├── index.js             ← main entry point and game client logic
├── package.json         ← project dependencies and run scripts
├── package-lock.json    ← package lockfile
├── progress.md          ← detailed progress-tracking state
├── Procfile             ← worker definition for Railway deployment
└── settings.json        ← persistent game settings (difficulty, admin, etc.)
```

---

## 🚀 DEPLOYMENT & HOSTING (Railway.app)
1. Commit and push all code changes to GitHub.
2. Log in to [railway.app](https://railway.app) using GitHub.
3. Link the repository, set start command to `node index.js`.
4. Add a persistent Volume mounted at `/app/auth_info` to keep the WhatsApp session logged in permanently across redeployments.
