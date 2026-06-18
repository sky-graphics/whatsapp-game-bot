const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const matchSummary = require('./matchSummary')

// Persistent Settings Structure
const SETTINGS_FILE = 'settings.json'
const WORDS_FILE = 'words.json'
const GAMES_FILE = 'games.json'

let settings = {
    adminNumber: '', // Will be set on first message or manually
    difficulty: 'easy',
    maxTries: 10, // Shared mistake budget for the WHOLE round (wrong letters + timeouts combined),
                  // not per player and not based on word length. Tune with /set maxtries [n].
    prefix: 'wrg',
    adminPrefix: '/',
    publicStart: false // false = only the admin can type WRG to start a lobby
}

// Load settings if they exist
if (fs.existsSync(SETTINGS_FILE)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE))
    if (typeof settings.publicStart === 'undefined') settings.publicStart = false
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

// Persistent Name Cache (maps phone number -> real WhatsApp profile name)
const NAMES_FILE = 'names.json'
let nameCache = {}
if (fs.existsSync(NAMES_FILE)) {
    nameCache = JSON.parse(fs.readFileSync(NAMES_FILE))
}

// Saves a person's real WhatsApp profile name (pushName) the moment we see it
function rememberName(number, pushName) {
    if (!number || !pushName) return
    if (nameCache[number] !== pushName) {
        nameCache[number] = pushName
        fs.writeFileSync(NAMES_FILE, JSON.stringify(nameCache, null, 2))
    }
}

// Returns the real profile name if known, otherwise falls back to the number
function displayName(number) {
    return nameCache[number] || number
}

// Builds the "@Name" text used inside messages
function tag(number) {
    return `@${displayName(number)}`
}

// Builds the JID needed for WhatsApp's mentions array (always number-based, never the display name)
function jidOf(number) {
    return `${number}@s.whatsapp.net`
}

// Default word pools used by reset and initial installs
const DEFAULT_WORDS = {
    easy: ['apple', 'bread', 'cloud', 'dance', 'earth', 'flame', 'grape', 'house', 'ivory', 'juice'],
    normal: ['browser', 'element', 'network', 'program', 'website', 'database', 'keyboard', 'science', 'offline', 'desktop'],
    difficult: ['algorithm', 'blockchain', 'cryptography', 'deployment', 'encryption', 'framework', 'governance', 'hierarchy', 'interface', 'javascript']
}

let words = JSON.parse(JSON.stringify(DEFAULT_WORDS))

function saveWords() {
    fs.writeFileSync(WORDS_FILE, JSON.stringify(words, null, 2))
}

if (fs.existsSync(WORDS_FILE)) {
    words = JSON.parse(fs.readFileSync(WORDS_FILE))
}

// --- IMPROVEMENT 5: Persist active games to disk -----------------------------------
// On a crash/restart, in-memory `games` would normally be wiped and the round lost.
// We keep a serializable mirror on disk and reload it on boot. Timers (lobbyTimer,
// turnTimer) can't be serialized, so they're stripped before saving and recreated
// (where relevant) after loading.
const games = {}
let activeGameChat = null

function persistGames() {
    const serializable = {}
    for (const chatId in games) {
        const g = games[chatId]
        // Skip persisting empty/idle states to keep the file small.
        if (!g.active && !g.lobbyActive) continue
        const { lobbyTimer, turnTimer, ...rest } = g
        serializable[chatId] = rest
    }
    fs.writeFileSync(GAMES_FILE, JSON.stringify({ activeGameChat, games: serializable }, null, 2))
}

