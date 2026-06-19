// ============================================================
//  index.js — WRG Bot · Sky Graphics
//  Thin orchestrator: connection, message routing.
//  Game logic  → gameEngine.js
//  Admin logic → adminCommands.js
// ============================================================

require('dotenv').config()
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const matchSummary = require('./matchSummary')

const {
    DEFAULT_WORDS,
    getGameState,
    startLobbyCountdown,
    startActualGame,
    sendGameBoard,
    startTurnCountdown
} = require('./gameEngine')

const { handleAdminCommand } = require('./adminCommands')

// ─── Safe DM sender ───────────────────────────────────────
// WhatsApp lets you message a contact using EITHER their LID or their
// phone-number JID once a session exists between you (which is always
// true here — the creator/admin/requester has already messaged the bot
// before the bot ever needs to reply). No mapping table, no cache, no
// external store required — just normalize a bare number into a JID
// and send. If a live JID was already captured from an inbound message,
// pass that straight through unchanged.
async function sendSafeMessage(sock, jidOrNumber, payload) {
    const targetJid = jidOrNumber.includes('@') ? jidOrNumber : `${jidOrNumber}@s.whatsapp.net`
    try {
        const result = await sock.sendMessage(targetJid, payload)
        console.log(`[sendSafe] Sent to ${targetJid}:`, JSON.stringify(result?.key))
    } catch (err) {
        console.log(`[sendSafe] Send error to ${targetJid}:`, err.message)
    }
}

// ─── Persistent Settings ───────────────────────────────────
const SETTINGS_FILE = 'settings.json'
const WORDS_FILE = 'words.json'
const GAMES_FILE = 'games.json'

let settings = {
    adminNumber: '',
    adminJid: '',
    difficulty: 'easy',
    maxTries: 10,
    prefix: 'wrg',
    adminPrefix: '/',
    publicVisible: true,
    publicCanStart: false
}

let pendingAdminChangeRef = { value: null }  // { number }

if (fs.existsSync(SETTINGS_FILE)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE))
    if (typeof settings.adminJid === 'undefined') settings.adminJid = ''
    if (typeof settings.publicVisible === 'undefined') settings.publicVisible = true
    if (typeof settings.publicCanStart === 'undefined') {
        settings.publicCanStart = typeof settings.publicStart !== 'undefined' ? settings.publicStart : false
        delete settings.publicStart
    }
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

// ─── Name Cache ────────────────────────────────────────────
const NAMES_FILE = 'names.json'
let nameCache = {}
if (fs.existsSync(NAMES_FILE)) {
    nameCache = JSON.parse(fs.readFileSync(NAMES_FILE))
}

function rememberName(number, pushName) {
    if (!number || !pushName) return
    if (nameCache[number] !== pushName) {
        nameCache[number] = pushName
        fs.writeFileSync(NAMES_FILE, JSON.stringify(nameCache, null, 2))
    }
}

function displayName(number) {
    return nameCache[number] || number
}

function tag(number) {
    return `@${displayName(number)}`
}

function jidOf(number) {
    return `${number}@s.whatsapp.net`
}

// ─── Idempotency guard (in-memory — no external store needed) ──
// During WhatsApp's LID migration, the same message can occasionally
// arrive as two separate 'notify' events. This keeps a short-lived record
// of message IDs already handled so a single typed command can't trigger
// a command twice. Self-cleaning, bounded by the time window — not a
// persistent store, just a few minutes of recent message IDs in memory.
const recentlySeenIds = new Map() // msgId → timestamp
const DEDUP_WINDOW_MS = 2 * 60 * 1000

function isDuplicateMessage(msgId) {
    if (!msgId) return false
    const now = Date.now()
    for (const [id, ts] of recentlySeenIds) {
        if (now - ts > DEDUP_WINDOW_MS) recentlySeenIds.delete(id)
    }
    if (recentlySeenIds.has(msgId)) return true
    recentlySeenIds.set(msgId, now)
    return false
}

// ─── Word Pools ────────────────────────────────────────────
let words = JSON.parse(JSON.stringify(DEFAULT_WORDS))

function saveWords() {
    fs.writeFileSync(WORDS_FILE, JSON.stringify(words, null, 2))
}

