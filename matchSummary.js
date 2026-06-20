// matchSummary.js — WRG Bot · Sky Graphics
//
// Standalone match-summary / disqualification module.
// Pure bookkeeping + message formatting — never owns game state.

const DQ_REASONS = {
    SKIPPED_3:      'Skipped 3 turns in a row',
    ADMIN_REMOVED:  'Removed by admin',
    LEFT_GROUP:     'Left the group',
    MANUAL_LEAVE:   'Left the game voluntarily',
    ATTEMPTS_EXHAUSTED: 'Used all wrong guesses'
}

/**
 * Record a player disqualification into gameState.disqualified
 * and remove them from gameState.players.
 * FIX BUG-21: also cleans up playerJids and attempts so no orphaned keys remain.
 */
function recordDisqualification(gameState, number, reason = DQ_REASONS.SKIPPED_3) {
    if (!gameState.disqualified) gameState.disqualified = []

    const index = gameState.players.indexOf(number)
    if (index === -1) return -1

    gameState.disqualified.push({
        number,
        name: gameState.playerNames[number] || number,
        reason,
        eliminatedAt: new Date().toISOString()
    })

    gameState.players.splice(index, 1)
    delete gameState.playerNames[number]
    delete gameState.skipStreaks[number]
    // FIX BUG-21: consistently clean up playerJids and attempts here
    delete gameState.playerJids?.[number]
    delete gameState.attempts?.[number]

    return index
}

/**
 * Returns the winning player's number if exactly one player remains
 * after a disqualification. Otherwise null.
 */
function checkLastPlayerStanding(gameState) {
    if (gameState.players.length !== 1) return null
    if (!gameState.disqualified || gameState.disqualified.length === 0) return null
    return gameState.players[0]
}

/**
 * Builds and sends the full match report.
 *
 * @param {object} sock
 * @param {string} chatId
 * @param {object} gameState
 * @param {object} outcome  — { type, winnerNumber? }
 * @param {function} tag    — tag(number) → display string with role badge
 */
async function sendMatchReport(sock, chatId, gameState, outcome, tag) {
    const disqualified = gameState.disqualified || []

    const survivorEntries = gameState.players.map(number => ({
        number,
        name: gameState.playerNames[number] || number,
        disqualified: false
    }))
    const dqEntries = disqualified.map(entry => ({
        number:       entry.number,
        name:         entry.name,
        disqualified: true,
        reason:       entry.reason
    }))

    const allParticipants    = [...survivorEntries, ...dqEntries]
    const totalJoined        = allParticipants.length
    const totalDisqualified  = dqEntries.length

    let headerLine   = ''
    let winnerLine   = ''
    let winnerNumber = null

    switch (outcome.type) {
        case 'winner_letter':
            winnerNumber = outcome.winnerNumber
            headerLine   = '🏆 *WRG MATCH COMPLETE*'
            winnerLine   = `🎉 *Winner*\n✅ ${tag(winnerNumber)}`
            break
        case 'winner_instant':
            winnerNumber = outcome.winnerNumber
            headerLine   = '🏆 *WRG MATCH COMPLETE*'
            winnerLine   = `🎉 *Winner (Instant Word Guess)*\n✅ ${tag(winnerNumber)}`
            break
        case 'last_standing':
            winnerNumber = outcome.winnerNumber
            headerLine   = '🏆 *WRG MATCH COMPLETE*'
            winnerLine   = `🎉 *Winner (Last Player Standing)*\n✅ ${tag(winnerNumber)}\n_All other players were disqualified._`
            break
        case 'no_winner':
        default:
            headerLine = '🛑 *WRG MATCH COMPLETE*'
            winnerLine = `😶 *No Winner*\nThe round ended with no surviving player.`
            break
    }

    const participantLines = []
    if (winnerNumber) {
        participantLines.push(`✅ ${tag(winnerNumber)} (Winner)`)
    }
    for (const entry of allParticipants) {
        if (entry.number === winnerNumber) continue
        const mark   = entry.disqualified ? '❌' : '✅'
        const suffix = entry.disqualified ? ` (DQ: ${entry.reason})` : ''
        participantLines.push(`${mark} ${tag(entry.number)}${suffix}`)
    }

    const wordLine = gameState.targetWord ? gameState.targetWord.toUpperCase() : 'N/A'

    const report =
        `${headerLine}\n\n` +
        `${winnerLine}\n\n` +
        `👥 *Participants*\n${participantLines.join('\n') || '[None]'}\n\n` +
        `🔤 *Word*\n${wordLine}\n\n` +
        `📊 *Match Statistics*\n` +
        `Players Joined: ${totalJoined}\n` +
        `Disqualified: ${totalDisqualified}\n` +
        `Winner: ${winnerNumber ? 1 : 0}`

    // Use stored playerJids where available for accurate mention JIDs
    const mentionSet = new Set()
    for (const p of allParticipants) {
        const jid = (gameState.playerJids && gameState.playerJids[p.number])
            || `${p.number}@s.whatsapp.net`
        mentionSet.add(jid)
    }
    if (winnerNumber) {
        const winnerJid = (gameState.playerJids && gameState.playerJids[winnerNumber])
            || `${winnerNumber}@s.whatsapp.net`
        mentionSet.add(winnerJid)
    }

    await sock.sendMessage(chatId, {
        text:     report,
        mentions: [...mentionSet]
    })
}

module.exports = {
    DQ_REASONS,
    recordDisqualification,
    checkLastPlayerStanding,
    sendMatchReport
}
