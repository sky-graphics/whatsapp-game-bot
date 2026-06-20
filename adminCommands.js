// ============================================================
//  adminCommands.js — WRG Bot · Sky Graphics
//  Handles ALL "/" commands with full security hardening.
//
//  Access tiers:
//    CREATOR  — CREATOR_JID in .env. Unrestricted. Always works.
//    ADMIN    — set via key onboarding. Full command access.
//    EVERYONE ELSE — total silence on all "/" commands.
//
//  /admin  — onboarding gate (key request → creator approves → key sent)
//  /help   — admin/creator dashboard, DM only, silent to all others
//  /approve [number] — creator only: sends approved key to requester
//  /deny   [number] — creator only: immediately voids the key
// ============================================================

const crypto = require('crypto')

// FIX BUG-10: single clean import — no duplicate require
const {
    TIERS, getTier, isCreator: isCreatorFn,
    canRunCommand, difficultyBadge, writeSetting,
    resolveSetting, getReplyTarget, nameTag
} = require('./permissions')

// ─── Pending key sessions ────────────────────────────────────
// Map: senderJid → { key, expiresAt, senderNumber, senderName, attempts }
const pendingKeys = {}

// ─── Pending approval queue ──────────────────────────────────
// Map: senderNumber → senderJid
const approvalQueue = {}

// ─── Rate limiting: /admin spam lockout ──────────────────────
const adminRateLimit = {}

// ─── Admin inactivity tracker ────────────────────────────────
let adminLastActive = 0
let adminInactivityTimer = null

function generateKey() {
    return crypto.randomUUID()
}

function cleanExpiredKeys() {
    const now = Date.now()
    for (const jid in pendingKeys) {
        if (pendingKeys[jid].expiresAt < now) {
            const num = pendingKeys[jid].senderNumber
            delete pendingKeys[jid]
            delete approvalQueue[num]
        }
    }
}

function checkAdminRateLimit(senderNumber) {
    const now = Date.now()
    const entry = adminRateLimit[senderNumber] || { count: 0, lockedUntil: 0 }

    if (now < entry.lockedUntil) return true

    if (entry.lockedUntil && now >= entry.lockedUntil) {
        entry.count = 0
        entry.lockedUntil = 0
    }

    entry.count++
    if (entry.count >= 5) {
        entry.lockedUntil = now + 10 * 60 * 1000
        entry.count = 0
    }
    adminRateLimit[senderNumber] = entry
    return false
}

function startAdminInactivityTimer(settings, saveSettings, sock, sendSafeMessage) {
    if (adminInactivityTimer) clearInterval(adminInactivityTimer)
    adminLastActive = Date.now()

    adminInactivityTimer = setInterval(async () => {
        if (!settings.adminNumber) {
            clearInterval(adminInactivityTimer)
            adminInactivityTimer = null
            return
        }
        const thirtyDays = 30 * 24 * 60 * 60 * 1000
        if (Date.now() - adminLastActive >= thirtyDays) {
            clearInterval(adminInactivityTimer)
            adminInactivityTimer = null

            const cleared = settings.adminNumber
            settings.adminNumber = ''
            settings.adminJid    = ''
            saveSettings()

            // FIX BUG-15: use full CREATOR_JID (valid JID) not bare creatorNumber digits
            const creatorJid = process.env.CREATOR_JID || ''
            if (creatorJid) {
                try {
                    await sendSafeMessage(sock, creatorJid, {
                        text:
                            `⚠️ *Admin Slot Auto-Cleared*\n\n` +
                            `${cleared} has been inactive for *30 days* — the admin slot has been reset.\n\n` +
                            `The bot is now unconfigured. The next */admin* request will begin fresh onboarding. 🚀`
                    })
                } catch (_) {}
            }
            console.log(`[inactivity] Admin slot cleared — ${cleared} inactive for 30 days.`)
        }
    }, 60 * 60 * 1000)
}

