// ============================================================
//  gameEngine.js — WRG Bot · Sky Graphics
//  Pure game logic: lobby, countdowns, boards, turn management.
//  Imports permissions.js for difficulty display + nameTag only.
//  No admin logic, no command handling.
// ============================================================

const matchSummary = require('./matchSummary')
const { difficultyBadge, nameTag, resolveSetting } = require('./permissions')

const DEFAULT_WORDS = {
    easy:      ['apple', 'bread', 'cloud', 'dance', 'earth', 'flame', 'grape', 'house', 'ivory', 'juice'],
    normal:    ['browser', 'element', 'network', 'program', 'website', 'database', 'keyboard', 'science', 'offline', 'desktop'],
    difficult: ['algorithm', 'blockchain', 'cryptography', 'deployment', 'encryption', 'framework', 'governance', 'hierarchy', 'interface', 'javascript']
}

// ─── Automated maxTries ────────────────────────────────────────
// Per the spec's mandatory addition: a flat manual number is the wrong
// design for a word game with variable-length words across three
// difficulty tiers. Attempts scale with word length and tighten as
// difficulty increases. settings.maxTries can be either:
//   - the string 'auto' (default) → this formula runs at word-pick time
//   - a positive integer → manual override, used as-is
// The result is snapshotted onto gameState.roundMaxTries the moment the
// word is picked, so a live /set maxtries change never affects a round
// already in progress — only the NEXT round.
function calcMaxTries(word, difficulty) {
    const len = (word || '').length
    switch (difficulty) {
        case 'easy':      return Math.max(4, Math.ceil(len * 0.8))
        case 'normal':    return Math.max(3, Math.ceil(len * 0.6))
        case 'difficult': return Math.max(3, Math.ceil(len * 0.4))
        default:          return Math.max(3, Math.ceil(len * 0.6))
    }
}

// Resolves the maxTries value that should apply to a freshly-started round.
// Reads the effective (creator-override-aware) setting; if it's not a
// resolvable positive integer, falls back to the automated formula.
function resolveRoundMaxTries(word, difficulty, settings) {
    const configured = resolveSetting('maxTries', settings, 'auto')
    if (configured === 'auto' || configured === undefined || configured === null) {
        return calcMaxTries(word, difficulty)
    }
    const n = typeof configured === 'number' ? configured : parseInt(configured, 10)
    if (Number.isInteger(n) && n > 0) return n
    return calcMaxTries(word, difficulty)
}

// ─── getGameState ─────────────────────────────────────────────
/**
 * Returns (and lazily creates) the game state for a chat.
 * NOTE: difficulty is NOT cached on gameState — it is always read
 * live from settings at word-pick time so /set difficulty takes
 * effect immediately, even mid-lobby.
 */
function getGameState(chatId, games) {
    if (!games[chatId]) {
        games[chatId] = {
            active:          false,
            lobbyActive:     false,
            lobbyTimer:      null,
            lobbySecondsLeft: 60,
            turnTimer:       null,
            turnSecondsLeft: 30,
            targetWord:      '',
            hiddenWord:      [],
            attempts:        {},   // per-player: { [playerNumber]: count }
            players:         [],
            playerNames:     {},
            playerJids:      {},   // { [playerNumber]: JID } — resolved at join time
            skipStreaks:     {},
            disqualified:    [],
            currentTurnIndex: 0,
            paused:          false
        }
    }
    // Migrate old single-number attempts field to object (safe on old persisted state)
    if (typeof games[chatId].attempts === 'number') games[chatId].attempts = {}
    if (!games[chatId].disqualified) games[chatId].disqualified = []
    if (!games[chatId].playerJids)   games[chatId].playerJids   = {}
    return games[chatId]
}

// ─── Lobby countdown ──────────────────────────────────────────
/**
 * ctx = { sock, games, settings, words, activeGameChatRef, persistGames, nameCache }
 */
function startLobbyCountdown(chatId, ctx) {
    const { sock, games, settings, persistGames } = ctx
    const gameState = getGameState(chatId, games)
    if (gameState.lobbyTimer) clearInterval(gameState.lobbyTimer)

    gameState.lobbyTimer = setInterval(async () => {
        if (!gameState.lobbyActive) {
            clearInterval(gameState.lobbyTimer)
            return
        }

        gameState.lobbySecondsLeft--

        if (gameState.lobbySecondsLeft <= 0) {
            clearInterval(gameState.lobbyTimer)
            await startActualGame(chatId, ctx)

        } else if (gameState.lobbySecondsLeft % 10 === 0) {
            // Read effective difficulty (creator override aware) LIVE — not cached
            const difficulty = resolveSetting('difficulty', settings, 'easy')
            const lobbyMentions = gameState.players.map(num => gameState.playerJids[num]).filter(Boolean)
            const lobbyText = gameState.players
                .map((num, i) => `${i + 1}. ${nameTag(num, gameState.playerNames, settings)}`)
                .join('\n')

            await sock.sendMessage(chatId, {
                text:
                    `⏱️ *WRG Lobby — Hurry Up!*\n` +
                    `*${gameState.lobbySecondsLeft} seconds* left to join! Type *wrg join* now.\n` +
                    `🎯 Mode: ${difficultyBadge(difficulty)}\n\n` +
                    `👥 *Current Lobby:*\n${lobbyText || '[No players yet — be first! 🎯]'}`,
                mentions: lobbyMentions
            })
        }
        persistGames()
    }, 1000)
}

