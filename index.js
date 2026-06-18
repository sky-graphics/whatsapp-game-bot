const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const fs = require('fs')

// Persistent Settings Structure
const SETTINGS_FILE = 'settings.json'
const WORDS_FILE = 'words.json'

let settings = {
    adminNumber: '', // Will be set on first message or manually
    difficulty: 'easy',
    maxTries: 10,
    prefix: 'wrg',
    adminPrefix: '/',
    publicStart: false // false = only the admin can type WRG to start a lobby
}

// Load settings if they exist
if (fs.existsSync(SETTINGS_FILE)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE))
    if (typeof settings.publicStart === 'undefined') settings.publicStart = false
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

// Per-Chat Game States
const games = {}

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
            currentTurnIndex: 0,
            difficulty: settings.difficulty,
            paused: false
        }
    }
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

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('📱 Scan this QR code with WhatsApp:')
            qrcode.generate(qr, { small: true })
            console.log('\n🔗 OR click this link to scan a clean QR code in your web browser:')
            console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}\n`)
        }
        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            if (shouldReconnect) startBot()
        }
        if (connection === 'open') console.log('✅ WRG Bot is connected!')
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
        }, 1000)
    }

    // Starts the actual game round
    async function startActualGame(chatId) {
        const gameState = getGameState(chatId)
        gameState.lobbyActive = false
        if (gameState.lobbyTimer) clearInterval(gameState.lobbyTimer)

        if (gameState.players.length === 0) {
            gameState.active = false
            return await sock.sendMessage(chatId, { text: '🛑 Game cancelled. No players joined the lobby.' })
        }

        const pool = words[gameState.difficulty] || words.easy
        gameState.targetWord = pool[Math.floor(Math.random() * pool.length)]
        gameState.hiddenWord = gameState.targetWord.split('').map(() => '_')
        gameState.attempts = 0
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

        // Message 2: Board & First Turn
        await sendGameBoard(chatId)
    }

    // Sends the Board UI and mentions next players
    async function sendGameBoard(chatId, actionFeedback = '') {
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
            mentions: [currentPlayerJid, nextPlayerJid]
        })

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
                
                // Timeout penalties
                gameState.attempts++
                const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
                gameState.currentTurnIndex = nextTurnIndex

                const feedback = `*⏰ Timeout!*\n${tag(currentPlayerNumber)} ran out of time.`

                if (gameState.attempts >= settings.maxTries) {
                    gameState.active = false
                    await sock.sendMessage(chatId, {
                        text: `${feedback}\n\n💀 *GAME OVER!* You ran out of attempts. The word was *${gameState.targetWord.toUpperCase()}*.`,
                        mentions: [currentPlayerJid]
                    })
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

            // Set Admin on first admin command if not set
            if (settings.adminNumber === '' && body.startsWith(settings.adminPrefix)) {
                settings.adminNumber = senderNumber
                fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
                console.log(`👑 Admin set to: ${settings.adminNumber}`)
            }

            // --- ADMIN CONFIGURATION LAYER (Redirects to Admin's DM) ---
            if (body.startsWith(settings.adminPrefix)) {
                if (isAdmin) {
                    const cmd = body.slice(1).split(' ')
                    const adminJid = settings.adminNumber ? `${settings.adminNumber}@s.whatsapp.net` : sender

                    if (cmd[0] === 'admin' || cmd[0] === 'help') {
                        const adminHelp = `*👑 WRG Admin Dashboard*\n\nHere are your configuration commands. You can type them in any chat, but the results will always be sent privately here.\n\n*Configuration Commands:*\n• \`/set difficulty [easy/normal/difficult]\` - Set default mode.\n• \`/set admin [number]\` - Update admin phone number.\n• \`/set public [on/off]\` - Allow/restrict who can type WRG to start a game.\n• \`/addword [level] [word]\` - Add a word to the pool.\n• \`/removeword [level] [word]\` - Delete a word.\n• \`/listwords [level]\` - View all words in a pool.\n\n*Group Game Controls:*\n• \`/pause\` - Pause the active game timer.\n• \`/resume\` - Resume the active game timer.\n• \`/end\` - Terminate the active game.`
                        await sock.sendMessage(adminJid, { text: adminHelp })
                    }
                    else if (cmd[0] === 'set' && cmd[1] === 'difficulty') {
                        const newDiff = cmd[2]
                        if (['easy', 'normal', 'difficult'].includes(newDiff)) {
                            settings.difficulty = newDiff
                            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
                            await sock.sendMessage(adminJid, { text: `⚙️ Default difficulty updated to: *${settings.difficulty.toUpperCase()}*` })
                        } else {
                            await sock.sendMessage(adminJid, { text: `⚠️ Invalid difficulty. Choose: easy, normal, or difficult.` })
                        }
                    }
                    else if (cmd[0] === 'set' && cmd[1] === 'admin') {
                        const newAdmin = cmd[2].replace(/[^0-9]/g, '')
                        settings.adminNumber = newAdmin
                        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
                        await sock.sendMessage(adminJid, { text: `👑 Admin number updated to: *${settings.adminNumber}*` })
                    }
                    else if (cmd[0] === 'set' && cmd[1] === 'public') {
                        const mode = cmd[2]
                        if (mode === 'on' || mode === 'off') {
                            settings.publicStart = (mode === 'on')
                            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
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
                                fs.writeFileSync(WORDS_FILE, JSON.stringify(words, null, 2))
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
                        for (const key in games) {
                            const g = games[key]
                            if (g.lobbyTimer) clearInterval(g.lobbyTimer)
                            if (g.turnTimer) clearInterval(g.turnTimer)
                            delete games[key]
                        }
                        await sock.sendMessage(adminJid, { text: `🔄 Configuration, games, and built-in word pools have been restored.` })
                    }
                }
                continue
            }

            // --- EXCLUSIVE GROUP ADMIN GAME CONTROL LAYER ---
            if (body.startsWith(settings.adminPrefix) && isAdmin) {
                const cmd = body.slice(1).split(' ')
                const gameState = getGameState(from)

                if (cmd[0] === 'pause') {
                    if (gameState.active && !gameState.paused) {
                        gameState.paused = true
                        await sock.sendMessage(from, { text: '⏸️ Game timer paused by admin.' })
                    }
                    continue
                }
                else if (cmd[0] === 'resume') {
                    if (gameState.active && gameState.paused) {
                        gameState.paused = false
                        await sock.sendMessage(from, { text: '▶️ Game timer resumed by admin.' })
                        startTurnCountdown(from)
                    }
                    continue
                }
                else if (cmd[0] === 'end' || cmd[0] === 'stop') {
                    if (gameState.active || gameState.lobbyActive) {
                        gameState.active = false
                        gameState.lobbyActive = false
                        if (gameState.lobbyTimer) clearInterval(gameState.lobbyTimer)
                        if (gameState.turnTimer) clearInterval(gameState.turnTimer)
                        gameState.players = []
                        await sock.sendMessage(from, { text: '🛑 Game terminated by admin.' })
                    }
                    continue
                }
            }

            // --- LOBBY START AUTOMATION ---
            if (rawBody === 'WRG') {
                const gameState = getGameState(from)
                if (gameState.active || gameState.lobbyActive) {
                    await sock.sendMessage(from, { text: '⚠️ A game or lobby is already active in this chat!' })
                    continue
                }

                gameState.lobbyActive = true
                gameState.lobbySecondsLeft = 60
                gameState.players = []
                gameState.playerNames = {}

                // Admin automatically joins
                if (settings.adminNumber) {
                    gameState.players.push(settings.adminNumber)
                    gameState.playerNames[settings.adminNumber] = 'Admin'
                }

                const adminMention = settings.adminNumber ? [`${settings.adminNumber}@s.whatsapp.net`] : []
                const adminLobbyText = settings.adminNumber ? `1. @${settings.adminNumber} (Auto-joined)` : '[No players joined yet]'

                await sock.sendMessage(from, {
                    text: `*🎮 Word Riddle Game (WRG) is starting!*\nYou have *60 seconds* to type *wrg join* to enter the game.\n\n👥 *Lobby:*\n${adminLobbyText}\n⏱️ Time remaining to join: *60 seconds*`,
                    mentions: adminMention
                })

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

                        const lobbyMentions = gameState.players.map(num => `${num}@s.whatsapp.net`)
                        const lobbyText = gameState.players.map((num, i) => `${i + 1}. @${num}`).join('\n')

                        await sock.sendMessage(from, {
                            text: `*✅ @${senderNumber} has joined the game!*\n\n👥 *Current Lobby:*\n${lobbyText}\n\n_Type *wrg join* to join the lobby!_`,
                            mentions: [sender, ...lobbyMentions]
                        })
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
                        text: `*🎮 Welcome to Word Riddle Game (WRG)!*\n\nHow to play:\n1️⃣ Type *WRG* (all caps) to start a game lobby.\n2️⃣ Type *wrg join* to enter the lobby.\n3️⃣ Once the timer expires, the game begins automatically!` 
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
                                const winnerName = gameState.playerNames[senderNumber] || senderName
                                await sock.sendMessage(from, { text: `🎉 *VICTORY!* The word was *${gameState.targetWord.toUpperCase()}*!\n\nWinner: ${winnerName}` })
                                gameState.players = []
                            } else {
                                // Rotate turn
                                const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
                                gameState.currentTurnIndex = nextTurnIndex

                                const feedback = `*✅ Correct!*\n@${senderNumber} guessed *${body.toUpperCase()}* and revealed the first occurrence.`
                                await sendGameBoard(from, feedback)
                            }
                        } else {
                            // Incorrect Guess
                            gameState.attempts++
                            const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
                            gameState.currentTurnIndex = nextTurnIndex

                            const feedback = `*❌ Wrong guess!*\n@${senderNumber} guessed *${body.toUpperCase()}* (which is not in the word).`

                            if (gameState.attempts >= settings.maxTries) {
                                gameState.active = false
                                await sock.sendMessage(from, { text: `${feedback}\n\n💀 *GAME OVER!* You ran out of attempts. The word was *${gameState.targetWord.toUpperCase()}*.` })
                                gameState.players = []
                            } else {
                                await sendGameBoard(from, feedback)
                            }
                        }
                    } else if (body === gameState.targetWord) { // Word Guess
                        if (gameState.turnTimer) clearInterval(gameState.turnTimer)
                        gameState.active = false
                        const winnerName = gameState.playerNames[senderNumber] || senderName
                        await sock.sendMessage(from, { text: `🎉 *INSTANT WIN!* The word was *${gameState.targetWord.toUpperCase()}*!\n\nChampion: ${winnerName}` })
                        gameState.players = []
                    }
                }
            }
        }
    })
}

startBot()