if (fs.existsSync(WORDS_FILE)) {
    words = JSON.parse(fs.readFileSync(WORDS_FILE))
}

// ─── Game State ────────────────────────────────────────────
const games = {}
let activeGameChatRef = { value: null }  // wraps activeGameChat so modules can mutate it

function persistGames() {
    const serializable = {}
    for (const chatId in games) {
        const g = games[chatId]
        if (!g.active && !g.lobbyActive) continue
        const { lobbyTimer, turnTimer, ...rest } = g
        serializable[chatId] = rest
    }
    fs.writeFileSync(GAMES_FILE, JSON.stringify({ activeGameChat: activeGameChatRef.value, games: serializable }, null, 2))
}

function loadPersistedGames() {
    if (!fs.existsSync(GAMES_FILE)) return
    try {
        const data = JSON.parse(fs.readFileSync(GAMES_FILE))
        activeGameChatRef.value = data.activeGameChat || null
        for (const chatId in (data.games || {})) {
            games[chatId] = {
                ...data.games[chatId],
                lobbyTimer: null,
                turnTimer: null
            }
        }
    } catch (err) {
        console.log('⚠️ Could not load persisted game state (games.json may be corrupt). Starting fresh.', err.message)
    }
}

loadPersistedGames()

// Boot flag — prevents spamming admin DM on Baileys internal reconnects
let hasSentBootAdminConfirmation = false

// ─── Shared engine context builder ─────────────────────────
function buildCtx(sock) {
    return {
        sock,
        games,
        settings,
        words,
        activeGameChatRef,
        persistGames,
        jidOf,
        tag,
        DEFAULT_WORDS
    }
}