// ─── Help dashboard ───────────────────────────────────────────
function buildHelpText(settings, forCreator = false) {
    const tier = forCreator
        ? `👑 *CREATOR — Unrestricted Access*`
        : `🛡️ *Administrator*`

    return (
        `╔══════════════════════════╗\n` +
        `   🎮  WRG Admin Dashboard\n` +
        `╚══════════════════════════╝\n` +
        `${tier}\n` +
        `_Sky Graphics — Word Riddle Game_\n\n` +
        `All commands work from *any chat*.\n` +
        `Every reply comes to *your DM only*.\n\n` +
        `Reply with *1*, *2*, or *3* for a category — or just use any command directly:\n\n` +

        `*1️⃣ Settings*\n` +
        `› \`/set difficulty [easy/normal/difficult]\`\n` +
        `› \`/set admin [number]\` → \`/confirm\` · \`/cancel\`\n` +
        `› \`/set public [on/off]\` — non-admin visibility\n` +
        `› \`/set start [on/off]\` — public lobby start\n` +
        `› \`/set maxtries [n]\` — attempt budget\n` +
        `› \`/clearadmin\` — clear admin slot only (keeps pools)\n` +
        `› \`/reset\` — ⚠️ wipe ALL data\n\n` +

        `*2️⃣ Word Pools*\n` +
        `› \`/addword [level] [word]\`\n` +
        `› \`/removeword [level] [word]\`\n` +
        `› \`/listwords [level]\`\n` +
        `› \`/setwords [level] w1 w2 ...\` — replace pool\n` +
        `› \`/clearwords [level]\` — cannot empty last pool\n` +
        `› \`/setallwords easy:w1,w2 normal:w3 difficult:w4\`\n\n` +

        `*3️⃣ Game Controls*\n` +
        `› \`/status\` — live game state in your DM\n` +
        `› \`/pause\` — freeze turn timer\n` +
        `› \`/resume\` — unfreeze\n` +
        `› \`/end\` · \`/stop\` — kill active game\n\n` +

        (forCreator
            ? `*🔐 Creator-Only:*\n` +
              `› \`/approve [number]\` — send access key to requester\n` +
              `› \`/deny [number]\` — void their key immediately\n\n`
            : '') +

        `*📊 Live Config:*\n` +
        `› Difficulty: *${settings.difficulty.toUpperCase()}*\n` +
        `› Max Tries: *${settings.maxTries}*\n` +
        `› Public Visible: *${settings.publicVisible ? '🟢 ON' : '🔴 OFF'}*\n` +
        `› Public Can Start: *${settings.publicCanStart ? '🟢 ON' : '🔴 OFF'}*\n` +
        `› Admin Set: *${settings.adminNumber ? '✅ ' + settings.adminNumber : '❌ None'}*\n\n` +

        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `_WRG Bot · Sky Graphics_ 🎨`
    )
}