// ─── Start actual game ────────────────────────────────────────
async function startActualGame(chatId, ctx) {
    const { sock, games, settings, words, activeGameChatRef, persistGames } = ctx
    const gameState = getGameState(chatId, games)
    gameState.lobbyActive = false
    if (gameState.lobbyTimer) clearInterval(gameState.lobbyTimer)

    if (gameState.players.length === 0) {
        gameState.active = false
        activeGameChatRef.value = null
        persistGames()
        return await sock.sendMessage(chatId, {
            text: `🚫 *Game Cancelled*\nNo one joined the lobby in time. Type *WRG* to start a fresh lobby! 🎮`
        })
    }

    // Always read effective difficulty (creator override aware) LIVE at word-pick time
    const difficulty = resolveSetting('difficulty', settings, 'easy')
    const pool = (words[difficulty] && words[difficulty].length > 0)
        ? words[difficulty]
        : DEFAULT_WORDS[difficulty]

    gameState.targetWord      = pool[Math.floor(Math.random() * pool.length)]
    gameState.hiddenWord      = gameState.targetWord.split('').map(() => '_')
    gameState.attempts        = {}   // reset per-player attempts object
    gameState.skipStreaks     = {}
    gameState.disqualified    = []
    gameState.currentTurnIndex = 0
    gameState.active          = true
    gameState.paused          = false
    // Snapshot this round's attempt budget NOW so a later /set maxtries
    // change (manual or auto) never affects a round already in progress.
    gameState.roundMaxTries   = resolveRoundMaxTries(gameState.targetWord, difficulty, settings)

    const lobbyMentions = gameState.players.map(num => gameState.playerJids[num]).filter(Boolean)
    const lobbyText = gameState.players
        .map((num, i) => `${i + 1}. ${nameTag(num, gameState.playerNames, settings)}`)
        .join('\n')

    await sock.sendMessage(chatId, {
        text:
            `🎬 *Lobby Closed — Game On!*\n\n` +
            `🎯 *Mode:* ${difficultyBadge(difficulty)}\n` +
            `💥 *Attempts per player:* ${gameState.roundMaxTries}\n\n` +
            `👥 *Final Player Lineup:*\n${lobbyText}\n\n` +
            `🏆 May the best guesser win!`,
        mentions: lobbyMentions
    })

    persistGames()
    await sendGameBoard(chatId, '', [], ctx)
}

// ─── Game board ───────────────────────────────────────────────
async function sendGameBoard(chatId, actionFeedback = '', extraMentions = [], ctx) {
    const { sock, games, settings, persistGames } = ctx
    const gameState = getGameState(chatId, games)
    if (!gameState.active) return

    const difficulty = resolveSetting('difficulty', settings, 'easy')
    // Use the round's snapshotted attempt budget — never the live settings
    // value — so a mid-round /set maxtries change doesn't retroactively
    // change this round's math (it will apply starting next round).
    const roundMaxTries = gameState.roundMaxTries || calcMaxTries(gameState.targetWord, difficulty)

    const currentPlayerNumber = gameState.players[gameState.currentTurnIndex]
    const currentPlayerJid    = gameState.playerJids[currentPlayerNumber]
    const currentPlayerName   = nameTag(currentPlayerNumber, gameState.playerNames, settings)

    const hasMultiplePlayers = gameState.players.length > 1
    let nextPlayerName = null, nextPlayerJid = null

    if (hasMultiplePlayers) {
        const nextIndex      = (gameState.currentTurnIndex + 1) % gameState.players.length
        const nextNumber     = gameState.players[nextIndex]
        nextPlayerJid        = gameState.playerJids[nextNumber]
        nextPlayerName       = nameTag(nextNumber, gameState.playerNames, settings)
    }

    const playerAttempts  = gameState.attempts[currentPlayerNumber] || 0
    const attemptsLeft    = roundMaxTries - playerAttempts

    let boardText = ''
    if (actionFeedback) boardText += `${actionFeedback}\n\n`

    boardText += `🎮 *Word Riddle Game (WRG)*\n`
    boardText += `🎯 Mode: ${difficultyBadge(difficulty)}\n\n`
    boardText += `📝 Word: \`${gameState.hiddenWord.join(' ')}\` *(${gameState.targetWord.length} letters)*\n`
    boardText += `💥 *${currentPlayerName}'s attempts left: ${attemptsLeft}/${roundMaxTries}*\n\n`
    boardText += `🎯 *Your turn:* ${currentPlayerName}\n`

    if (hasMultiplePlayers) {
        boardText += `⏭️ *Up next:* ${nextPlayerName}\n\n`
    } else {
        boardText += `🕹️ Playing solo — no pressure... just all of it 😄\n\n`
    }
    boardText += `_⏱️ You have 30 seconds — guess a letter or the full word!_`

    const mentionJids = [...new Set([
        ...(currentPlayerJid ? [currentPlayerJid] : []),
        ...(nextPlayerJid    ? [nextPlayerJid]    : []),
        ...extraMentions
    ])]

    await sock.sendMessage(chatId, { text: boardText, mentions: mentionJids })

    persistGames()
    startTurnCountdown(chatId, ctx)
}