// ─── Main Bot ──────────────────────────────────────────────
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        getMessage: async () => ({ conversation: '' })
    })

    sock.ev.on('creds.update', saveCreds)

    // ─── Connection Handler ─────────────────────────────────
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('📱 Scan this QR code with WhatsApp:')
            qrcode.generate(qr, { small: true })
            console.log('\n🔗 OR click this link to scan in your browser:')
            console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}\n`)
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut
            if (shouldReconnect) {
                console.log('🔁 Connection closed. Restarting and generating a fresh QR...')
                startBot()
            } else {
                console.log('🚪 Logged out. Delete the auth_info folder and restart to link a new device.')
            }
        }

        if (connection === 'open') {
            console.log('✅ WRG Bot is connected! 🎮')

            // Boot confirmation DM to admin (once per process)
            if (!hasSentBootAdminConfirmation) {
                hasSentBootAdminConfirmation = true
                const bootTarget = settings.adminJid || settings.adminNumber
                if (bootTarget) {
                    try {
                        await sendSafeMessage(sock, bootTarget, {
                            text:
                                `🔁 *WRG Bot is back online!* ✅\n\n` +
                                `👑 You're registered as admin (${settings.adminNumber}).\n\n` +
                                `Type */help* at any time to see all your commands.\n\n` +
                                `_WRG Bot · by Sky Graphics_ 🎨`
                        })
                        console.log(`👑 Sent boot confirmation DM to admin ${bootTarget}`)
                    } catch (err) {
                        console.log('⚠️ Could not DM the admin on boot:', err.message)
                    }
                } else {
                    console.log('ℹ️ No admin set yet. Someone must type /admin to begin onboarding.')
                }
            }

            // Recover active game/lobby after restart
            if (activeGameChatRef.value && games[activeGameChatRef.value]) {
                const gs = games[activeGameChatRef.value]
                const ctx = buildCtx(sock)
                if (gs.lobbyActive) {
                    await sock.sendMessage(activeGameChatRef.value, {
                        text: `🔁 *Bot restarted.* Resuming the lobby countdown (${gs.lobbySecondsLeft}s left). Type *wrg join* if you haven't! ⏱️`
                    })
                    startLobbyCountdown(activeGameChatRef.value, ctx)
                } else if (gs.active && !gs.paused) {
                    await sock.sendMessage(activeGameChatRef.value, {
                        text: `🔁 *Bot restarted.* Resuming the in-progress round. 🎮`
                    })
                    await sendGameBoard(activeGameChatRef.value, '🔁 *Round recovered after a restart.*', [], ctx)
                } else if (gs.active && gs.paused) {
                    await sock.sendMessage(activeGameChatRef.value, {
                        text: `🔁 *Bot restarted.* The round is still paused — an admin must type */resume* to continue. ⏸️`
                    })
                }
            }
        }
    })

    // ─── Message Handler ────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            if (!msg.message) continue

            // Skip if this exact message was already processed (see
            // isDuplicateMessage above)
            if (isDuplicateMessage(msg.key?.id)) {
                console.log(`[dedup] Skipping duplicate delivery of message: ${msg.key.id}`)
                continue
            }

            const from = msg.key.remoteJid
            if (from === 'status@broadcast') continue

            const text =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption ||
                ''
            const body = text.trim().toLowerCase()
            const rawBody = text.trim()

            const sender = msg.key.participant || msg.key.remoteJid || ''
            const senderNumber = msg.key.senderPn
                ? msg.key.senderPn.split('@')[0].split(':')[0]
                : sender.split('@')[0].split(':')[0]

            const senderName = msg.pushName || senderNumber
            rememberName(senderNumber, msg.pushName)

            const isAdmin = msg.key.fromMe || senderNumber === settings.adminNumber || settings.adminNumber === ''

            if (!isAdmin && !settings.publicVisible) continue

            // Refresh admin name + JID on every message from admin
            if (senderNumber === settings.adminNumber) {
                if (msg.pushName) rememberName(settings.adminNumber, msg.pushName)
                if (sender && sender !== settings.adminJid) {
                    settings.adminJid = sender
                    saveSettings()
                    console.log(`[admin] Updated adminJid to: ${settings.adminJid}`)
                }
            }

            // ── / Commands ──────────────────────────────────
            if (body.startsWith(settings.adminPrefix)) {
                const ctx = {
                    ...buildCtx(sock),
                    pendingAdminChangeRef,
                    saveSettings,
                    saveWords,
                    sendSafeMessage,
                    getGameState: (chatId) => getGameState(chatId, games, settings),
                    startTurnCountdown: (chatId) => startTurnCountdown(chatId, buildCtx(sock)),
                    fs,
                    senderNumber,
                    senderName,
                    senderJid: sender,
                    sender: from,
                    body,
                    isAdmin
                }
                await handleAdminCommand(ctx)
                continue
            }

            // ── WRG (all caps) = start lobby ────────────────
            const isAllCapsWRG = rawBody === 'WRG'
            const isMixedWRG = !isAllCapsWRG && rawBody.toUpperCase() === 'WRG'

            if (isMixedWRG) {
                const pingStart = Date.now()
                await sock.sendMessage(from, { text: 'Ping! 🏓' })
                await sock.sendMessage(from, { text: 'Pong! 🏓' })
                await sock.sendMessage(from, { text: 'Ping! 🏓' })
                await sock.sendMessage(from, { text: 'Pong! 🏓' })
                const pingMs = Date.now() - pingStart
                await sock.sendMessage(from, { text: `🤖 *WRG Bot* | Response time: *${pingMs}ms*` })

                await sock.sendMessage(from, {
                    text:
                        `━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `🎮 *Word Riddle Game Bot*\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `Hey there! 👋 I'm the *WRG Bot* — a live multiplayer word-guessing game built for WhatsApp groups.\n\n` +
                        `Players take turns guessing letters to reveal a hidden word. Miss 3 turns in a row and you're out! The last one standing wins. 🏆\n\n` +
                        `_Created with ❤️ by_ *_Sky Graphics_* 🎨\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `*🎮 How to Play:*\n\n` +
                        `1️⃣ Type *WRG* (all caps) to open a game lobby\n` +
                        `2️⃣ Type *wrg join* to enter the lobby\n` +
                        `3️⃣ Lobby closes after 60 seconds — game begins automatically!\n` +
                        `4️⃣ On your turn, type a *single letter* to guess, or the *full word* to win instantly\n` +
                        `5️⃣ Miss *3 turns in a row* and you're disqualified 🚫\n` +
                        `6️⃣ Last player standing wins! 🏆`
                })
                continue
            }

            if (isAllCapsWRG) {
                if (!isAdmin && !settings.publicCanStart) {
                    await sock.sendMessage(from, {
                        text: `🔒 *Game Locked*\nThe admin hasn't enabled public game starts. Only the admin can open a lobby right now.`
                    })
                    continue
                }

                if (activeGameChatRef.value) {
                    await sock.sendMessage(from, {
                        text: activeGameChatRef.value === from
                            ? `⚠️ A game or lobby is *already active in this chat!* ⏳`
                            : `⚠️ A game is currently running in another chat. It must end before a new one can start.`
                    })
                    continue
                }

                const gameState = getGameState(from, games, settings)
                gameState.lobbyActive = true
                gameState.lobbySecondsLeft = 60
                gameState.players = []
                gameState.playerNames = {}
                gameState.skipStreaks = {}
                gameState.disqualified = []

                // Admin auto-joins
                if (settings.adminNumber) {
                    gameState.players.push(settings.adminNumber)
                    gameState.playerNames[settings.adminNumber] = displayName(settings.adminNumber)
                }

                const adminMentionJid = settings.adminJid || (settings.adminNumber ? jidOf(settings.adminNumber) : null)
                const adminMention = adminMentionJid ? [adminMentionJid] : []
                const adminDisplayName = settings.adminNumber ? (gameState.playerNames[settings.adminNumber] || settings.adminNumber) : ''
                const adminLobbyText = settings.adminNumber
                    ? `1. @${settings.adminNumber} (${adminDisplayName}) — Auto-joined 👑`
                    : '[No players yet — be first! 🎯]'

                await sock.sendMessage(from, {
                    text:
                        `🎮 *Word Riddle Game is Starting!*\n\n` +
                        `You have *60 seconds* to type *wrg join* and enter the game! ⏱️\n\n` +
                        `👥 *Current Lobby:*\n${adminLobbyText}\n\n` +
                        `_Type *wrg join* now before time runs out!_ 🔥`,
                    mentions: adminMention
                })

                activeGameChatRef.value = from
                persistGames()
                startLobbyCountdown(from, buildCtx(sock))
                continue
            }

            // ── wrg join / wrg start / wrg help ─────────────
            if (body.startsWith(settings.prefix)) {
                const parts = body.split(' ')
                const subCmd = parts[1]
                const gameState = getGameState(from, games, settings)

                if (subCmd === 'join') {
                    if (!gameState.lobbyActive) {
                        await sock.sendMessage(from, {
                            text: `⚠️ No active lobby to join! Type *WRG* (all caps) to start one. 🎮`
                        })
                        continue
                    }
                    if (!gameState.players.includes(senderNumber)) {
                        gameState.players.push(senderNumber)
                        gameState.playerNames[senderNumber] = senderName

                        const lobbyMentions = gameState.players.map(num => jidOf(num))
                        const lobbyText = gameState.players
                            .map((num, i) => `${i + 1}. @${num} (${gameState.playerNames[num] || num})`)
                            .join('\n')

                        await sock.sendMessage(from, {
                            text:
                                `✅ *@${senderNumber} (${senderName}) joined the lobby!* 🎉\n\n` +
                                `👥 *Current Lobby:*\n${lobbyText}\n\n` +
                                `_Type *wrg join* to hop in!_ ⏱️`,
                            mentions: [...new Set([jidOf(senderNumber), ...lobbyMentions])]
                        })
                        persistGames()
                    } else {
                        await sock.sendMessage(from, {
                            text: `⚠️ You're already in the lobby! Sit tight — the game is starting soon. 🕐`
                        })
                    }
                    continue
                }

                if (subCmd === 'start') {
                    if (!gameState.lobbyActive) {
                        await sock.sendMessage(from, {
                            text: `⚠️ No active lobby! Type *WRG* to open one. 🎮`
                        })
                        continue
                    }
                    if (gameState.players.includes(senderNumber) || isAdmin) {
                        await startActualGame(from, buildCtx(sock))
                    }
                    continue
                }

                if (!subCmd || subCmd === 'help') {
                    await sock.sendMessage(from, {
                        text:
                            `🎮 *Welcome to Word Riddle Game (WRG)!*\n\n` +
                            `*How to play:*\n` +
                            `1️⃣ Type *WRG* (all caps) to open a game lobby\n` +
                            `2️⃣ Type *wrg join* to enter the lobby\n` +
                            `3️⃣ Once the timer hits zero, the game begins automatically!\n` +
                            `4️⃣ On your turn, type a *single letter* to guess it, or the *full word* to win instantly ⚡\n` +
                            `5️⃣ Miss *3 turns in a row* and you're disqualified 🚫\n` +
                            `6️⃣ Last player standing wins! 🏆\n\n` +
                            `_Created with ❤️ by Sky Graphics_ 🎨`
                    })
                    continue
                }
            }

            // ── Active game play ────────────────────────────
            const gameState = getGameState(from, games, settings)
            if (gameState.active && !gameState.paused) {
                const currentPlayerNumber = gameState.players[gameState.currentTurnIndex]
                const isPlayerTurn = senderNumber === currentPlayerNumber
                const isAdminBypass = isAdmin && !gameState.players.includes(senderNumber)

                if (isPlayerTurn || isAdminBypass) {
                    gameState.skipStreaks[currentPlayerNumber] = 0

                    if (body.length === 1) {
                        // Letter guess
                        let foundIndex = -1
                        for (let i = 0; i < gameState.targetWord.length; i++) {
                            if (gameState.targetWord[i] === body && gameState.hiddenWord[i] === '_') {
                                foundIndex = i
                                break
                            }
                        }

                        if (gameState.turnTimer) clearInterval(gameState.turnTimer)

                        if (foundIndex !== -1) {
                            gameState.hiddenWord[foundIndex] = body

                            if (!gameState.hiddenWord.includes('_')) {
                                // Victory!
                                gameState.active = false
                                activeGameChatRef.value = null
                                await sock.sendMessage(from, {
                                    text: `🎉 *VICTORY!* The word was *${gameState.targetWord.toUpperCase()}*! Well done! 🏆`
                                })
                                await matchSummary.sendMatchReport(sock, from, gameState, { type: 'winner_letter', winnerNumber: senderNumber }, tag)
                                gameState.players = []
                                persistGames()
                            } else {
                                const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
                                gameState.currentTurnIndex = nextTurnIndex

                                const feedback =
                                    `✅ *Correct!*\n` +
                                    `${tag(senderNumber)} guessed *${body.toUpperCase()}* and revealed the first occurrence! 🟢`
                                await sendGameBoard(from, feedback, [jidOf(senderNumber)], buildCtx(sock))
                            }
                        } else {
                            // Wrong letter
                            gameState.attempts++
                            const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
                            gameState.currentTurnIndex = nextTurnIndex

                            const feedback =
                                `❌ *Wrong guess!*\n` +
                                `${tag(senderNumber)} guessed *${body.toUpperCase()}* — not in the word. 🔴`

                            if (gameState.attempts >= settings.maxTries) {
                                gameState.active = false
                                activeGameChatRef.value = null
                                await sock.sendMessage(from, {
                                    text: `${feedback}\n\n💀 *GAME OVER!* Attempts exhausted. The word was *${gameState.targetWord.toUpperCase()}*.`
                                })
                                await matchSummary.sendMatchReport(sock, from, gameState, { type: 'no_winner' }, tag)
                                gameState.players = []
                                persistGames()
                            } else {
                                await sendGameBoard(from, feedback, [], buildCtx(sock))
                            }
                        }
                    } else if (body === gameState.targetWord) {
                        // Full word guess = instant win
                        if (gameState.turnTimer) clearInterval(gameState.turnTimer)
                        gameState.active = false
                        activeGameChatRef.value = null
                        await sock.sendMessage(from, {
                            text: `⚡ *INSTANT WIN!* ${tag(senderNumber)} guessed the full word *${gameState.targetWord.toUpperCase()}*! Incredible! 🎉🏆`
                        })
                        await matchSummary.sendMatchReport(sock, from, gameState, { type: 'winner_instant', winnerNumber: senderNumber }, tag)
                        gameState.players = []
                        persistGames()
                    }
                }
            }
        }
    })
}

startBot()
