// ============================================================
//  adminCommands.js — WRG Bot · Sky Graphics
//  Handles ALL "/" commands:
//    • /admin  — first-time onboarding (key flow) OR admin dashboard
//    • /help   — admin command dashboard (admin-only, DM only)
//    • all other config + game control commands
// ============================================================

const crypto = require('crypto')

// In-memory store for pending onboarding sessions
// key = senderJid, value = { key, expiresAt }
const pendingKeys = {}

/**
 * Generate a random 6-character uppercase key
 */
function generateKey() {
    return crypto.randomBytes(3).toString('hex').toUpperCase()
}

/**
 * Clean expired keys (older than 10 minutes)
 */
function cleanExpiredKeys() {
    const now = Date.now()
    for (const jid in pendingKeys) {
        if (pendingKeys[jid].expiresAt < now) delete pendingKeys[jid]
    }
}

/**
 * The full admin help dashboard text
 */
function buildHelpText(settings) {
    return (
        `👑 *WRG Admin Dashboard*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `_Sky Graphics — Word Riddle Game Bot_\n\n` +
        `All commands work from *any chat*.\n` +
        `Replies always go to *your DM only* (except /pause, /resume, /end which also notify the game group).\n\n` +
        `*⚙️ Configuration:*\n` +
        `• \`/set difficulty [easy/normal/difficult]\` — Change word difficulty\n` +
        `• \`/set admin [number]\` — Change admin number (requires /confirm)\n` +
        `• \`/confirm\` — Confirm a pending /set admin change\n` +
        `• \`/cancel\` — Cancel a pending /set admin change\n` +
        `• \`/set public [on/off]\` — Let non-admins interact with bot (default: on)\n` +
        `• \`/set start [on/off]\` — Let anyone type WRG to open a lobby (default: off)\n` +
        `• \`/set maxtries [n]\` — Set attempt budget per round\n\n` +
        `*📚 Word Pool:*\n` +
        `• \`/addword [level] [word]\` — Add a word\n` +
        `• \`/removeword [level] [word]\` — Remove a word\n` +
        `• \`/listwords [level]\` — View words in a pool\n` +
        `• \`/setwords [level] w1 w2 ...\` — Replace a pool (max 10)\n` +
        `• \`/clearwords [level]\` — Empty a pool\n` +
        `• \`/setallwords easy:w1,w2 normal:w3,w4 difficult:w5\` — Replace all at once\n\n` +
        `*🎮 Game Controls:*\n` +
        `• \`/pause\` — Pause the active game timer\n` +
        `• \`/resume\` — Resume the game timer\n` +
        `• \`/end\` or \`/stop\` — Terminate the active game\n` +
        `• \`/reset\` — ⚠️ Wipe ALL settings, games, and words\n\n` +
        `*Current Settings:*\n` +
        `• Difficulty: *${settings.difficulty.toUpperCase()}*\n` +
        `• Max Tries: *${settings.maxTries}*\n` +
        `• Public Visible: *${settings.publicVisible ? 'ON' : 'OFF'}*\n` +
        `• Public Can Start: *${settings.publicCanStart ? 'ON' : 'OFF'}*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `_WRG Bot · by Sky Graphics_ 🎨`
    )
}

/**
 * Main entry point — called from index.js for every "/" command.
 *
 * ctx = {
 *   sock, settings, words, games, activeGameChatRef,
 *   pendingAdminChange (ref object { value }),
 *   saveSettings, saveWords, persistGames,
 *   sendSafeMessage, getGameState, startTurnCountdown,
 *   jidOf, tag, DEFAULT_WORDS, fs,
 *   senderNumber, senderJid, sender, body, isAdmin
 * }
 */
async function handleAdminCommand(ctx) {
    cleanExpiredKeys()

    const {
        sock, settings, words, games, activeGameChatRef,
        pendingAdminChangeRef, saveSettings, saveWords, persistGames,
        sendSafeMessage, getGameState, startTurnCountdown,
        jidOf, tag, DEFAULT_WORDS, fs,
        senderNumber, senderJid, sender, body, isAdmin
    } = ctx

    const adminJid = settings.adminJid || (settings.adminNumber ? jidOf(settings.adminNumber) : senderJid)
    const raw = body.slice(1).trim()   // strip leading "/"
    const cmd = raw.split(' ')

    // ─────────────────────────────────────────────
    //  /admin  — onboarding (first install) OR
    //            silently redirects to /help if already admin
    // ─────────────────────────────────────────────
    if (cmd[0] === 'admin') {
        // If sender IS the admin → treat as /help
        if (isAdmin && settings.adminNumber !== '') {
            await sendSafeMessage(sock, adminJid, { text: buildHelpText(settings) })
            return
        }

        // If admin is already set → silently ignore anyone else
        if (settings.adminNumber !== '' && !isAdmin) return

        // ── First-time onboarding ──
        // Has the person already been sent a key and is now submitting it?
        const input = cmd.slice(1).join(' ').trim()
        if (input) {
            // They're submitting a key
            const session = pendingKeys[senderJid]
            if (!session) {
                // No active session — tell them to type /admin with no arguments first
                await sock.sendMessage(sender.includes('@') ? sender : `${sender}@s.whatsapp.net`, {
                    text:
                        `🔑 No active key session found for you.\n\n` +
                        `Type */admin* (with nothing else) to start the registration process. ⚙️`
                })
                return
            }

            if (Date.now() > session.expiresAt) {
                delete pendingKeys[senderJid]
                await sock.sendMessage(senderJid, {
                    text:
                        `⏰ *Key Expired*\nYour key has expired (10-minute limit).\n\n` +
                        `Type */admin* again to request a fresh key. 🔄`
                })
                return
            }

            if (input.toUpperCase() !== session.key) {
                await sock.sendMessage(senderJid, {
                    text:
                        `❌ *Wrong Key*\nThat key is incorrect. Please double-check what was sent to the Sky Graphics team and try again.\n\n` +
                        `Type */admin [yourkey]* to retry. 🔑`
                })
                return
            }

            // ✅ Key is correct — register this person as admin
            delete pendingKeys[senderJid]
            settings.adminNumber = senderNumber
            settings.adminJid = senderJid
            saveSettings()

            console.log(`👑 New admin registered — PN: ${senderNumber} | JID: ${senderJid}`)

            // Tell the new admin
            await sendSafeMessage(sock, senderJid, {
                text:
                    `✅ *You're now the WRG Admin!*\n\n` +
                    `Welcome aboard 🎉\n\n` +
                    `Type */help* at any time to see everything you can do.\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `_WRG Bot · by Sky Graphics_ 🎨`
            })

            // Notify creator that someone just became admin
            const creatorJid = process.env.CREATOR_JID
            if (creatorJid) {
                try {
                    await sendSafeMessage(sock, creatorJid, {
                        text:
                            `📢 *New Admin Registered*\n\n` +
                            `Number: *${senderNumber}*\n` +
                            `JID: \`${senderJid}\`\n\n` +
                            `They used key: \`${session.key}\``
                    })
                } catch (_) {}
            }
            return
        }

        // No input — generate a key and send it to the creator
        const newKey = generateKey()
        pendingKeys[senderJid] = {
            key: newKey,
            expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
        }

        // Tell the applicant
        await sock.sendMessage(senderJid, {
            text:
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🎮 *Word Riddle Game Bot*\n` +
                `_Powered by Sky Graphics_ 🎨\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `Welcome! 👋 This is the *WRG Bot* — a live multiplayer word-guessing game for WhatsApp groups.\n\n` +
                `You're trying to access the *Admin Configuration Panel* 🔒\n\n` +
                `To become an admin, you need an access key from the *Sky Graphics team*.\n\n` +
                `🔑 A key has been generated and sent to our team.\n` +
                `Once you receive it, type:\n\n` +
                `\`/admin YOURKEY\`\n\n` +
                `⏰ _This key expires in 10 minutes._`
        })

        // Send the key to the creator
        const creatorJid = process.env.CREATOR_JID
        if (creatorJid) {
            try {
                await sendSafeMessage(sock, creatorJid, {
                    text:
                        `🔑 *Admin Key Request*\n\n` +
                        `Someone is requesting admin access.\n\n` +
                        `📱 Number: *${senderNumber}*\n` +
                        `🆔 JID: \`${senderJid}\`\n\n` +
                        `🗝️ Their key: *${newKey}*\n\n` +
                        `_Share this key with them only if you approve. It expires in 10 minutes._`
                })
            } catch (err) {
                console.log('⚠️ Could not DM creator with admin key:', err.message)
            }
        } else {
            console.log(`🔑 [ADMIN KEY for ${senderNumber}]: ${newKey}  — set CREATOR_JID in .env to receive these as DMs`)
        }
        return
    }

    // ─────────────────────────────────────────────
    //  All commands below require admin
    // ─────────────────────────────────────────────
    if (!isAdmin) return

    // ─────────────────────────────────────────────
    //  /help — admin command dashboard
    // ─────────────────────────────────────────────
    if (cmd[0] === 'help') {
        await sendSafeMessage(sock, adminJid, { text: buildHelpText(settings) })
        return
    }

    // ─────────────────────────────────────────────
    //  /set difficulty
    // ─────────────────────────────────────────────
    if (cmd[0] === 'set' && cmd[1] === 'difficulty') {
        const newDiff = cmd[2]
        if (['easy', 'normal', 'difficult'].includes(newDiff)) {
            settings.difficulty = newDiff
            saveSettings()
            await sendSafeMessage(sock, adminJid, {
                text: `⚙️ Difficulty updated to: *${settings.difficulty.toUpperCase()}* 🎯`
            })
        } else {
            await sendSafeMessage(sock, adminJid, {
                text: `⚠️ Invalid difficulty. Choose: *easy*, *normal*, or *difficult*.`
            })
        }
        return
    }

    // ─────────────────────────────────────────────
    //  /set admin [number]  (with /confirm & /cancel)
    // ─────────────────────────────────────────────
    if (cmd[0] === 'set' && cmd[1] === 'admin') {
        const newAdmin = (cmd[2] || '').replace(/[^0-9]/g, '')
        if (newAdmin) {
            pendingAdminChangeRef.value = { number: newAdmin }
            await sendSafeMessage(sock, adminJid, {
                text:
                    `⚠️ *Confirm Admin Change?*\n\n` +
                    `New number: *${newAdmin}*\n\n` +
                    `Type */confirm* to apply, or */cancel* to discard. 🔄`
            })
        } else {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ Usage: /set admin [full number with country code]` })
        }
        return
    }

    if (cmd[0] === 'confirm') {
        if (pendingAdminChangeRef.value) {
            const confirmed = pendingAdminChangeRef.value
            pendingAdminChangeRef.value = null
            settings.adminNumber = confirmed.number
            settings.adminJid = ''
            saveSettings()
            await sendSafeMessage(sock, adminJid, {
                text:
                    `✅ *Admin updated to:* *${settings.adminNumber}*\n\n` +
                    `The new admin must send *any* message to the bot so their JID can be captured. 📡`
            })
            try {
                await sendSafeMessage(sock, settings.adminNumber, {
                    text:
                        `👑 *You are now the WRG Admin!*\n\n` +
                        `Welcome 🎉 Type */help* to see all commands.\n\n` +
                        `_WRG Bot · by Sky Graphics_ 🎨`
                })
            } catch (err) {
                console.log('⚠️ Could not DM new admin:', err.message)
            }
        } else {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ Nothing to confirm. Use */set admin [number]* first.` })
        }
        return
    }

    if (cmd[0] === 'cancel') {
        if (pendingAdminChangeRef.value) {
            const cancelled = pendingAdminChangeRef.value.number
            pendingAdminChangeRef.value = null
            await sendSafeMessage(sock, adminJid, {
                text: `❌ Admin change to *${cancelled}* has been cancelled.`
            })
        } else {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ Nothing to cancel.` })
        }
        return
    }

    // ─────────────────────────────────────────────
    //  /set maxtries
    // ─────────────────────────────────────────────
    if (cmd[0] === 'set' && cmd[1] === 'maxtries') {
        const n = parseInt(cmd[2], 10)
        if (Number.isInteger(n) && n > 0) {
            settings.maxTries = n
            saveSettings()
            await sendSafeMessage(sock, adminJid, {
                text: `⚙️ Max attempts per round set to: *${settings.maxTries}* 💥`
            })
        } else {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ Usage: /set maxtries [positive number]` })
        }
        return
    }

    // ─────────────────────────────────────────────
    //  /set public [on/off]
    // ─────────────────────────────────────────────
    if (cmd[0] === 'set' && cmd[1] === 'public') {
        const mode = cmd[2]
        if (mode === 'on' || mode === 'off') {
            settings.publicVisible = (mode === 'on')
            saveSettings()
            await sendSafeMessage(sock, adminJid, {
                text: settings.publicVisible
                    ? `🔓 *Public Visibility: ON*\nNon-admins can now interact with the bot (join games, see info). 👥`
                    : `🔒 *Public Visibility: OFF*\nNon-admins are completely silenced. 🤐`
            })
        } else {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ Usage: /set public [on/off]` })
        }
        return
    }

    // ─────────────────────────────────────────────
    //  /set start [on/off]
    // ─────────────────────────────────────────────
    if (cmd[0] === 'set' && cmd[1] === 'start') {
        const mode = cmd[2]
        if (mode === 'on' || mode === 'off') {
            settings.publicCanStart = (mode === 'on')
            saveSettings()
            await sendSafeMessage(sock, adminJid, {
                text: settings.publicCanStart
                    ? `🔓 *Public Game Starts: ON*\nAnyone can type *WRG* to open a lobby. 🎮`
                    : `🔒 *Public Game Starts: OFF*\nOnly you can type *WRG* to open a lobby. 👑`
            })
        } else {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ Usage: /set start [on/off]` })
        }
        return
    }

    // ─────────────────────────────────────────────
    //  Word pool commands
    // ─────────────────────────────────────────────
    if (cmd[0] === 'addword') {
        const level = cmd[1]
        const word = cmd[2]
        if (['easy', 'normal', 'difficult'].includes(level) && word) {
            const tw = word.trim().toLowerCase()
            if (words[level].includes(tw)) {
                await sendSafeMessage(sock, adminJid, {
                    text: `⚠️ *${tw.toUpperCase()}* is already in the *${level.toUpperCase()}* pool.`
                })
            } else if (words[level].length >= 10) {
                await sendSafeMessage(sock, adminJid, {
                    text: `⚠️ *${level.toUpperCase()}* pool is full (max 10 words). Remove one first.`
                })
            } else {
                words[level].push(tw)
                saveWords()
                await sendSafeMessage(sock, adminJid, {
                    text: `✅ *${tw.toUpperCase()}* added to the *${level.toUpperCase()}* pool. 📚`
                })
            }
        } else {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ Usage: /addword [easy/normal/difficult] [word]` })
        }
        return
    }

    if (cmd[0] === 'removeword') {
        const level = cmd[1]
        const word = cmd[2]
        if (['easy', 'normal', 'difficult'].includes(level) && word) {
            const tw = word.trim().toLowerCase()
            const index = words[level].indexOf(tw)
            if (index !== -1) {
                words[level].splice(index, 1)
                saveWords()
                await sendSafeMessage(sock, adminJid, {
                    text: `🗑️ *${tw.toUpperCase()}* removed from the *${level.toUpperCase()}* pool.`
                })
            } else {
                await sendSafeMessage(sock, adminJid, {
                    text: `⚠️ *${tw.toUpperCase()}* not found in the *${level.toUpperCase()}* pool.`
                })
            }
        } else {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ Usage: /removeword [easy/normal/difficult] [word]` })
        }
        return
    }

    if (cmd[0] === 'listwords') {
        const level = cmd[1]
        if (['easy', 'normal', 'difficult'].includes(level)) {
            const list = words[level].join(', ')
            await sendSafeMessage(sock, adminJid, {
                text: `📖 *${level.toUpperCase()} Pool:*\n\n${list || '[Empty — add words with /addword]'}`
            })
        } else {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ Usage: /listwords [easy/normal/difficult]` })
        }
        return
    }

    if (cmd[0] === 'setwords') {
        const level = cmd[1]
        const newWords = cmd.slice(2).map(w => w.trim().toLowerCase()).filter(Boolean)
        if (['easy', 'normal', 'difficult'].includes(level) && newWords.length > 0) {
            if (newWords.length > 10) {
                await sendSafeMessage(sock, adminJid, {
                    text: `⚠️ Maximum 10 words per pool. You provided ${newWords.length}.`
                })
            } else {
                words[level] = [...new Set(newWords)]
                saveWords()
                await sendSafeMessage(sock, adminJid, {
                    text: `✅ *${level.toUpperCase()}* pool replaced with ${words[level].length} word(s). 📚`
                })
            }
        } else {
            await sendSafeMessage(sock, adminJid, {
                text: `⚠️ Usage: /setwords [easy/normal/difficult] word1 word2 ...`
            })
        }
        return
    }

    if (cmd[0] === 'clearwords') {
        const level = cmd[1]
        if (['easy', 'normal', 'difficult'].includes(level)) {
            words[level] = []
            saveWords()
            await sendSafeMessage(sock, adminJid, {
                text: `🗑️ *${level.toUpperCase()}* pool cleared.`
            })
        } else {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ Usage: /clearwords [easy/normal/difficult]` })
        }
        return
    }

    if (cmd[0] === 'setallwords') {
        const payload = cmd.slice(1).join(' ')
        const segments = payload.split(/\s+(?=(easy|normal|difficult):)/i).filter(Boolean)
        const newPools = {}
        let valid = true
        for (const segment of segments) {
            const colonIdx = segment.indexOf(':')
            if (colonIdx === -1) { valid = false; break }
            const level = segment.slice(0, colonIdx).trim().toLowerCase()
            const list = segment.slice(colonIdx + 1)
            if (!['easy', 'normal', 'difficult'].includes(level)) { valid = false; break }
            const items = list.split(',').map(w => w.trim().toLowerCase()).filter(Boolean)
            if (items.length > 10) {
                await sendSafeMessage(sock, adminJid, {
                    text: `⚠️ *${level.toUpperCase()}* may not have more than 10 words.`
                })
                valid = false; break
            }
            newPools[level] = [...new Set(items)]
        }
        if (valid && Object.keys(newPools).length > 0) {
            for (const level of ['easy', 'normal', 'difficult']) {
                if (newPools[level]) words[level] = newPools[level]
            }
            saveWords()
            await sendSafeMessage(sock, adminJid, {
                text: `✅ Word pools updated for: ${Object.keys(newPools).map(l => l.toUpperCase()).join(', ')} 📚`
            })
        } else if (valid) {
            await sendSafeMessage(sock, adminJid, {
                text: `⚠️ Usage: /setallwords easy:word1,word2 normal:word3 difficult:word4`
            })
        }
        return
    }

    // ─────────────────────────────────────────────
    //  /reset — wipe everything
    // ─────────────────────────────────────────────
    if (cmd[0] === 'reset') {
        Object.assign(settings, {
            adminNumber: '',
            adminJid: '',
            difficulty: 'easy',
            maxTries: 10,
            prefix: 'wrg',
            adminPrefix: '/',
            publicVisible: true,
            publicCanStart: false
        })
        pendingAdminChangeRef.value = null
        Object.assign(words, JSON.parse(JSON.stringify(DEFAULT_WORDS)))
        saveWords()
        const SETTINGS_FILE = 'settings.json'
        const GAMES_FILE = 'games.json'
        if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE)
        if (fs.existsSync(GAMES_FILE)) fs.unlinkSync(GAMES_FILE)
        for (const key in games) {
            const g = games[key]
            if (g.lobbyTimer) clearInterval(g.lobbyTimer)
            if (g.turnTimer) clearInterval(g.turnTimer)
            delete games[key]
        }
        activeGameChatRef.value = null
        await sendSafeMessage(sock, adminJid, {
            text:
                `🔄 *Full Reset Complete*\n\n` +
                `All settings, games, and word pools have been restored to defaults. ✅\n\n` +
                `The bot is now unconfigured — the next */admin* command will start a new onboarding. 🚀`
        })
        return
    }

    // ─────────────────────────────────────────────
    //  Game control commands (act on activeGameChat)
    // ─────────────────────────────────────────────
    const activeGameChat = activeGameChatRef.value

    if (cmd[0] === 'pause') {
        if (!activeGameChat) {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ No active game to pause right now.` })
        } else {
            const gs = getGameState(activeGameChat, games, settings)
            if (gs.active && !gs.paused) {
                gs.paused = true
                persistGames()
                await sendSafeMessage(sock, adminJid, { text: `⏸️ *Game paused.*` })
                await sock.sendMessage(activeGameChat, {
                    text: `⏸️ *The game has been paused by the admin.* Sit tight — they'll resume it shortly! ☕`
                })
            } else {
                await sendSafeMessage(sock, adminJid, {
                    text: `⚠️ The game is already paused, or no round is in progress.`
                })
            }
        }
        return
    }

    if (cmd[0] === 'resume') {
        if (!activeGameChat) {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ No active game to resume right now.` })
        } else {
            const gs = getGameState(activeGameChat, games, settings)
            if (gs.active && gs.paused) {
                gs.paused = false
                persistGames()
                await sendSafeMessage(sock, adminJid, { text: `▶️ *Game resumed!*` })
                await sock.sendMessage(activeGameChat, {
                    text: `▶️ *Game resumed by the admin!* Let's go — continue guessing! 🔥`
                })
                startTurnCountdown(activeGameChat, {
                    sock, games, settings,
                    activeGameChatRef,
                    persistGames, jidOf, tag
                })
            } else {
                await sendSafeMessage(sock, adminJid, { text: `⚠️ The game is not currently paused.` })
            }
        }
        return
    }

    if (cmd[0] === 'end' || cmd[0] === 'stop') {
        if (!activeGameChat) {
            await sendSafeMessage(sock, adminJid, { text: `⚠️ No active game or lobby to end right now.` })
        } else {
            const gs = getGameState(activeGameChat, games, settings)
            const endedChat = activeGameChat
            gs.active = false
            gs.lobbyActive = false
            if (gs.lobbyTimer) clearInterval(gs.lobbyTimer)
            if (gs.turnTimer) clearInterval(gs.turnTimer)
            gs.players = []
            gs.playerNames = {}
            gs.skipStreaks = {}
            gs.disqualified = []
            activeGameChatRef.value = null
            persistGames()
            await sendSafeMessage(sock, adminJid, { text: `🛑 *Game terminated.*` })
            await sock.sendMessage(endedChat, {
                text: `🛑 *The game has been terminated by the admin.* Thanks for playing! 👋`
            })
        }
        return
    }

    // Unknown command — silently ignore (admin-only zone, no need to hint)
}

module.exports = { handleAdminCommand }
