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

const {
    getTier, nameTag, difficultyBadge, TIERS
} = require('./permissions')

const { handleAdminCommand } = require('./adminCommands')

// ─── Safe DM sender ───────────────────────────────────────
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
const WORDS_FILE    = 'words.json'
const GAMES_FILE    = 'games.json'

let settings = {
    adminNumber:    '',
    adminJid:       '',
    difficulty:     'easy',
    maxTries:       10,
    prefix:         'wrg',
    adminPrefix:    '/',
    publicVisible:  true,
    publicCanStart: false
}

let pendingAdminChangeRef = { value: null }

if (fs.existsSync(SETTINGS_FILE)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE))
    if (typeof settings.adminJid        === 'undefined') settings.adminJid        = ''
    if (typeof settings.publicVisible   === 'undefined') settings.publicVisible   = true
    if (typeof settings.publicCanStart  === 'undefined') {
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

function jidOf(number) {
    if (!number) return ''
    if (number.includes('@')) return number
    return `${number}@s.whatsapp.net`
}

function resolveJid(number, playerJids) {
    if (!number) return ''
    if (number.includes('@')) return number
    return (playerJids && playerJids[number]) || `${number}@s.whatsapp.net`
}

// ─── LID → PN cache ───────────────────────────────────────
// WhatsApp now routes many messages via internal LIDs (e.g. 187733758767332@lid)
// instead of real phone-number JIDs. This cache maps each LID to its real PN
// so we never display or store a LID as if it were a phone number.
// Persisted to lidcache.json so resolutions survive bot restarts.
const LID_CACHE_FILE = 'lidcache.json'
let lidCache = {}
if (fs.existsSync(LID_CACHE_FILE)) {
    try { lidCache = JSON.parse(fs.readFileSync(LID_CACHE_FILE)) } catch (_) {}
}

function saveLidCache() {
    fs.writeFileSync(LID_CACHE_FILE, JSON.stringify(lidCache, null, 2))
}

// Resolves a LID to a real phone number.
// First checks the local cache; if not found, queries WhatsApp servers via
// sock.onWhatsApp() which always returns the real PN for any valid account.
// Returns the plain PN string (e.g. "237682477421") or '' if unresolvable.
async function resolvelidToPN(sock, lid) {
    if (!lid || !lid.includes('@lid')) return ''

    // Check cache first
    if (lidCache[lid]) {
        console.log(`[lid] Cache hit: ${lid} → ${lidCache[lid]}`)
        return lidCache[lid]
    }

    // Query WhatsApp servers
    try {
        const results = await sock.onWhatsApp(lid)
        if (results && results.length > 0) {
            // onWhatsApp returns [{ jid, exists, ... }]
            // The jid field is the real @s.whatsapp.net JID — strip domain to get PN
            const realJid = results[0].jid || ''
            const realPN  = realJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
            if (realPN) {
                lidCache[lid] = realPN
                saveLidCache()
                console.log(`[lid] Resolved: ${lid} → ${realPN}`)
                return realPN
            }
        }
    } catch (err) {
        console.log(`[lid] Could not resolve ${lid}:`, err.message)
    }
    return ''
}

// ─── Idempotency guard ─────────────────────────────────────
const recentlySeenIds  = new Map()
const DEDUP_WINDOW_MS  = 2 * 60 * 1000

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
let activeGameChatRef = { value: null }

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
                turnTimer:  null
            }
        }
    } catch (err) {
        console.log('⚠️ Could not load persisted game state (games.json may be corrupt). Starting fresh.', err.message)
    }
}

loadPersistedGames()

let hasSentBootAdminConfirmation = false

// ─── Shared engine context builder ─────────────────────────
// FIX BUG-05: nameCache is now included so gameEngine.startTurnCountdown
// can use it for player name display during turn warnings.
// FIX BUG-05: removed jidOf and tag — gameEngine uses nameTag from permissions.js
function buildCtx(sock) {
    return {
        sock,
        games,
        settings,
        words,
        activeGameChatRef,
        persistGames,
        nameCache,
        DEFAULT_WORDS
    }
}