function loadPersistedGames() {
    if (!fs.existsSync(GAMES_FILE)) return
    try {
        const data = JSON.parse(fs.readFileSync(GAMES_FILE))
        activeGameChat = data.activeGameChat || null
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

function getGameState(chatId) {
    if (!games[chatId]) {
        games[chatId] = {
            active: false,
            lobbyActive: false,
            lobbyTimer: null,
            lobbySecondsLeft: 60,
            turnTimer: null,
            turnSecondsLeft: 30,
            targetWord: '',
            hiddenWord: [],
            attempts: 0,
            players: [],
            playerNames: {},
            skipStreaks: {}, // playerNumber -> consecutive no-response count
            disqualified: [], // IMPROVEMENT 1: history of removed players this round
            currentTurnIndex: 0,
            difficulty: settings.difficulty,
            paused: false
        }
    }
    if (!games[chatId].disqualified) games[chatId].disqualified = []
    return games[chatId]
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        getMessage: async () => ({ conversation: '' })
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            // Baileys re-emits a fresh `qr` value on its own (roughly every ~20s) until it's
            // scanned or it gives up. Each time that happens, this block runs again and prints
            // a brand new code + link automatically — nothing extra is needed for that.
            console.log('📱 Scan this QR code with WhatsApp:')
            qrcode.generate(qr, { small: true })
            console.log('\n🔗 OR click this link to scan a clean QR code in your web browser:')
            console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}\n`)
        }
        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut
            if (shouldReconnect) {
                // Covers the "QR expired before I scanned it" case too: the socket closes,
                // we land here, and restarting spins up a new socket which immediately
                // produces a brand new QR code + link above.
                console.log('🔁 Connection closed (e.g. QR expired, or a network drop). Restarting and generating a fresh QR/link...')
                startBot()
            } else {
                console.log('🚪 Logged out. Delete the auth_info folder and restart to link a new device.')
            }
        }
        if (connection === 'open') {
            console.log('✅ WRG Bot is connected!')

            // IMPROVEMENT 5 (continued): if a game/lobby was active when the process died,
            // recover it. Lobby timers and turn timers can't survive a restart, so we
            // restart the relevant countdown fresh rather than trying to resume mid-second.
            if (activeGameChat && games[activeGameChat]) {
                const gs = games[activeGameChat]
                if (gs.lobbyActive) {
                    await sock.sendMessage(activeGameChat, {
                        text: `*🔁 Bot restarted.* Resuming the lobby countdown (${gs.lobbySecondsLeft}s left). Type *wrg join* if you haven't already.`
                    })
                    startLobbyCountdown(activeGameChat)
                } else if (gs.active && !gs.paused) {
                    await sock.sendMessage(activeGameChat, {
                        text: `*🔁 Bot restarted.* Resuming the in-progress round.`
                    })
                    await sendGameBoard(activeGameChat, '🔁 *Round recovered after a restart.*')
                } else if (gs.active && gs.paused) {
                    await sock.sendMessage(activeGameChat, {
                        text: `*🔁 Bot restarted.* The round is still paused — an admin must type */resume* to continue.`
                    })
                }
            }
        }
    })

    // Countdown Helper for Lobby Phase (60 Seconds)
    function startLobbyCountdown(chatId) {
        const gameState = getGameState(chatId)
        if (gameState.lobbyTimer) clearInterval(gameState.lobbyTimer)

        gameState.lobbyTimer = setInterval(async () => {
            if (!gameState.lobbyActive) {
                clearInterval(gameState.lobbyTimer)
                return
            }

            gameState.lobbySecondsLeft--

            if (gameState.lobbySecondsLeft <= 0) {
                clearInterval(gameState.lobbyTimer)
                await startActualGame(chatId)
            }
            else if (gameState.lobbySecondsLeft === 5) {
                await sock.sendMessage(chatId, { text: `*⚠️ Warning:* Only *5 seconds* left to join the game!` })
            }
            else if (gameState.lobbySecondsLeft % 10 === 0) {
                const lobbyMentions = gameState.players.map(num => jidOf(num))
                const lobbyText = gameState.players.map((num, i) => `${i + 1}. ${tag(num)}`).join('\n')

                await sock.sendMessage(chatId, {
                    text: `*⏱️ WRG Lobby Joining:*\n*${gameState.lobbySecondsLeft} seconds* left to join! Type *wrg join* now.\n\n👥 *Lobby:*\n${lobbyText || '[No players joined yet]'}`,
                    mentions: lobbyMentions
                })
            }
            persistGames()
        }, 1000)
    }

    // Starts the actual game round
    async function startActualGame(chatId) {
        const gameState = getGameState(chatId)
        gameState.lobbyActive = false
        if (gameState.lobbyTimer) clearInterval(gameState.lobbyTimer)

        if (gameState.players.length === 0) {
            gameState.active = false
            activeGameChat = null
            persistGames()
            return await sock.sendMessage(chatId, { text: '🛑 Game cancelled. No players joined the lobby.' })
        }

        const pool = words[gameState.difficulty] || words.easy
        gameState.targetWord = pool[Math.floor(Math.random() * pool.length)]
        gameState.hiddenWord = gameState.targetWord.split('').map(() => '_')
        gameState.attempts = 0
        gameState.skipStreaks = {}
        gameState.disqualified = [] // fresh round, fresh disqualification history
        gameState.currentTurnIndex = 0
        gameState.active = true
        gameState.paused = false

        // Message 1: Final Lineup
        const lobbyMentions = gameState.players.map(num => jidOf(num))
        const lobbyText = gameState.players.map((num, i) => `${i + 1}. ${tag(num)}`).join('\n')
        await sock.sendMessage(chatId, {
            text: `*🎬 Lobby Closed! Game Starting!*\n\n👥 *Final Player List:*\n${lobbyText}`,
            mentions: lobbyMentions
        })

        persistGames()

        // Message 2: Board & First Turn
        await sendGameBoard(chatId)
    }

    // Sends the Board UI and mentions next players
    async function sendGameBoard(chatId, actionFeedback = '', extraMentions = []) {
        const gameState = getGameState(chatId)
        if (!gameState.active) return

        const currentPlayerNumber = gameState.players[gameState.currentTurnIndex]
        const nextPlayerIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
        const nextPlayerNumber = gameState.players[nextPlayerIndex]

        const currentPlayerJid = jidOf(currentPlayerNumber)
        const nextPlayerJid = jidOf(nextPlayerNumber)

        let boardText = ''
        if (actionFeedback) {
            boardText += `${actionFeedback}\n\n`
        }

        boardText += `*🎮 Word Riddle Game (WRG)*\n\n`
        boardText += `Word: \`${gameState.hiddenWord.join(' ')}\` (${gameState.targetWord.length} letters)\n`
        boardText += `Attempts remaining: *${settings.maxTries - gameState.attempts}/${settings.maxTries}*\n\n`
        boardText += `🎯 Current Player: *${tag(currentPlayerNumber)}*\n`
        boardText += `⏭️ Up Next: *${tag(nextPlayerNumber)}*\n\n`
        boardText += `_⏱️ You have 30 seconds to guess a letter or the full word!_`

        await sock.sendMessage(chatId, {
            text: boardText,
            mentions: [...new Set([currentPlayerJid, nextPlayerJid, ...extraMentions])]
        })

        persistGames()
        startTurnCountdown(chatId)
    }

    // Countdown Helper for Player Turn Phase (30 Seconds)
    function startTurnCountdown(chatId) {
        const gameState = getGameState(chatId)
        if (gameState.turnTimer) clearInterval(gameState.turnTimer)

        gameState.turnSecondsLeft = 30

        gameState.turnTimer = setInterval(async () => {
            if (!gameState.active || gameState.paused) {
                clearInterval(gameState.turnTimer)
                return
            }

            gameState.turnSecondsLeft--

            const currentPlayerNumber = gameState.players[gameState.currentTurnIndex]
            const currentPlayerJid = jidOf(currentPlayerNumber)

            if (gameState.turnSecondsLeft <= 0) {
                clearInterval(gameState.turnTimer)

                // This counts toward the shared whole-game attempts pool, same as a wrong guess.
                gameState.attempts++

                // Separate rule: 3 *consecutive* no-responses for THIS player locks them out,
                // independent of the maxTries pool.
                gameState.skipStreaks[currentPlayerNumber] = (gameState.skipStreaks[currentPlayerNumber] || 0) + 1
                const skipCount = gameState.skipStreaks[currentPlayerNumber]
                const removedIndex = gameState.currentTurnIndex

                if (skipCount >= 3) {
                    // IMPROVEMENT 1: record to disqualification history before removing.
                    matchSummary.recordDisqualification(gameState, currentPlayerNumber, matchSummary.DQ_REASONS.SKIPPED_3)

                    const dqText = `*🚫 Disqualified!*\n${tag(currentPlayerNumber)} skipped *3 turns in a row* without responding and has been removed from the game.`

                    // IMPROVEMENT 3: single-player edge case. If exactly one player remains
                    // and at least one disqualification has happened, that player auto-wins.
                    const lastStanding = matchSummary.checkLastPlayerStanding(gameState)
                    if (lastStanding) {
                        gameState.active = false
                        activeGameChat = null
                        await sock.sendMessage(chatId, { text: `${dqText}\n\n🏆 *LAST PLAYER STANDING!*` })
                        await matchSummary.sendMatchReport(sock, chatId, gameState, { type: 'last_standing', winnerNumber: lastStanding }, tag)
                        gameState.players = []
                        persistGames()
                        return
                    }

                    if (gameState.players.length === 0) {
                        // No players left — stop immediately. No auto-restart; a new round
                        // only ever begins when *WRG* is explicitly typed again.
                        gameState.active = false
                        activeGameChat = null
                        await sock.sendMessage(chatId, { text: `${dqText}\n\n🛑 *GAME OVER!* No players remain.` })
                        await matchSummary.sendMatchReport(sock, chatId, gameState, { type: 'no_winner' }, tag)
                        persistGames()
                        return
                    }

                    gameState.currentTurnIndex = removedIndex % gameState.players.length
                    await sendGameBoard(chatId, dqText, [currentPlayerJid])
                    return
                }

                // Normal timeout penalty (not yet disqualified)
                const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
                gameState.currentTurnIndex = nextTurnIndex

                const feedback = `*⏰ Timeout!*\n${tag(currentPlayerNumber)} ran out of time. (${skipCount}/3 skips before lockout)`

                if (gameState.attempts >= settings.maxTries) {
                    gameState.active = false
                    activeGameChat = null
                    await sock.sendMessage(chatId, {
                        text: `${feedback}\n\n💀 *GAME OVER!* You ran out of attempts. The word was *${gameState.targetWord.toUpperCase()}*.`,
                        mentions: [currentPlayerJid]
                    })
                    await matchSummary.sendMatchReport(sock, chatId, gameState, { type: 'no_winner' }, tag)
                    persistGames()
                } else {
                    await sendGameBoard(chatId, feedback)
                }
            }
            else if (gameState.turnSecondsLeft === 5) {
                await sock.sendMessage(chatId, {
                    text: `*⚠️ Turn Warning:*\n${tag(currentPlayerNumber)}, only *5 seconds* left! Hurry!`,
                    mentions: [currentPlayerJid]
                })
            }
            else if (gameState.turnSecondsLeft === 10) {
                await sock.sendMessage(chatId, {
                    text: `*⏱️ Turn Alert:*\n${tag(currentPlayerNumber)}, you have *10 seconds* remaining to guess a letter or the word!`,
                    mentions: [currentPlayerJid]
                })
            }
            else if (gameState.turnSecondsLeft === 20) {
                await sock.sendMessage(chatId, {
                    text: `*⏱️ Turn Alert:*\n${tag(currentPlayerNumber)}, you have *20 seconds* remaining to guess a letter or the word!`,
                    mentions: [currentPlayerJid]
                })
            }
        }, 1000)
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            if (!msg.message) continue

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

            // Extract sender JID and phone number
            // NOTE: Baileys sometimes appends a device suffix (e.g. "237xxxxxxxxx:14@s.whatsapp.net").
            // Splitting only on "@" left that ":14" stuck to the number, which is why the number
            // looked "wrong" / different from what shows on WhatsApp. We strip it here.
            const sender = msg.key.participant || msg.key.remoteJid || ''
            const senderNumber = sender.split('@')[0].split(':')[0]

            // The real name set on the sender's WhatsApp profile (what WhatsApp calls "pushName").
            // This is the only reliable source for "the exact name the person uses on WhatsApp" —
            // it is NOT the same as a phone-contact name, which differs per viewer.
            const senderName = msg.pushName || senderNumber
            rememberName(senderNumber, msg.pushName)

            // Determine if the message is from the admin
            const isAdmin = msg.key.fromMe || senderNumber === settings.adminNumber || settings.adminNumber === ''

            // IMPROVEMENT 6: refresh the admin's cached display name every time the admin
            // sends ANY message (not just slash commands), so lobby listings never show a
            // stale name even if the admin only ever types "wrg join" / "WRG".
            if (senderNumber === settings.adminNumber && msg.pushName) {
                rememberName(settings.adminNumber, msg.pushName)
            }

            // Set Admin on first admin command if not set, then DM confirmation.
            if (settings.adminNumber === '' && body.startsWith(settings.adminPrefix)) {
                settings.adminNumber = senderNumber
                saveSettings()
                console.log(`👑 Admin set to: ${settings.adminNumber}`)

                // IMPROVEMENT (from Q&A): confirm admin registration via DM immediately.
                try {
                    await sock.sendMessage(jidOf(settings.adminNumber), {
                        text: `👑 You have been registered as the WRG administrator.\n\nType */help* here at any time to see all admin commands.`
                    })
                } catch (err) {
                    console.log('⚠️ Could not DM the new admin (they may need to message the bot directly first):', err.message)
                }
            }

            // --- ADMIN LAYER (Config + Game Controls — everything here always replies to the admin's DM only) ---
            // IMPORTANT: this is the ONLY block that handles adminPrefix ("/") commands.
            if (body.startsWith(settings.adminPrefix)) {
                // IMPROVEMENT 4: lock commands even harder. Any "/" command from a
                // non-admin is silently ignored — no fallback behavior, no partial
                // execution, no leaking of command existence.
                if (!isAdmin) {
                    continue
                }

                const cmd = body.slice(1).split(' ')
                const adminJid = settings.adminNumber ? jidOf(settings.adminNumber) : sender

                if (cmd[0] === 'admin' || cmd[0] === 'help') {
                    const adminHelp = `*👑 WRG Admin Dashboard*\n\nHere are your configuration commands. You can type them in *any* chat — the results always come back to this DM only, never the chat you typed them in.\n\n*Configuration Commands:*\n• \`/set difficulty [easy/normal/difficult]\` - Set default mode.\n• \`/set admin [number]\` - Update admin phone number.\n• \`/set public [on/off]\` - Allow/restrict who can type WRG to start a game.\n• \`/set maxtries [number]\` - Set the shared mistake budget (wrong letters + timeouts) for a round.\n• \`/addword [level] [word]\` - Add a word to the pool.\n• \`/removeword [level] [word]\` - Delete a word.\n• \`/listwords [level]\` - View all words in a pool.\n\n*Group Game Controls (act on whichever chat the active game is actually running in, not the chat you type from):*\n• \`/pause\` - Pause the active game timer.\n• \`/resume\` - Resume the active game timer.\n• \`/end\` - Terminate the active game.\n\n*Lockout rule:* any player who fails to respond on *3 turns in a row* is removed from the round. If that leaves zero players, the round ends immediately — it never auto-restarts; only typing *WRG* again starts a new one. If exactly one player remains after disqualifications, they win instantly as Last Player Standing.`
                    await sock.sendMessage(adminJid, { text: adminHelp })
                }
                else if (cmd[0] === 'set' && cmd[1] === 'difficulty') {
                    const newDiff = cmd[2]
                    if (['easy', 'normal', 'difficult'].includes(newDiff)) {
                        settings.difficulty = newDiff
                        saveSettings()
                        await sock.sendMessage(adminJid, { text: `⚙️ Default difficulty updated to: *${settings.difficulty.toUpperCase()}*` })
                    } else {
                        await sock.sendMessage(adminJid, { text: `⚠️ Invalid difficulty. Choose: easy, normal, or difficult.` })
                    }
                }
                else if (cmd[0] === 'set' && cmd[1] === 'admin') {
                    const newAdmin = (cmd[2] || '').replace(/[^0-9]/g, '')
                    if (newAdmin) {
                        settings.adminNumber = newAdmin
                        saveSettings()
                        await sock.sendMessage(adminJid, { text: `👑 Admin number updated to: *${settings.adminNumber}*` })
                        try {
                            await sock.sendMessage(jidOf(settings.adminNumber), {
                                text: `👑 You have been registered as the WRG administrator.\n\nType */help* here at any time to see all admin commands.`
                            })
                        } catch (err) {
                            console.log('⚠️ Could not DM the new admin:', err.message)
                        }
                    } else {
                        await sock.sendMessage(adminJid, { text: `⚠️ Usage: /set admin [number]` })
                    }
                }
                else if (cmd[0] === 'set' && cmd[1] === 'maxtries') {
                    const n = parseInt(cmd[2], 10)
                    if (Number.isInteger(n) && n > 0) {
                        settings.maxTries = n
                        saveSettings()
                        await sock.sendMessage(adminJid, { text: `⚙️ Max attempts per round updated to: *${settings.maxTries}*` })
                    } else {
                        await sock.sendMessage(adminJid, { text: `⚠️ Usage: /set maxtries [positive number]` })
                    }
                }
                else if (cmd[0] === 'set' && cmd[1] === 'public') {
                    const mode = cmd[2]
                    if (mode === 'on' || mode === 'off') {
                        settings.publicStart = (mode === 'on')
                        saveSettings()
                        await sock.sendMessage(adminJid, {
                            text: settings.publicStart
                                ? `🔓 Public starts *ENABLED*. Anyone in a chat can now type *WRG* to start a lobby.`
                                : `🔒 Public starts *DISABLED*. Only you (the admin) can type *WRG* to start a lobby now.`
                        })
                    } else {
                        await sock.sendMessage(adminJid, { text: `⚠️ Usage: /set public [on/off]` })
                    }
                }
                else if (cmd[0] === 'addword') {
                    const level = cmd[1]
                    const word = cmd[2]
                    if (['easy', 'normal', 'difficult'].includes(level) && word) {
                        const trimmedWord = word.trim().toLowerCase()
                        if (!words[level].includes(trimmedWord)) {
                            if (words[level].length >= 10) {
                                await sock.sendMessage(adminJid, { text: `⚠️ *${level.toUpperCase()}* already has the maximum of 10 words.` })
                            } else {
                                words[level].push(trimmedWord)
                                saveWords()
                                await sock.sendMessage(adminJid, { text: `✅ Word *${trimmedWord.toUpperCase()}* added to *${level.toUpperCase()}* pool.` })
                            }
                        } else {
                            await sock.sendMessage(adminJid, { text: `⚠️ Word *${trimmedWord.toUpperCase()}* is already in *${level.toUpperCase()}* pool.` })
                        }
                    } else {
                        await sock.sendMessage(adminJid, { text: `⚠️ Usage: /addword [easy/normal/difficult] [word]` })
                    }
                }
                else if (cmd[0] === 'setwords') {
                    const level = cmd[1]
                    const newWords = cmd.slice(2).map(w => w.trim().toLowerCase()).filter(Boolean)
                    if (['easy', 'normal', 'difficult'].includes(level) && newWords.length > 0) {
                        if (newWords.length > 10) {
                            await sock.sendMessage(adminJid, { text: `⚠️ You may set at most 10 words for *${level.toUpperCase()}*.` })
                        } else {
                            words[level] = [...new Set(newWords)]
                            saveWords()
                            await sock.sendMessage(adminJid, { text: `✅ *${level.toUpperCase()}* word pool replaced with ${words[level].length} word(s).` })
                        }
                    } else {
                        await sock.sendMessage(adminJid, { text: `⚠️ Usage: /setwords [easy/normal/difficult] [word1] [word2] ...` })
                    }
                }
                else if (cmd[0] === 'clearwords') {
                    const level = cmd[1]
                    if (['easy', 'normal', 'difficult'].includes(level)) {
                        words[level] = []
                        saveWords()
                        await sock.sendMessage(adminJid, { text: `✅ *${level.toUpperCase()}* word pool has been cleared.` })
                    } else {
                        await sock.sendMessage(adminJid, { text: `⚠️ Usage: /clearwords [easy/normal/difficult]` })
                    }
                }
                else if (cmd[0] === 'setallwords') {
                    const payload = cmd.slice(1).join(' ')
                    const segments = payload.split(/\s+(?=(easy|normal|difficult):)/i).filter(Boolean)
                    const newPools = {}
                    let valid = true
                    for (const segment of segments) {
                        const [level, list] = segment.split(':')
                        if (!level || !list) {
                            valid = false
                            break
                        }
                        const normalizedLevel = level.trim().toLowerCase()
                        if (!['easy', 'normal', 'difficult'].includes(normalizedLevel)) {
                            valid = false
                            break
                        }
                        const items = list.split(',').map(w => w.trim().toLowerCase()).filter(Boolean)
                        if (items.length > 10) {
                            await sock.sendMessage(adminJid, { text: `⚠️ *${normalizedLevel.toUpperCase()}* may not contain more than 10 words.` })
                            valid = false
                            break
                        }
                        newPools[normalizedLevel] = [...new Set(items)]
                    }
                    if (valid && Object.keys(newPools).length > 0) {
                        for (const level of ['easy', 'normal', 'difficult']) {
                            if (newPools[level]) {
                                words[level] = newPools[level]
                            }
                        }
                        saveWords()
                        await sock.sendMessage(adminJid, { text: `✅ Word pools updated for levels: ${Object.keys(newPools).map(l => l.toUpperCase()).join(', ')}.` })
                    } else {
                        await sock.sendMessage(adminJid, { text: `⚠️ Usage: /setallwords easy:word1,word2 normal:word3,word4 difficult:word5,word6` })
                    }
                }
                else if (cmd[0] === 'removeword') {
                    const level = cmd[1]
                    const word = cmd[2]
                    if (['easy', 'normal', 'difficult'].includes(level) && word) {
                        const trimmedWord = word.trim().toLowerCase()
                        const index = words[level].indexOf(trimmedWord)
                        if (index !== -1) {
                            words[level].splice(index, 1)
                            saveWords()
                            await sock.sendMessage(adminJid, { text: `❌ Word *${trimmedWord.toUpperCase()}* removed from *${level.toUpperCase()}* pool.` })
                        } else {
                            await sock.sendMessage(adminJid, { text: `⚠️ Word *${trimmedWord.toUpperCase()}* not found in *${level.toUpperCase()}* pool.` })
                        }
                    } else {
                        await sock.sendMessage(adminJid, { text: `⚠️ Usage: /removeword [easy/normal/difficult] [word]` })
                    }
                }
                else if (cmd[0] === 'listwords') {
                    const level = cmd[1]
                    if (['easy', 'normal', 'difficult'].includes(level)) {
                        const list = words[level].join(', ')
                        await sock.sendMessage(adminJid, { text: `📖 *${level.toUpperCase()} Pool words:*\n\n${list || '[Empty]'}` })
                    } else {
                        await sock.sendMessage(adminJid, { text: `⚠️ Usage: /listwords [easy/normal/difficult]` })
                    }
                }
                else if (cmd[0] === 'reset') {
                    settings = {
                        adminNumber: '',
                        difficulty: 'easy',
                        maxTries: 10,
                        prefix: 'wrg',
                        adminPrefix: '/',
                        publicStart: false
                    }
                    words = JSON.parse(JSON.stringify(DEFAULT_WORDS))
                    saveWords()
                    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE)
                    if (fs.existsSync(GAMES_FILE)) fs.unlinkSync(GAMES_FILE)
                    for (const key in games) {
                        const g = games[key]
                        if (g.lobbyTimer) clearInterval(g.lobbyTimer)
                        if (g.turnTimer) clearInterval(g.turnTimer)
                        delete games[key]
                    }
                    activeGameChat = null
                    await sock.sendMessage(adminJid, { text: `🔄 Configuration, games, and built-in word pools have been restored.` })
                }
                // --- Game control commands: these always act on the chat the active game is
                // actually running in (activeGameChat), never on whatever chat the admin typed
                // from, and they always reply to the admin's DM only.
                else if (cmd[0] === 'pause') {
                    if (!activeGameChat) {
                        await sock.sendMessage(adminJid, { text: '⚠️ No active game to pause right now.' })
                    } else {
                        const gs = getGameState(activeGameChat)
                        if (gs.active && !gs.paused) {
                            gs.paused = true
                            persistGames()
                            await sock.sendMessage(adminJid, { text: '⏸️ Game timer paused.' })
                        } else {
                            await sock.sendMessage(adminJid, { text: '⚠️ The game is already paused, or no round is currently in progress.' })
                        }
                    }
                }
                else if (cmd[0] === 'resume') {
                    if (!activeGameChat) {
                        await sock.sendMessage(adminJid, { text: '⚠️ No active game to resume right now.' })
                    } else {
                        const gs = getGameState(activeGameChat)
                        if (gs.active && gs.paused) {
                            gs.paused = false
                            persistGames()
                            await sock.sendMessage(adminJid, { text: '▶️ Game timer resumed.' })
                            startTurnCountdown(activeGameChat)
                        } else {
                            await sock.sendMessage(adminJid, { text: '⚠️ The game is not currently paused.' })
                        }
                    }
                }
                else if (cmd[0] === 'end' || cmd[0] === 'stop') {
                    if (!activeGameChat) {
                        await sock.sendMessage(adminJid, { text: '⚠️ No active game or lobby to end right now.' })
                    } else {
                        const gs = getGameState(activeGameChat)
                        const endedChat = activeGameChat
                        gs.active = false
                        gs.lobbyActive = false
                        if (gs.lobbyTimer) clearInterval(gs.lobbyTimer)
                        if (gs.turnTimer) clearInterval(gs.turnTimer)
                        gs.players = []
                        gs.playerNames = {}
                        gs.skipStreaks = {}
                        gs.disqualified = []
                        activeGameChat = null
                        persistGames()
                        await sock.sendMessage(adminJid, { text: '🛑 Game terminated.' })
                        await sock.sendMessage(endedChat, { text: '🛑 *The game has been terminated by the admin.*' })
                    }
                }
                continue
            }

            // --- LOBBY START AUTOMATION ---
            if (rawBody === 'WRG') {
                if (!isAdmin && !settings.publicStart) {
                    continue
                }

                if (activeGameChat) {
                    await sock.sendMessage(from, {
                        text: activeGameChat === from
                            ? '⚠️ A game or lobby is already active in this chat!'
                            : '⚠️ A game or lobby is already active in another chat. It must end before a new one can start.'
                    })
                    continue
                }

                const gameState = getGameState(from)
                gameState.lobbyActive = true
                gameState.lobbySecondsLeft = 60
                gameState.players = []
                gameState.playerNames = {}
                gameState.skipStreaks = {}
                gameState.disqualified = []

                // Admin automatically joins
                if (settings.adminNumber) {
                    gameState.players.push(settings.adminNumber)
                    gameState.playerNames[settings.adminNumber] = displayName(settings.adminNumber)
                }

                const adminMention = settings.adminNumber ? [jidOf(settings.adminNumber)] : []
                const adminLobbyText = settings.adminNumber ? `1. ${tag(settings.adminNumber)} (Auto-joined)` : '[No players joined yet]'

                await sock.sendMessage(from, {
                    text: `*🎮 Word Riddle Game (WRG) is starting!*\nYou have *60 seconds* to type *wrg join* to enter the game.\n\n👥 *Lobby:*\n${adminLobbyText}\n⏱️ Time remaining to join: *60 seconds*`,
                    mentions: adminMention
                })

                activeGameChat = from
                persistGames()
                startLobbyCountdown(from)
                continue
            }

            // --- GAME LOBBY JOIN LAYER ---
            if (body.startsWith(settings.prefix)) {
                const parts = body.split(' ')
                const subCmd = parts[1]
                const gameState = getGameState(from)

                if (subCmd === 'join') {
                    if (!gameState.lobbyActive) {
                        await sock.sendMessage(from, { text: '⚠️ No active lobby to join! Type *WRG* to start a game.' })
                        continue
                    }
                    if (!gameState.players.includes(senderNumber)) {
                        gameState.players.push(senderNumber)
                        gameState.playerNames[senderNumber] = senderName

                        const lobbyMentions = gameState.players.map(num => jidOf(num))
                        const lobbyText = gameState.players.map((num, i) => `${i + 1}. ${tag(num)}`).join('\n')

                        await sock.sendMessage(from, {
                            text: `*✅ ${tag(senderNumber)} has joined the game!*\n\n👥 *Current Lobby:*\n${lobbyText}\n\n_Type *wrg join* to join the lobby!_`,
                            mentions: [...new Set([jidOf(senderNumber), ...lobbyMentions])]
                        })
                        persistGames()
                    } else {
                        await sock.sendMessage(from, { text: '⚠️ You have already joined the lobby!' })
                    }
                    continue
                }
                else if (subCmd === 'start') {
                    if (!gameState.lobbyActive) {
                        await sock.sendMessage(from, { text: '⚠️ No active lobby! Type *WRG* to start a game.' })
                        continue
                    }
                    // Bypasses the 60s countdown and starts immediately
                    if (gameState.players.includes(senderNumber) || isAdmin) {
                        await startActualGame(from)
                    }
                    continue
                }
                else if (!subCmd || subCmd === 'help') {
                    await sock.sendMessage(from, {
                        text: `*🎮 Welcome to Word Riddle Game (WRG)!*\n\nHow to play:\n1️⃣ Type *WRG* (all caps) to start a game lobby.\n2️⃣ Type *wrg join* to enter the lobby.\n3️⃣ Once the timer expires, the game begins automatically!\n4️⃣ On your turn, type a single letter to guess it, or the full word to win instantly.\n5️⃣ Miss *3 turns in a row* and you're disqualified from that round.\n6️⃣ If only one player remains after disqualifications, they win as Last Player Standing!`
                    })
                    continue
                }
            }

            // --- ACTIVE GAME PLAY LOGIC ---
            const gameState = getGameState(from)
            if (gameState.active && !gameState.paused) {
                const currentPlayerNumber = gameState.players[gameState.currentTurnIndex]

                // Only current turn player can guess (admins can bypass if they are not playing)
                const isPlayerTurn = senderNumber === currentPlayerNumber
                const isAdminBypass = isAdmin && !gameState.players.includes(senderNumber)

                if (isPlayerTurn || isAdminBypass) {
                    // Any input that resolves this turn counts as "responding" — reset the
                    // consecutive no-response (skip) streak for whoever's turn this was.
                    gameState.skipStreaks[currentPlayerNumber] = 0

                    if (body.length === 1) { // Letter Guess
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

                            // Victory Check
                            if (!gameState.hiddenWord.includes('_')) {
                                gameState.active = false
                                activeGameChat = null
                                await sock.sendMessage(from, { text: `🎉 *VICTORY!* The word was *${gameState.targetWord.toUpperCase()}*!` })
                                await matchSummary.sendMatchReport(sock, from, gameState, { type: 'winner_letter', winnerNumber: senderNumber }, tag)
                                gameState.players = []
                                persistGames()
                            } else {
                                // Rotate turn
                                const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
                                gameState.currentTurnIndex = nextTurnIndex

                                const feedback = `*✅ Correct!*\n${tag(senderNumber)} guessed *${body.toUpperCase()}* and revealed the first occurrence.`
                                await sendGameBoard(from, feedback, [jidOf(senderNumber)])
                            }
                        } else {
                            // Incorrect Guess
                            gameState.attempts++
                            const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
                            gameState.currentTurnIndex = nextTurnIndex

                            const feedback = `*❌ Wrong guess!*\n${tag(senderNumber)} guessed *${body.toUpperCase()}* (which is not in the word).`

                            if (gameState.attempts >= settings.maxTries) {
                                gameState.active = false
                                activeGameChat = null
                                await sock.sendMessage(from, { text: `${feedback}\n\n💀 *GAME OVER!* You ran out of attempts. The word was *${gameState.targetWord.toUpperCase()}*.` })
                                await matchSummary.sendMatchReport(sock, from, gameState, { type: 'no_winner' }, tag)
                                gameState.players = []
                                persistGames()
                            } else {
                                await sendGameBoard(from, feedback)
                            }
                        }
                    } else if (body === gameState.targetWord) { // Word Guess
                        if (gameState.turnTimer) clearInterval(gameState.turnTimer)
                        gameState.active = false
                        activeGameChat = null
                        await sock.sendMessage(from, { text: `🎉 *INSTANT WIN!* The word was *${gameState.targetWord.toUpperCase()}*!` })
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