// ─── Turn countdown ───────────────────────────────────────────
function startTurnCountdown(chatId, ctx) {
    const { sock, games, settings, activeGameChatRef, persistGames, nameCache } = ctx
    const gameState = getGameState(chatId, games)
    if (gameState.turnTimer) clearInterval(gameState.turnTimer)

    gameState.turnSecondsLeft = 30

    gameState.turnTimer = setInterval(async () => {
        if (!gameState.active || gameState.paused) {
            clearInterval(gameState.turnTimer)
            return
        }

        gameState.turnSecondsLeft--

        const currentPlayerNumber = gameState.players[gameState.currentTurnIndex]
        const currentPlayerJid    = gameState.playerJids[currentPlayerNumber]
        const currentPlayerName   = nameTag(currentPlayerNumber, gameState.playerNames, settings)

        if (gameState.turnSecondsLeft <= 0) {
            clearInterval(gameState.turnTimer)

            // Timeout counts as a skip — does NOT use the per-player attempts object
            gameState.skipStreaks[currentPlayerNumber] = (gameState.skipStreaks[currentPlayerNumber] || 0) + 1
            const skipCount  = gameState.skipStreaks[currentPlayerNumber]
            const removedIndex = gameState.currentTurnIndex

            if (skipCount >= 3) {
                // 3 consecutive skips — disqualify
                matchSummary.recordDisqualification(gameState, currentPlayerNumber, matchSummary.DQ_REASONS.SKIPPED_3)

                // Clean up player data
                if (gameState.players.includes(currentPlayerNumber)) {
                    gameState.players.splice(gameState.players.indexOf(currentPlayerNumber), 1)
                }
                delete gameState.playerNames[currentPlayerNumber]
                delete gameState.playerJids[currentPlayerNumber]
                delete gameState.skipStreaks[currentPlayerNumber]
                delete gameState.attempts[currentPlayerNumber]

                const dqText =
                    `🚫 *Disqualified!*\n` +
                    `*${currentPlayerName}* skipped *3 turns in a row* and has been removed. 👋`

                const lastStanding = matchSummary.checkLastPlayerStanding(gameState)
                if (lastStanding) {
                    gameState.active = false
                    activeGameChatRef.value = null
                    await sock.sendMessage(chatId, {
                        text:
                            `${dqText}\n\n` +
                            `🏆 *LAST PLAYER STANDING!*\n` +
                            `The word was *${gameState.targetWord.toUpperCase()}*. 🎉`
                    })
                    await matchSummary.sendMatchReport(sock, chatId, gameState, { type: 'last_standing', winnerNumber: lastStanding }, (n) => nameTag(n, gameState.playerNames, settings))
                    gameState.players = []
                    persistGames()
                    return
                }

                if (gameState.players.length === 0) {
                    gameState.active = false
                    activeGameChatRef.value = null
                    await sock.sendMessage(chatId, {
                        text: `${dqText}\n\n💀 *GAME OVER!* No players remain. The word was *${gameState.targetWord.toUpperCase()}*.`
                    })
                    await matchSummary.sendMatchReport(sock, chatId, gameState, { type: 'no_winner' }, (n) => nameTag(n, gameState.playerNames, settings))
                    persistGames()
                    return
                }

                gameState.currentTurnIndex = removedIndex % gameState.players.length
                await sendGameBoard(chatId, dqText, [], ctx)
                return
            }

            // Normal timeout — rotate turn, no attempts penalty
            const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
            gameState.currentTurnIndex = nextTurnIndex

            const feedback =
                `⏰ *Timeout!*\n` +
                `*${currentPlayerName}* took too long. ` +
                `(${skipCount}/3 strikes before lockout 🟥)`

            await sendGameBoard(chatId, feedback, [], ctx)

        } else if (gameState.turnSecondsLeft === 20) {
            const difficulty = resolveSetting('difficulty', settings, 'easy')
            await sock.sendMessage(chatId, {
                text:
                    `⏱️ *${currentPlayerName}, 20 seconds left!* Make your move — ` +
                    `guess a letter or the full word! 🤔\n` +
                    `_Mode: ${difficultyBadge(difficulty)}_`,
                mentions: currentPlayerJid ? [currentPlayerJid] : []
            })
        } else if (gameState.turnSecondsLeft === 10) {
            await sock.sendMessage(chatId, {
                text: `🚨 *${currentPlayerName} — 10 seconds! GO GO GO!* ⚡`,
                mentions: currentPlayerJid ? [currentPlayerJid] : []
            })
        }

        persistGames()
    }, 1000)
}

module.exports = {
    DEFAULT_WORDS,
    getGameState,
    startLobbyCountdown,
    startActualGame,
    sendGameBoard,
    startTurnCountdown,
    calcMaxTries,
    resolveRoundMaxTries
}