// ─── Main handler ─────────────────────────────────────────────
async function handleAdminCommand(ctx) {
    cleanExpiredKeys()

    const {
        sock, settings, words, games, activeGameChatRef,
        pendingAdminChangeRef, saveSettings, saveWords, persistGames,
        sendSafeMessage, getGameState, startTurnCountdown,
        DEFAULT_WORDS, fs,
        senderNumber, senderJid, senderName, body, senderTier
    } = ctx

    // requesterJid — always built from the plain phone number so the message
    // goes to the requester's own DM, never contaminated by CREATOR_JID.
    // This is what ensures /admin responses land in the correct person's DM.
    const requesterJid = senderNumber ? `${senderNumber}@s.whatsapp.net` : senderJid

    const creatorJid    = process.env.CREATOR_JID || ''
    const creatorNumber = creatorJid.split('@')[0].split(':')[0]

    // FIX BUG-11: derive tier from ctx.senderTier (computed in index.js)
    // and expose isAdmin / senderIsCreator from it
    const senderIsCreator = senderTier === TIERS.CREATOR
    const isAdmin         = senderTier === TIERS.CREATOR || senderTier === TIERS.ADMIN

    // FIX BUG-11: tier is now always defined
    const tier = senderTier || TIERS.PUBLIC

    const raw = body.slice(1).trim()
    const cmd = raw.split(' ')

    // Bump inactivity clock on every admin/creator command
    if (senderIsCreator || isAdmin) {
        adminLastActive = Date.now()
        if (settings.adminNumber && !adminInactivityTimer) {
            startAdminInactivityTimer(settings, saveSettings, sock, sendSafeMessage)
        }
    }

    // ══════════════════════════════════════════════
    //  /admin
    // ══════════════════════════════════════════════
    if (cmd[0] === 'admin') {

        // Creator gets special identity message — reply always to senderJid
        if (senderIsCreator) {
            await sendSafeMessage(sock, senderJid, {
                text:
                    `╔══════════════════════════╗\n` +
                    `   🔐  Sky Graphics Creator\n` +
                    `╚══════════════════════════╝\n\n` +
                    `Welcome back, *Founder*. 👋\n\n` +
                    `You have *unrestricted access* to every function of this bot — ` +
                    `no keys, no approvals, no gates.\n\n` +
                    `Type */help* to open the full dashboard.\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `_WRG Bot · Sky Graphics_ 🎨`
            })
            return
        }

        // FIX BUG-16: confirmed admin → reply to senderJid not adminJid
        if (isAdmin && settings.adminNumber !== '') {
            await sendSafeMessage(sock, senderJid, { text: buildHelpText(settings, false) })
            return
        }

        // Admin already set → subtle generic reply for non-admins
        if (settings.adminNumber !== '' && !isAdmin) {
            if (checkAdminRateLimit(senderNumber)) return
            await sendSafeMessage(sock, requesterJid, {
                text: `ℹ️ This bot is already configured. Contact the group admin for assistance.`
            })
            return
        }

        // ── First-time onboarding ──────────────────
        const input = cmd.slice(1).join(' ').trim()

        if (input) {
            if (checkAdminRateLimit(senderNumber)) return

            const session = pendingKeys[senderJid]

            if (!session) {
                await sendSafeMessage(sock, requesterJid, {
                    text:
                        `🔒 *Access Denied*\n\n` +
                        `No active configuration session was found for your account.\n\n` +
                        `If you believe this is an error, contact the *Sky Graphics* team. 📩`
                })
                return
            }

            if (Date.now() > session.expiresAt) {
                delete pendingKeys[senderJid]
                delete approvalQueue[senderNumber]
                await sendSafeMessage(sock, requesterJid, {
                    text:
                        `⏰ *Session Expired*\n\n` +
                        `Your configuration window has closed.\n\n` +
                        `Contact the *Sky Graphics* team to request access again. 📩`
                })
                return
            }

            if (input.toLowerCase() !== session.key.toLowerCase()) {
                session.attempts = (session.attempts || 0) + 1
                console.warn(`[SECURITY] Wrong key attempt ${session.attempts}/3 from ${senderNumber} (JID: ${senderJid})`)

                if (session.attempts >= 3) {
                    delete pendingKeys[senderJid]
                    delete approvalQueue[senderNumber]
                    await sendSafeMessage(sock, requesterJid, {
                        text:
                            `🚫 *Session Voided*\n\n` +
                            `Too many incorrect attempts. Your access session has been cancelled.\n\n` +
                            `Contact the *Sky Graphics* team to request a new key. 📩`
                    })
                    // FIX BUG-15: use creatorJid not creatorNumber
                    if (creatorJid) {
                        try {
                            await sendSafeMessage(sock, creatorJid, {
                                text:
                                    `⚠️ *Key Session Voided*\n\n` +
                                    `\`${senderNumber}\` made 3 incorrect key attempts — their session has been cancelled automatically. 🔒`
                            })
                        } catch (_) {}
                    }
                } else {
                    await sendSafeMessage(sock, requesterJid, {
                        text:
                            `❌ *Invalid Key*\n\n` +
                            `The key you entered is incorrect. (Attempt ${session.attempts}/3)\n\n` +
                            `Double-check the key and try again: \`/admin YOURKEY\` 🔑`
                    })
                }
                return
            }

            // ✅ Correct key — register as admin
            const approvedSession = { ...session }
            delete pendingKeys[senderJid]
            delete approvalQueue[senderNumber]

            settings.adminNumber = senderNumber
            settings.adminJid    = senderJid
            saveSettings()

            console.log(`👑 Admin registered — PN: ${senderNumber} | JID: ${senderJid}`)

            startAdminInactivityTimer(settings, saveSettings, sock, sendSafeMessage)

            await sendSafeMessage(sock, requesterJid, {
                text:
                    `╔══════════════════════════╗\n` +
                    `   👑  Access Granted\n` +
                    `╚══════════════════════════╝\n\n` +
                    `*Welcome, Administrator!* 🎉\n\n` +
                    `You now have full control of the *WRG Bot* for your community.\n\n` +
                    `Type */help* to see everything at your fingertips. ⚡\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `_WRG Bot · Sky Graphics_ 🎨`
            })

            // FIX BUG-15: notify creator via creatorJid not creatorNumber
            if (creatorJid) {
                try {
                    await sendSafeMessage(sock, creatorJid, {
                        text:
                            `✅ *Admin Registration Complete*\n\n` +
                            `👤 Name: *${approvedSession.senderName || 'Unknown'}*\n` +
                            `📱 Number: \`${senderNumber}\`\n\n` +
                            `_Bot is now live under new admin._ 🚀`
                    })
                } catch (_) {}
            }
            return
        }

        // No input — generate key, queue for creator approval
        if (checkAdminRateLimit(senderNumber)) return

        const newKey     = generateKey()
        const reqName    = senderName || senderNumber

        pendingKeys[senderJid] = {
            key: newKey,
            expiresAt: Date.now() + 10 * 60 * 1000,
            senderNumber,
            senderName: reqName
        }
        approvalQueue[senderNumber] = senderJid

        await sendSafeMessage(sock, requesterJid, {
            text:
                `╔══════════════════════════╗\n` +
                `   🔐  Admin Configuration\n` +
                `╚══════════════════════════╝\n` +
                `_WRG Bot · by Sky Graphics_ 🎨\n\n` +
                `Hello! 👋\n\n` +
                `You're attempting to access the *Bot Administration Panel*.\n\n` +
                `To proceed, enter the access key provided to you by the *Sky Graphics team*:\n\n` +
                `\`/admin YOURKEY\`\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📩 Don't have a key? Contact Sky Graphics to request access.`
        })

        // FIX BUG-15: alert creator via creatorJid
        if (creatorJid) {
            try {
                await sendSafeMessage(sock, creatorJid, {
                    text:
                        `╔══════════════════════════╗\n` +
                        `   🔔  Admin Access Request\n` +
                        `╚══════════════════════════╝\n\n` +
                        `Someone is requesting admin access to your bot.\n\n` +
                        `👤 *Name:* ${reqName}\n` +
                        `📱 *Number:* \`${senderNumber}\`\n` +
                        `🗝️ *Key:* \`${newKey}\`\n\n` +
                        `*What do you want to do?*\n\n` +
                        `✅ To *approve* and send them the key:\n` +
                        `\`/approve ${senderNumber}\`\n\n` +
                        `❌ To *deny* and void the key immediately:\n` +
                        `\`/deny ${senderNumber}\`\n\n` +
                        `_If you do nothing, the key auto-expires in 10 minutes._\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `_WRG Bot · Sky Graphics_ 🎨`
                })
            } catch (err) {
                console.log('⚠️ Could not DM creator with key request:', err.message)
                console.log(`[FALLBACK] Admin key for ${senderNumber}: ${newKey}`)
            }
        } else {
            console.log(`[NO CREATOR_JID SET] Admin key for ${senderNumber}: ${newKey}`)
        }
        return
    }

    // ══════════════════════════════════════════════
    //  /approve [number] — CREATOR ONLY
    // ══════════════════════════════════════════════
    if (cmd[0] === 'approve') {
        if (!senderIsCreator) return

        const targetNumber = (cmd[1] || '').replace(/[^0-9]/g, '')
        if (!targetNumber) {
            // FIX BUG-15: reply to creatorJid not creatorNumber
            await sendSafeMessage(sock, creatorJid, {
                text: `⚠️ Usage: \`/approve [number]\``
            })
            return
        }

        const targetJid = approvalQueue[targetNumber]
        if (!targetJid || !pendingKeys[targetJid]) {
            await sendSafeMessage(sock, creatorJid, {
                text:
                    `⚠️ *No active request found for* \`${targetNumber}\`\n\n` +
                    `The session may have already expired or been denied.`
            })
            return
        }

        const session = pendingKeys[targetJid]

        if (Date.now() > session.expiresAt) {
            delete pendingKeys[targetJid]
            delete approvalQueue[targetNumber]
            await sendSafeMessage(sock, creatorJid, {
                text: `⏰ *Too late* — the session for \`${targetNumber}\` already expired.`
            })
            return
        }

        try {
            await sendSafeMessage(sock, targetJid, {
                text:
                    `╔══════════════════════════╗\n` +
                    `   🗝️  Your Access Key\n` +
                    `╚══════════════════════════╝\n` +
                    `_From the Sky Graphics Team_ 🎨\n\n` +
                    `Your request has been *approved*. ✅\n\n` +
                    `Here is your access key:\n\n` +
                    `*\`${session.key}\`*\n\n` +
                    `To activate your admin account, type:\n` +
                    `\`/admin ${session.key}\`\n\n` +
                    `⏰ *This key expires in 10 minutes.*\n` +
                    `Do not share it with anyone.\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `_WRG Bot · Sky Graphics_ 🎨`
            })

            await sendSafeMessage(sock, creatorJid, {
                text:
                    `✅ *Key delivered to* \`${targetNumber}\`\n\n` +
                    `They now have until the 10-minute window closes to activate. ⏱️`
            })
        } catch (err) {
            await sendSafeMessage(sock, creatorJid, {
                text: `⚠️ *Could not deliver key to* \`${targetNumber}\`: ${err.message}`
            })
        }
        return
    }

    // ══════════════════════════════════════════════
    //  /deny [number] — CREATOR ONLY
    // ══════════════════════════════════════════════
    if (cmd[0] === 'deny') {
        if (!senderIsCreator) return

        const targetNumber = (cmd[1] || '').replace(/[^0-9]/g, '')
        if (!targetNumber) {
            await sendSafeMessage(sock, creatorJid, {
                text: `⚠️ Usage: \`/deny [number]\``
            })
            return
        }

        const targetJid = approvalQueue[targetNumber]
        if (!targetJid || !pendingKeys[targetJid]) {
            await sendSafeMessage(sock, creatorJid, {
                text:
                    `⚠️ *No active request found for* \`${targetNumber}\`\n\n` +
                    `Already expired, approved, or never requested.`
            })
            return
        }

        delete pendingKeys[targetJid]
        delete approvalQueue[targetNumber]

        try {
            await sendSafeMessage(sock, targetJid, {
                text:
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `_Sky Graphics · WRG Bot_ 🎨\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `Your access request could not be processed at this time.\n\n` +
                    `For further assistance, contact the *Sky Graphics* team directly. 📩`
            })
        } catch (_) {}

        await sendSafeMessage(sock, creatorJid, {
            text:
                `🚫 *Request denied and key voided.*\n\n` +
                `\`${targetNumber}\` has been notified without details. 🔒`
        })
        return
    }

    // ══════════════════════════════════════════════
    //  /help — admin + creator only, DM only
    // ══════════════════════════════════════════════
    if (cmd[0] === 'help') {
        if (senderIsCreator) {
            await sendSafeMessage(sock, senderJid, { text: buildHelpText(settings, true) })
            return
        }
        if (isAdmin) {
            await sendSafeMessage(sock, senderJid, { text: buildHelpText(settings, false) })
            return
        }
        return
    }

    // ══════════════════════════════════════════════
    //  All commands below: creator OR confirmed admin only
    // ══════════════════════════════════════════════
    if (!senderIsCreator && !isAdmin) return

    // FIX BUG-14: always reply to senderJid — whoever sent the command
    const replyTo = senderJid

    // ─── /set difficulty ─────────────────────────
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

    // ─── /set admin ──────────────────────────────
    if (cmd[0] === 'set' && cmd[1] === 'admin') {
        const newAdmin = (cmd[2] || '').replace(/[^0-9]/g, '')
        if (newAdmin) {
            pendingAdminChangeRef.value = { number: newAdmin }
            await sendSafeMessage(sock, replyTo, {
                text:
                    `⚠️ *Confirm Admin Change?*\n\n` +
                    `New number: *${newAdmin}*\n\n` +
                    `Type */confirm* to apply, or */cancel* to discard.`
            })
        } else {
            await sendSafeMessage(sock, replyTo, {
                text: `⚠️ Usage: \`/set admin [full number with country code]\``
            })
        }
        return
    }

    if (cmd[0] === 'confirm') {
        if (pendingAdminChangeRef.value) {
            const confirmed = pendingAdminChangeRef.value
            pendingAdminChangeRef.value = null
            settings.adminNumber = confirmed.number
            settings.adminJid    = ''
            saveSettings()
            startAdminInactivityTimer(settings, saveSettings, sock, sendSafeMessage)
            await sendSafeMessage(sock, replyTo, {
                text:
                    `✅ *Admin updated to* \`${settings.adminNumber}\`\n\n` +
                    `New admin must send any message to the bot so their JID is captured. 📡`
            })
            try {
                await sendSafeMessage(sock, settings.adminNumber, {
                    text:
                        `╔══════════════════════════╗\n` +
                        `   👑  You're the Admin\n` +
                        `╚══════════════════════════╝\n\n` +
                        `Welcome! 🎉 You have been assigned as the *WRG Bot* administrator.\n\n` +
                        `Type */help* to see all your commands.\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `_WRG Bot · Sky Graphics_ 🎨`
                })
            } catch (err) {
                console.log('⚠️ Could not DM new admin:', err.message)
            }
        } else {
            await sendSafeMessage(sock, replyTo, {
                text: `⚠️ Nothing to confirm. Use \`/set admin [number]\` first.`
            })
        }
        return
    }

    if (cmd[0] === 'cancel') {
        if (pendingAdminChangeRef.value) {
            const cancelled = pendingAdminChangeRef.value.number
            pendingAdminChangeRef.value = null
            await sendSafeMessage(sock, replyTo, {
                text: `❌ Admin change to \`${cancelled}\` cancelled.`
            })
        } else {
            await sendSafeMessage(sock, replyTo, { text: `⚠️ Nothing to cancel.` })
        }
        return
    }

    // ─── /set maxtries ───────────────────────────
    if (cmd[0] === 'set' && cmd[1] === 'maxtries') {
        const n = parseInt(cmd[2], 10)
        if (Number.isInteger(n) && n > 0) {
            settings.maxTries = n
            saveSettings()
            await sendSafeMessage(sock, replyTo, {
                text: `⚙️ Max attempts per round: *${settings.maxTries}* 💥`
            })
        } else {
            await sendSafeMessage(sock, replyTo, {
                text: `⚠️ Usage: \`/set maxtries [positive number]\``
            })
        }
        return
    }

    // ─── /set public ─────────────────────────────
    if (cmd[0] === 'set' && cmd[1] === 'public') {
        const mode = cmd[2]
        if (mode === 'on' || mode === 'off') {
            writeSetting(tier, 'publicVisible', (mode === 'on'), settings)
            saveSettings()
            await sendSafeMessage(sock, replyTo, {
                text: settings.publicVisible
                    ? `🔓 *Public Visibility: ON*\nNon-admins can interact with the bot. 👥`
                    : `🔒 *Public Visibility: OFF*\nNon-admins are completely silenced. 🤐`
            })
        } else {
            await sendSafeMessage(sock, replyTo, { text: `⚠️ Usage: \`/set public [on/off]\`` })
        }
        return
    }

    // ─── /set start ──────────────────────────────
    if (cmd[0] === 'set' && cmd[1] === 'start') {
        const mode = cmd[2]
        if (mode === 'on' || mode === 'off') {
            writeSetting(tier, 'publicCanStart', (mode === 'on'), settings)
            saveSettings()
            await sendSafeMessage(sock, replyTo, {
                text: settings.publicCanStart
                    ? `🔓 *Public Game Starts: ON*\nAnyone can type WRG to open a lobby. 🎮`
                    : `🔒 *Public Game Starts: OFF*\nOnly admin can open a lobby. 👑`
            })
        } else {
            await sendSafeMessage(sock, replyTo, { text: `⚠️ Usage: \`/set start [on/off]\`` })
        }
        return
    }

    // ─── Word pool commands ───────────────────────
    if (cmd[0] === 'addword') {
        const level = cmd[1], word = cmd[2]
        if (['easy', 'normal', 'difficult'].includes(level) && word) {
            const tw = word.trim().toLowerCase()
            if (words[level].includes(tw)) {
                await sendSafeMessage(sock, replyTo, {
                    text: `⚠️ *${tw.toUpperCase()}* is already in the *${level.toUpperCase()}* pool.`
                })
            } else if (words[level].length >= 10) {
                await sendSafeMessage(sock, replyTo, {
                    text: `⚠️ *${level.toUpperCase()}* pool is full (max 10). Remove one first.`
                })
            } else {
                words[level].push(tw)
                saveWords()
                await sendSafeMessage(sock, replyTo, {
                    text: `✅ *${tw.toUpperCase()}* added to *${level.toUpperCase()}* pool. 📚`
                })
            }
        } else {
            await sendSafeMessage(sock, replyTo, {
                text: `⚠️ Usage: \`/addword [easy/normal/difficult] [word]\``
            })
        }
        return
    }

    if (cmd[0] === 'removeword') {
        const level = cmd[1], word = cmd[2]
        if (['easy', 'normal', 'difficult'].includes(level) && word) {
            const tw    = word.trim().toLowerCase()
            const index = words[level].indexOf(tw)
            if (index !== -1) {
                words[level].splice(index, 1)
                saveWords()
                await sendSafeMessage(sock, replyTo, {
                    text: `🗑️ *${tw.toUpperCase()}* removed from *${level.toUpperCase()}* pool.`
                })
            } else {
                await sendSafeMessage(sock, replyTo, {
                    text: `⚠️ *${tw.toUpperCase()}* not found in *${level.toUpperCase()}* pool.`
                })
            }
        } else {
            await sendSafeMessage(sock, replyTo, {
                text: `⚠️ Usage: \`/removeword [easy/normal/difficult] [word]\``
            })
        }
        return
    }

    if (cmd[0] === 'listwords') {
        const level = cmd[1]
        if (['easy', 'normal', 'difficult'].includes(level)) {
            const list = words[level].join(', ')
            await sendSafeMessage(sock, replyTo, {
                text: `📖 *${level.toUpperCase()} Pool:*\n\n${list || '[Empty — use /addword to add words]'}`
            })
        } else {
            await sendSafeMessage(sock, replyTo, {
                text: `⚠️ Usage: \`/listwords [easy/normal/difficult]\``
            })
        }
        return
    }

    if (cmd[0] === 'setwords') {
        const level    = cmd[1]
        const newWords = cmd.slice(2).map(w => w.trim().toLowerCase()).filter(Boolean)
        if (['easy', 'normal', 'difficult'].includes(level) && newWords.length > 0) {
            if (newWords.length > 10) {
                await sendSafeMessage(sock, replyTo, {
                    text: `⚠️ Maximum 10 words per pool. You provided ${newWords.length}.`
                })
            } else {
                words[level] = [...new Set(newWords)]
                saveWords()
                await sendSafeMessage(sock, replyTo, {
                    text: `✅ *${level.toUpperCase()}* pool replaced with ${words[level].length} word(s). 📚`
                })
            }
        } else {
            await sendSafeMessage(sock, replyTo, {
                text: `⚠️ Usage: \`/setwords [easy/normal/difficult] word1 word2 ...\``
            })
        }
        return
    }

    if (cmd[0] === 'clearwords') {
        const level = cmd[1]
        if (['easy', 'normal', 'difficult'].includes(level)) {
            const otherLevels   = ['easy', 'normal', 'difficult'].filter(l => l !== level)
            const otherHasWords = otherLevels.some(l => words[l] && words[l].length > 0)
            if (!otherHasWords) {
                await sendSafeMessage(sock, replyTo, {
                    text:
                        `⚠️ *Cannot clear ${level.toUpperCase()} pool.*\n\n` +
                        `It's the only pool with words. Clearing it would crash the game when a word is picked.\n\n` +
                        `Add words to another pool first, then clear this one. 📚`
                })
                return
            }
            words[level] = []
            saveWords()
            await sendSafeMessage(sock, replyTo, {
                text: `🗑️ *${level.toUpperCase()}* pool cleared.`
            })
        } else {
            await sendSafeMessage(sock, replyTo, {
                text: `⚠️ Usage: \`/clearwords [easy/normal/difficult]\``
            })
        }
        return
    }

    if (cmd[0] === 'setallwords') {
        const payload  = cmd.slice(1).join(' ')
        const segments = payload.split(/\s+(?=(easy|normal|difficult):)/i).filter(Boolean)
        const newPools = {}
        let valid = true
        for (const segment of segments) {
            const colonIdx = segment.indexOf(':')
            if (colonIdx === -1) { valid = false; break }
            const level = segment.slice(0, colonIdx).trim().toLowerCase()
            const list  = segment.slice(colonIdx + 1)
            if (!['easy', 'normal', 'difficult'].includes(level)) { valid = false; break }
            const items = list.split(',').map(w => w.trim().toLowerCase()).filter(Boolean)
            if (items.length > 10) {
                await sendSafeMessage(sock, replyTo, {
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
            await sendSafeMessage(sock, replyTo, {
                text: `✅ Pools updated: ${Object.keys(newPools).map(l => l.toUpperCase()).join(', ')} 📚`
            })
        } else if (valid) {
            await sendSafeMessage(sock, replyTo, {
                text: `⚠️ Usage: \`/setallwords easy:w1,w2 normal:w3 difficult:w4\``
            })
        }
        return
    }

    // ─── /clearadmin ─────────────────────────────
    if (cmd[0] === 'clearadmin') {
        const cleared = settings.adminNumber
        settings.adminNumber = ''
        settings.adminJid    = ''
        saveSettings()
        if (adminInactivityTimer) {
            clearInterval(adminInactivityTimer)
            adminInactivityTimer = null
        }
        await sendSafeMessage(sock, replyTo, {
            text:
                `✅ *Admin slot cleared.*\n\n` +
                `${cleared || 'No admin'} has been removed. Word pools and settings are untouched.\n\n` +
                `The next */admin* request will begin a fresh onboarding. 🔑`
        })
        return
    }

    // ─── /reset ──────────────────────────────────
    if (cmd[0] === 'reset') {
        Object.assign(settings, {
            adminNumber: '', adminJid: '',
            difficulty: 'easy', maxTries: 10,
            prefix: 'wrg', adminPrefix: '/',
            publicVisible: true, publicCanStart: false
        })
        pendingAdminChangeRef.value = null
        Object.assign(words, JSON.parse(JSON.stringify(DEFAULT_WORDS)))
        saveWords()
        if (adminInactivityTimer) {
            clearInterval(adminInactivityTimer)
            adminInactivityTimer = null
        }
        const SETTINGS_FILE = 'settings.json'
        const GAMES_FILE    = 'games.json'
        if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE)
        if (fs.existsSync(GAMES_FILE))    fs.unlinkSync(GAMES_FILE)
        for (const key in games) {
            const g = games[key]
            if (g.lobbyTimer) clearInterval(g.lobbyTimer)
            if (g.turnTimer)  clearInterval(g.turnTimer)
            delete games[key]
        }
        activeGameChatRef.value = null
        await sendSafeMessage(sock, replyTo, {
            text:
                `🔄 *Full Reset Complete* ✅\n\n` +
                `All settings, games, and word pools restored to defaults.\n\n` +
                `The bot is now unconfigured. The next */admin* request will begin a fresh onboarding. 🚀`
        })
        return
    }

    // ─── /status ─────────────────────────────────
    if (cmd[0] === 'status') {
        // FIX BUG-13: pass games as second arg to getGameState
        const activeGameChat = activeGameChatRef.value
        if (!activeGameChat) {
            await sendSafeMessage(sock, replyTo, {
                text:
                    `📊 *WRG Bot Status*\n\n` +
                    `🎮 No game or lobby is currently active.\n\n` +
                    `*Config:*\n` +
                    `› Difficulty: *${settings.difficulty.toUpperCase()}*\n` +
                    `› Max Tries: *${settings.maxTries}*\n` +
                    `› Public Visible: *${settings.publicVisible ? '🟢 ON' : '🔴 OFF'}*\n` +
                    `› Public Can Start: *${settings.publicCanStart ? '🟢 ON' : '🔴 OFF'}*\n` +
                    `› Admin: *${settings.adminNumber || 'None'}*`
            })
        } else {
            const gs = getGameState(activeGameChat, games)
            let statusText = `📊 *WRG Bot Status*\n\n`

            if (gs.lobbyActive) {
                statusText += `🏠 *LOBBY OPEN* — ${activeGameChat}\n`
                statusText += `👥 Players joined: *${gs.players.length}*\n`
                statusText += `⏱️ Time left: *${gs.lobbySecondsLeft}s*\n`
                if (gs.players.length > 0) {
                    statusText += `\n*Players:*\n`
                    gs.players.forEach((num, i) => {
                        statusText += `${i + 1}. ${gs.playerNames[num] || num}\n`
                    })
                }
            } else if (gs.active) {
                const currentPlayer = gs.players[gs.currentTurnIndex]
                statusText += `🎮 *GAME IN PROGRESS* — ${activeGameChat}\n`
                statusText += gs.paused ? `⏸️ Status: *PAUSED*\n` : `▶️ Status: *LIVE*\n`
                statusText += `📝 Word: \`${gs.hiddenWord.join(' ')}\` (${gs.targetWord.length} letters)\n`
                const attemptsUsed = Object.values(gs.attempts || {}).reduce((a, b) => a + b, 0)
                statusText += `💥 Wrong guesses so far: *${attemptsUsed}* total (max ${settings.maxTries}/player)\n`
                statusText += `🎯 Current turn: *${gs.playerNames[currentPlayer] || currentPlayer}*\n`
                statusText += `👥 Players: *${gs.players.length}*\n`
                if (!gs.paused) statusText += `⏱️ Turn timer: *${gs.turnSecondsLeft}s*\n`
            }

            statusText += `\n*Config:*\n`
            statusText += `› Difficulty: *${settings.difficulty.toUpperCase()}*\n`
            statusText += `› Max Tries: *${settings.maxTries}*`

            await sendSafeMessage(sock, replyTo, { text: statusText })
        }
        return
    }

    // ─── Game control commands ────────────────────
    const activeGameChat = activeGameChatRef.value

    if (cmd[0] === 'pause') {
        if (!activeGameChat) {
            await sendSafeMessage(sock, replyTo, { text: `⚠️ No active game to pause right now.` })
        } else {
            // FIX BUG-13: pass games to getGameState
            const gs = getGameState(activeGameChat, games)
            if (gs.active && !gs.paused) {
                gs.paused = true
                persistGames()
                await sendSafeMessage(sock, replyTo, { text: `⏸️ *Game paused.* ✅` })
                await sock.sendMessage(activeGameChat, {
                    text: `⏸️ *Game paused by the admin.* Sit tight — we'll be right back! ☕`
                })
            } else {
                await sendSafeMessage(sock, replyTo, {
                    text: `⚠️ Game is already paused or no round is in progress.`
                })
            }
        }
        return
    }

    if (cmd[0] === 'resume') {
        if (!activeGameChat) {
            await sendSafeMessage(sock, replyTo, { text: `⚠️ No active game to resume right now.` })
        } else {
            // FIX BUG-13: pass games to getGameState
            const gs = getGameState(activeGameChat, games)
            if (gs.active && gs.paused) {
                gs.paused = false
                persistGames()
                await sendSafeMessage(sock, replyTo, { text: `▶️ *Game resumed!* ✅` })
                await sock.sendMessage(activeGameChat, {
                    text: `▶️ *Game resumed by the admin!* Back in action — keep guessing! 🔥`
                })
                // FIX BUG-12: pass both chatId and a valid ctx to startTurnCountdown
                startTurnCountdown(activeGameChat, {
                    sock, games, settings, activeGameChatRef, persistGames, nameCache: ctx.nameCache
                })
            } else {
                await sendSafeMessage(sock, replyTo, {
                    text: `⚠️ Game is not currently paused.`
                })
            }
        }
        return
    }

    if (cmd[0] === 'end' || cmd[0] === 'stop') {
        if (!activeGameChat) {
            await sendSafeMessage(sock, replyTo, { text: `⚠️ No active game or lobby to end right now.` })
        } else {
            // FIX BUG-13: pass games to getGameState
            const gs        = getGameState(activeGameChat, games)
            const endedChat = activeGameChat
            gs.active = false
            gs.lobbyActive = false
            if (gs.lobbyTimer) clearInterval(gs.lobbyTimer)
            if (gs.turnTimer)  clearInterval(gs.turnTimer)
            gs.players = []
            gs.playerNames = {}
            gs.skipStreaks = {}
            gs.disqualified = []
            activeGameChatRef.value = null
            persistGames()
            await sendSafeMessage(sock, replyTo, { text: `🛑 *Game terminated.* ✅` })
            await sock.sendMessage(endedChat, {
                text: `🛑 *Game terminated by the admin.* Thanks for playing, everyone! 👋`
            })
        }
        return
    }

    // Unknown command — absolute silence
}

module.exports = { handleAdminCommand }
