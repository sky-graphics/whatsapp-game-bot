// ============================================================
//  gameEngine.js — WRG Bot · Sky Graphics
//  Pure game logic: lobby, countdowns, boards, turn management
//  No global state — everything passed via context object
// ============================================================

const matchSummary = require('./matchSummary')

const DEFAULT_WORDS = {
    easy: ['apple', 'bread', 'cloud', 'dance', 'earth', 'flame', 'grape', 'house', 'ivory', 'juice'],
    normal: ['browser', 'element', 'network', 'program', 'website', 'database', 'keyboard', 'science', 'offline', 'desktop'],
    difficult: ['algorithm', 'blockchain', 'cryptography', 'deployment', 'encryption', 'framework', 'governance', 'hierarchy', 'interface', 'javascript']
}

/**
 * Returns (and lazily creates) the game state object for a given chat.
 */
function getGameState(chatId, games, settings) {
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
            attempts: {},       // Per-player attempt counters: { playerNumber: count }
            players: [],
            playerNames: {},
            skipStreaks: {},
            disqualified: [],
            currentTurnIndex: 0,
            difficulty: settings.difficulty,
            paused: false
        }
    }
    if (!games[chatId].disqualified) games[chatId].disqualified = []
    // Migrate any old installs that stored attempts as a number
    if (typeof games[chatId].attempts === 'number') games[chatId].attempts = {}
    return games[chatId]
}

/**
 * Starts the 60-second lobby countdown.
 * ctx = { sock, games, settings, words, activeGameChatRef, persistGames, jidOf, tag }
 */
function startLobbyCountdown(chatId, ctx) {
    const { sock, games, settings, persistGames, jidOf } = ctx
    const gameState = getGameState(chatId, games, settings)
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
            const lobbyMentions = gameState.players.map(num => jidOf(num))
            const lobbyText = gameState.players
                .map((num, i) => `${i + 1}. @${num} (${gameState.playerNames[num] || num})`)
                .join('\n')

            await sock.sendMessage(chatId, {
                text:
                    `⏱️ *WRG Lobby — Hurry Up!*\n` +
                    `*${gameState.lobbySecondsLeft} seconds* left to join! Type *wrg join* now.\n\n` +
                    `👥 *Current Lobby:*\n${lobbyText || '[No players yet — be first! 🎯]'}`,
                mentions: lobbyMentions
            })
        }
        persistGames()
    }, 1000)
}

/**
 * Transitions from lobby phase to the actual game round.
 */
async function startActualGame(chatId, ctx) {
    const { sock, games, settings, words, activeGameChatRef, persistGames, jidOf } = ctx
    const gameState = getGameState(chatId, games, settings)
    gameState.lobbyActive = false
    if (gameState.lobbyTimer) clearInterval(gameState.lobbyTimer)

    if (gameState.players.length === 0) {
        gameState.active = false
        activeGameChatRef.value = null
        persistGames()
        return await sock.sendMessage(chatId, {
            text: `🚫 *Game Cancelled*\nNo one joined the lobby in time. Type *WRG* (all caps) to start a fresh lobby! 🎮`
        })
    }

    const pool = words[gameState.difficulty] || words.easy
    gameState.targetWord = pool[Math.floor(Math.random() * pool.length)]
    gameState.hiddenWord = gameState.targetWord.split('').map(() => '_')

    // Initialise a fresh per-player attempts counter for every player in the round
    gameState.attempts = {}
    gameState.players.forEach(p => { gameState.attempts[p] = 0 })

    gameState.skipStreaks = {}
    gameState.disqualified = []
    gameState.currentTurnIndex = 0
    gameState.active = true
    gameState.paused = false

    const lobbyMentions = gameState.players.map(num => jidOf(num))
    const lobbyText = gameState.players
        .map((num, i) => `${i + 1}. @${num} (${gameState.playerNames[num] || num})`)
        .join('\n')

    await sock.sendMessage(chatId, {
        text:
            `🎬 *Lobby Closed — Game On!*\n\n` +
            `👥 *Final Player Lineup:*\n${lobbyText}\n\n` +
            `🏆 May the best guesser win!`,
        mentions: lobbyMentions
    })

    persistGames()
    await sendGameBoard(chatId, '', [], ctx)
}

/**
 * Sends the game board UI with current word state, player turns, and starts the turn timer.
 * Shows the CURRENT player's personal remaining attempts, not a shared pool.
 */