// ─── Main Bot ──────────────────────────────────────────────
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')

    const sock = makeWASocket({
        auth:                state,
        printQRInTerminal:   false,
        getMessage:          async () => ({ conversation: '' })
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
            const statusCode      = new Boom(lastDisconnect?.error)?.output?.statusCode
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

            // FIX BUG-09: boot DM to creator as well as admin
            if (!hasSentBootAdminConfirmation) {
                hasSentBootAdminConfirmation = true
                const creatorJid = process.env.CREATOR_JID || ''

                // Always notify creator
                if (creatorJid) {
                    try {
                        await sendSafeMessage(sock, creatorJid, {
                            text:
                                `🔁 *WRG Bot is back online!* ✅\n\n` +
                                `👑 You're the *Creator* (unrestricted access).\n\n` +
                                `Type */help* to open your full dashboard.\n\n` +
                                `_WRG Bot · by Sky Graphics_ 🎨`
                        })
                        console.log(`🔐 Sent boot DM to creator`)
                    } catch (err) {
                        console.log('⚠️ Could not DM creator on boot:', err.message)
                    }
                }

                // Also notify admin if set and different from creator
                const bootTarget = settings.adminJid || settings.adminNumber
                const creatorNum = creatorJid.split('@')[0].split(':')[0]
                if (bootTarget && settings.adminNumber !== creatorNum) {
                    try {
                        await sendSafeMessage(sock, bootTarget, {
                            text:
                                `🔁 *WRG Bot is back online!* ✅\n\n` +
                                `👑 You're registered as admin (${settings.adminNumber}).\n\n` +
                                `Type */help* at any time to see all your commands.\n\n` +
                                `_WRG Bot · by Sky Graphics_ 🎨`
                        })
                        console.log(`👑 Sent boot DM to admin ${bootTarget}`)
                    } catch (err) {
                        console.log('⚠️ Could not DM admin on boot:', err.message)
                    }
                } else if (!bootTarget && !creatorJid) {
                    console.log('ℹ️ No admin set yet. Someone must type /admin to begin onboarding.')
                }
            }

            // Recover active game/lobby after restart
            if (activeGameChatRef.value && games[activeGameChatRef.value]) {
                const gs  = games[activeGameChatRef.value]
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

            if (isDuplicateMessage(msg.key?.id)) {
                console.log(`[dedup] Skipping duplicate: ${msg.key.id}`)
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
            const body    = text.trim().toLowerCase()
            const rawBody = text.trim()

            const sender = msg.key.participant || msg.key.remoteJid || ''

            // ── senderNumber resolution ──────────────────────
            // Rule: senderNumber must ALWAYS be a real phone number
            // (country code + digits, e.g. "237682477421").
            // A LID like "187733758767332" is NOT a phone number and must
            // never be stored, displayed, or used as one.
            //
            // Priority 1 — senderPn: Baileys' explicit PN field. Always real.
            // Priority 2 — fromMe: this is the bot's own account = creator.
            //              Use CREATOR_JID so the number is always correct.
            // Priority 3 — sender is a normal @s.whatsapp.net JID: strip domain.
            // Priority 4 — sender is a @lid: look up real PN via cache or
            //              sock.onWhatsApp() which queries WhatsApp's servers.
            //              If unresolvable, skip this message entirely.
            let senderNumber
            if (msg.key.senderPn) {
                // Most reliable — Baileys populated the real PN directly
                senderNumber = msg.key.senderPn.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
            } else if (msg.key.fromMe) {
                // Message is from the bot's own account = always the creator
                const creatorJid = process.env.CREATOR_JID || ''
                senderNumber = creatorJid
                    ? creatorJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
                    : ''
            } else if (sender && !sender.includes('@lid')) {
                // Normal @s.whatsapp.net JID — number is in the JID itself
                senderNumber = sender.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
            } else if (sender && sender.includes('@lid')) {
                // LID — resolve to real PN via cache or WhatsApp server query
                senderNumber = await resolvelidToPN(sock, sender)
                if (!senderNumber) {
                    // Could not resolve — skip this message entirely.
                    // Do NOT use LID digits as a phone number.
                    console.log(`[lid] Skipping message — could not resolve LID: ${sender}`)
                    continue
                }
            } else {
                // No sender info at all — skip
                console.log('[senderNumber] No sender info — skipping message')
                continue
            }

            // Final guard: if after all resolution senderNumber contains
            // non-digit characters or is empty, skip — never display garbage.
            if (!senderNumber || !/^[0-9]{7,15}$/.test(senderNumber)) {
                console.log(`[senderNumber] Invalid PN resolved: "${senderNumber}" — skipping`)
                continue
            }

            // ── senderJid: the JID to DM this sender ─────────
            const senderJid = msg.key.fromMe
                ? (process.env.CREATOR_JID || (senderNumber ? `${senderNumber}@s.whatsapp.net` : sender))
                : (msg.key.participant || sender)

            const senderName = msg.pushName || senderNumber
            rememberName(senderNumber, msg.pushName)

            // FIX BUG-01 + BUG-02: compute tier via getTier so permissions.js is the
            // single source of truth. senderTier replaces the old inline isAdmin check.
            const senderTier   = getTier(senderNumber, settings, senderJid)
            const isAdmin      = senderTier === TIERS.CREATOR || senderTier === TIERS.ADMIN

            // Non-admins invisible unless publicVisible is on —
            // EXCEPT slash-commands (always reach adminCommands for onboarding)
            if (!isAdmin && !settings.publicVisible && !body.startsWith(settings.adminPrefix)) continue

            // Refresh admin JID on every inbound admin message
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
                    // FIX BUG-03: correct 2-arg signature
                    getGameState: (chatId, g) => getGameState(chatId, g || games),
                    // FIX BUG-12: pass full ctx so resume works
                    startTurnCountdown: (chatId, overrideCtx) => startTurnCountdown(chatId, overrideCtx || buildCtx(sock)),
                    DEFAULT_WORDS,
                    fs,
                    senderNumber,
                    senderName,
                    senderJid,
                    sender: from,
                    body,
                    isAdmin,
                    // FIX BUG-01: senderTier is now always defined here
                    senderTier
                }
                await handleAdminCommand(ctx)
                continue
            }

            // ── WRG (all caps) = start lobby ────────────────
            const isAllCapsWRG = rawBody === 'WRG'
            const isMixedWRG   = !isAllCapsWRG && rawBody.toUpperCase() === 'WRG'

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
                    if (activeGameChatRef.value === from) {
                        await sock.sendMessage(from, {
                            text: `⚠️ A game or lobby is *already active in this chat!* ⏳`
                        })
                    } else {
                        await sock.sendMessage(from, {
                            text: `⚠️ A game is currently running in another chat. It must end before a new one can start.`
                        })
                        const adminTarget = settings.adminJid || settings.adminNumber
                        if (adminTarget) {
                            try {
                                await sendSafeMessage(sock, adminTarget, {
                                    text:
                                        `⚠️ *Duplicate Game Attempt*\n\n` +
                                        `Someone tried to start a game in *${from}* while a game is already active in *${activeGameChatRef.value}*.\n\n` +
                                        `Use */end* to stop the current game if needed. 🎮`
                                })
                            } catch (_) {}
                        }
                    }
                    continue
                }

                // FIX BUG-03: 2-arg call
                const gameState = getGameState(from, games)
                gameState.lobbyActive     = true
                gameState.lobbySecondsLeft = 60
                gameState.players         = []
                gameState.playerNames     = {}
                gameState.playerJids      = {}
                gameState.skipStreaks     = {}
                gameState.disqualified    = []

                // Creator always auto-joins
                const creatorEnvJid = process.env.CREATOR_JID || ''
                const creatorNum    = creatorEnvJid ? creatorEnvJid.split('@')[0].split(':')[0] : ''
                if (creatorNum && !gameState.players.includes(creatorNum)) {
                    gameState.players.push(creatorNum)
                    gameState.playerNames[creatorNum] = nameCache[creatorNum] || 'Creator'
                    gameState.playerJids[creatorNum]  = creatorEnvJid
                }
                // Admin also auto-joins if different from creator
                if (settings.adminNumber && settings.adminNumber !== creatorNum && !gameState.players.includes(settings.adminNumber)) {
                    gameState.players.push(settings.adminNumber)
                    gameState.playerNames[settings.adminNumber] = nameCache[settings.adminNumber] || 'Admin'
                    gameState.playerJids[settings.adminNumber]  = settings.adminJid || `${settings.adminNumber}@s.whatsapp.net`
                }
                const autoJoinMentions = gameState.players.map(num => gameState.playerJids[num] || jidOf(num))

                // FIX BUG-07: use nameTag for auto-join display
                const autoJoinText = gameState.players.length > 0
                    ? gameState.players.map((num, i) => `${i + 1}. ${nameTag(num, nameCache, settings)} — Auto-joined 👑`).join('\n')
                    : '[No players yet — be first! 🎯]'

                const difficulty = settings.difficulty || 'easy'
                await sock.sendMessage(from, {
                    text:
                        `🎮 *Word Riddle Game is Starting!*\n\n` +
                        `🎯 Mode: ${difficultyBadge(difficulty)}\n\n` +
                        `You have *60 seconds* to type *wrg join* and enter the game! ⏱️\n\n` +
                        `👥 *Current Lobby:*\n${autoJoinText}\n\n` +
                        `_Type *wrg join* now before time runs out!_ 🔥`,
                    mentions: autoJoinMentions
                })

                activeGameChatRef.value = from
                persistGames()
                startLobbyCountdown(from, buildCtx(sock))
                continue
            }

            // ── wrg join / wrg start / wrg help ─────────────
            if (body.startsWith(settings.prefix)) {
                const parts   = body.split(' ')
                const subCmd  = parts[1]
                // FIX BUG-03: 2-arg call
                const gameState = getGameState(from, games)

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
                        gameState.playerJids[senderNumber]  = senderJid

                        const lobbyMentions = gameState.players.map(num => resolveJid(num, gameState.playerJids))
                        const lobbyText     = gameState.players
                            .map((num, i) => `${i + 1}. ${nameTag(num, gameState.playerNames, settings)}`)
                            .join('\n')

                        // FIX BUG-06: use nameTag for join message
                        await sock.sendMessage(from, {
                            text:
                                `✅ *${nameTag(senderNumber, nameCache, settings)} joined the lobby!* 🎉\n\n` +
                                `👥 *Current Lobby:*\n${lobbyText}\n\n` +
                                `_Type *wrg join* to hop in!_ ⏱️`,
                            mentions: [...new Set([resolveJid(senderNumber, gameState.playerJids), ...lobbyMentions])]
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
            // FIX BUG-03: 2-arg call
            const gameState = getGameState(from, games)
            if (gameState.active && !gameState.paused) {
                const currentPlayerNumber = gameState.players[gameState.currentTurnIndex]
                const isPlayerTurn        = senderNumber === currentPlayerNumber
                const isAdminBypass       = isAdmin && !gameState.players.includes(senderNumber)

                if (isPlayerTurn || isAdminBypass) {
                    gameState.skipStreaks[currentPlayerNumber] = 0

                    if (body.length === 1) {
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
                                gameState.active        = false
                                activeGameChatRef.value = null
                                await sock.sendMessage(from, {
                                    text: `🎉 *VICTORY!* The word was *${gameState.targetWord.toUpperCase()}*! Well done! 🏆`
                                })
                                // FIX BUG-08: pass nameTag lambda so match report shows role badges
                                await matchSummary.sendMatchReport(
                                    sock, from, gameState,
                                    { type: 'winner_letter', winnerNumber: senderNumber },
                                    (n) => nameTag(n, nameCache, settings)
                                )
                                gameState.players = []
                                persistGames()
                            } else {
                                const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
                                gameState.currentTurnIndex = nextTurnIndex

                                // FIX BUG-04: use nameTag not tag()
                                const feedback =
                                    `✅ *Correct!*\n` +
                                    `${nameTag(senderNumber, nameCache, settings)} guessed *${body.toUpperCase()}* and revealed the first occurrence! 🟢`
                                await sendGameBoard(from, feedback, [resolveJid(senderNumber, gameState.playerJids)], buildCtx(sock))
                            }
                        } else {
                            gameState.attempts[currentPlayerNumber] = (gameState.attempts[currentPlayerNumber] || 0) + 1

                            // FIX BUG-04: use nameTag not tag()
                            const feedback =
                                `❌ *Wrong guess!*\n` +
                                `${nameTag(senderNumber, nameCache, settings)} guessed *${body.toUpperCase()}* — not in the word. 🔴\n` +
                                `_(${gameState.attempts[currentPlayerNumber]}/${settings.maxTries} wrong guesses for this player)_`

                            if (gameState.attempts[currentPlayerNumber] >= settings.maxTries) {
                                // FIX BUG-21: recordDisqualification now cleans up playerJids + attempts internally
                                matchSummary.recordDisqualification(gameState, currentPlayerNumber, matchSummary.DQ_REASONS.ATTEMPTS_EXHAUSTED)

                                const removedIndex = gameState.currentTurnIndex

                                const dqFeedback =
                                    `${feedback}\n\n` +
                                    `🚫 *Disqualified!*\n` +
                                    `${nameTag(currentPlayerNumber, nameCache, settings)} has used all *${settings.maxTries}* wrong guesses and has been eliminated. 💀`

                                const lastStanding = matchSummary.checkLastPlayerStanding(gameState)
                                if (lastStanding) {
                                    gameState.active        = false
                                    activeGameChatRef.value = null
                                    await sock.sendMessage(from, {
                                        text:
                                            `${dqFeedback}\n\n` +
                                            `🏆 *LAST PLAYER STANDING!*\n` +
                                            `The word was *${gameState.targetWord.toUpperCase()}*. 🎉`
                                    })
                                    // FIX BUG-08
                                    await matchSummary.sendMatchReport(
                                        sock, from, gameState,
                                        { type: 'last_standing', winnerNumber: lastStanding },
                                        (n) => nameTag(n, nameCache, settings)
                                    )
                                    gameState.players = []
                                    persistGames()
                                } else if (gameState.players.length === 0) {
                                    gameState.active        = false
                                    activeGameChatRef.value = null
                                    await sock.sendMessage(from, {
                                        text:
                                            `${dqFeedback}\n\n` +
                                            `💀 *GAME OVER!* No players remain.\n` +
                                            `The word was *${gameState.targetWord.toUpperCase()}*.`
                                    })
                                    // FIX BUG-08
                                    await matchSummary.sendMatchReport(
                                        sock, from, gameState,
                                        { type: 'no_winner' },
                                        (n) => nameTag(n, nameCache, settings)
                                    )
                                    persistGames()
                                } else {
                                    gameState.currentTurnIndex = removedIndex % gameState.players.length
                                    await sendGameBoard(from, dqFeedback, [], buildCtx(sock))
                                }
                            } else {
                                const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
                                gameState.currentTurnIndex = nextTurnIndex
                                await sendGameBoard(from, feedback, [], buildCtx(sock))
                            }
                        }
                    } else if (body === gameState.targetWord) {
                        // Full word guess = instant win
                        if (gameState.turnTimer) clearInterval(gameState.turnTimer)
                        gameState.active        = false
                        activeGameChatRef.value = null
                        await sock.sendMessage(from, {
                            // FIX BUG-04: use nameTag not tag()
                            text: `⚡ *INSTANT WIN!* ${nameTag(senderNumber, nameCache, settings)} guessed the full word *${gameState.targetWord.toUpperCase()}*! Incredible! 🎉🏆`
                        })
                        // FIX BUG-08
                        await matchSummary.sendMatchReport(
                            sock, from, gameState,
                            { type: 'winner_instant', winnerNumber: senderNumber },
                            (n) => nameTag(n, nameCache, settings)
                        )
                        gameState.players = []
                        persistGames()
                    }
                }
            }
        }
    })
}

startBot()