async function sendGameBoard(chatId, actionFeedback = '', extraMentions = [], ctx) {
    const { sock, games, settings, persistGames, jidOf } = ctx
    const gameState = getGameState(chatId, games, settings)
    if (!gameState.active) return

    const currentPlayerNumber = gameState.players[gameState.currentTurnIndex]
    const currentPlayerJid = jidOf(currentPlayerNumber)
    const currentPlayerName = gameState.playerNames[currentPlayerNumber] || currentPlayerNumber

    // Per-player remaining attempts for the current player only
    const playerAttempts = gameState.attempts[currentPlayerNumber] ?? 0
    const attemptsLeft = settings.maxTries - playerAttempts

    const hasMultiplePlayers = gameState.players.length > 1
    let nextPlayerNumber = null, nextPlayerJid = null, nextPlayerName = null
    if (hasMultiplePlayers) {
        const nextPlayerIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
        nextPlayerNumber = gameState.players[nextPlayerIndex]
        nextPlayerJid = jidOf(nextPlayerNumber)
        nextPlayerName = gameState.playerNames[nextPlayerNumber] || nextPlayerNumber
    }

    let boardText = ''
    if (actionFeedback) boardText += `${actionFeedback}\n\n`

    boardText += `🎮 *Word Riddle Game (WRG)*\n\n`
    boardText += `📝 Word: \`${gameState.hiddenWord.join(' ')}\` *(${gameState.targetWord.length} letters)*\n`
    boardText += `💥 *@${currentPlayerNumber}'s attempts left: ${attemptsLeft}/${settings.maxTries}*\n\n`
    boardText += `🎯 *Your turn:* @${currentPlayerNumber} (${currentPlayerName})\n`
    if (hasMultiplePlayers) {
        boardText += `⏭️ *Up next:* @${nextPlayerNumber} (${nextPlayerName})\n\n`
    } else {
        boardText += `🕹️ Playing solo — no pressure... just all of it 😄\n\n`
    }
    boardText += `_⏱️ You have 30 seconds — guess a letter or the full word!_`

    const mentionJids = [...new Set([currentPlayerJid, ...(nextPlayerJid ? [nextPlayerJid] : []), ...extraMentions])]
    await sock.sendMessage(chatId, { text: boardText, mentions: mentionJids })

    persistGames()
    startTurnCountdown(chatId, ctx)
}

/**
 * Starts the 30-second per-turn countdown.
 * Timeouts only count toward skip streaks — they do NOT consume the player's attempt budget.
 * Attempt budget is only reduced by wrong letter/word guesses (handled in index.js).
 */
function startTurnCountdown(chatId, ctx) {
    const { sock, games, settings, activeGameChatRef, persistGames, jidOf, tag } = ctx
    const gameState = getGameState(chatId, games, settings)
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

            // Timeout = skip only. Does NOT reduce the player's attempt budget.
            gameState.skipStreaks[currentPlayerNumber] = (gameState.skipStreaks[currentPlayerNumber] || 0) + 1
            const skipCount = gameState.skipStreaks[currentPlayerNumber]
            const removedIndex = gameState.currentTurnIndex

            if (skipCount >= 3) {
                // 3 consecutive no-responses → disqualify this player
                matchSummary.recordDisqualification(gameState, currentPlayerNumber, matchSummary.DQ_REASONS.SKIPPED_3)

                // Clean up this player's entries from all tracking objects
                gameState.players.splice(removedIndex, 1)
                delete gameState.playerNames[currentPlayerNumber]
                delete gameState.skipStreaks[currentPlayerNumber]
                delete gameState.attempts[currentPlayerNumber]

                const dqText =
                    `🚫 *Disqualified!*\n` +
                    `${tag(currentPlayerNumber)} skipped *3 turns in a row* without a single guess. They've been removed from the round. 👋`

                // Check if someone has won by being last standing
                const lastStanding = matchSummary.checkLastPlayerStanding(gameState)
                if (lastStanding) {
                    gameState.active = false
                    activeGameChatRef.value = null
                    await sock.sendMessage(chatId, {
                        text: `${dqText}\n\n🏆 *LAST PLAYER STANDING!* The word was *${gameState.targetWord.toUpperCase()}*. 🎉`
                    })
                    await matchSummary.sendMatchReport(sock, chatId, gameState, { type: 'last_standing', winnerNumber: lastStanding }, tag)
                    gameState.players = []
                    persistGames()
                    return
                }

                // No players left at all → game over, no winner
                if (gameState.players.length === 0) {
                    gameState.active = false
                    activeGameChatRef.value = null
                    await sock.sendMessage(chatId, {
                        text: `${dqText}\n\n💀 *GAME OVER!* No players remain. The word was *${gameState.targetWord.toUpperCase()}*.`
                    })
                    await matchSummary.sendMatchReport(sock, chatId, gameState, { type: 'no_winner' }, tag)
                    persistGames()
                    return
                }

                // Other players remain — continue the round
                gameState.currentTurnIndex = removedIndex % gameState.players.length
                await sendGameBoard(chatId, dqText, [currentPlayerJid], ctx)
                return
            }

            // Normal timeout (under 3 skips) — rotate to next player, no attempt penalty
            const nextTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length
            gameState.currentTurnIndex = nextTurnIndex

            const feedback =
                `⏰ *Timeout!*\n` +
                `${tag(currentPlayerNumber)} took too long to respond. ` +
                `(${skipCount}/3 strikes before lockout 🟥)`

            await sendGameBoard(chatId, feedback, [], ctx)

        } else if (gameState.turnSecondsLeft === 20) {
            await sock.sendMessage(chatId, {
                text: `⏱️ *Heads up!* ${tag(currentPlayerNumber)}, you have *20 seconds* left — guess a letter or the full word! 🤔`,
                mentions: [currentPlayerJid]
            })
        } else if (gameState.turnSecondsLeft === 10) {
            await sock.sendMessage(chatId, {
                text: `🚨 *Last 10 seconds!* ${tag(currentPlayerNumber)}, GO GO GO! ⚡`,
                mentions: [currentPlayerJid]
            })
        }
    }, 1000)
}

module.exports = {
    DEFAULT_WORDS,
    getGameState,
    startLobbyCountdown,
    startActualGame,
    sendGameBoard,
    startTurnCountdown
}
