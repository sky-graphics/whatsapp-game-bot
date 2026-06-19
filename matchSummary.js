// matchSummary.js
//
// Standalone match-summary / disqualification module for the WRG WhatsApp bot.
// Pulled out of index.js so the main file stays focused on connection handling
// and turn logic. Everything here is pure bookkeeping + message formatting —
// it never touches the socket directly except to send the final report, and it
// never owns game state itself; it just reads/writes the gameState object it's
// given.
//
// Usage from index.js:
//   const matchSummary = require('./matchSummary')
//
//   // when a player is removed for any reason:
//   matchSummary.recordDisqualification(gameState, number, reason)
//
//   // every time a player is removed, check this BEFORE deciding the round is over:
//   if (matchSummary.checkLastPlayerStanding(gameState)) { ... }
//
//   // when the round ends (win, loss, or abandonment):
//   await matchSummary.sendMatchReport(sock, chatId, gameState, outcome, tag)

// Reasons a player can leave a round. Centralized so spelling/text stays
// consistent everywhere a disqualification or removal happens.
const DQ_REASONS = {
    SKIPPED_3: 'Skipped 3 turns in a row',
    ADMIN_REMOVED: 'Removed by admin',
    LEFT_GROUP: 'Left the group',
    MANUAL_LEAVE: 'Left the game voluntarily'
}

// Call this instead of gameState.players.splice(...) directly. It records the
// player into gameState.disqualified (creating the array on first use) BEFORE
// removing them from the active players list, so history survives the round.
//
// number: phone number string of the player being removed
// reason: one of DQ_REASONS, or any short string
// Returns the index the player was removed from (or -1 if they weren't found).
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

    return index
}

// Call this right after any disqualification/removal, before falling through
// to "no players left" handling. If exactly one player remains AND at least
// one disqualification has happened this round (so it's a real elimination
// scenario, not just a 1-player lobby that hasn't started), that player wins
// automatically.
//
// Returns the winning player's number if this condition is met, otherwise null.
// Does NOT send any message or mutate gameState beyond what the caller already
// did — index.js is expected to call sendMatchReport() right after this fires.
function checkLastPlayerStanding(gameState) {
    if (gameState.players.length !== 1) return null
    if (!gameState.disqualified || gameState.disqualified.length === 0) return null
    return gameState.players[0]
}

// Builds and sends the full "WRG MATCH COMPLETE" report.
//
// sock: the active Baileys socket
// chatId: the chat to send the report to
// gameState: the per-chat game state object (players, playerNames, disqualified, targetWord, etc.)
// outcome: one of:
//   { type: 'winner_letter', winnerNumber }       — won by completing the word letter-by-letter
//   { type: 'winner_instant', winnerNumber }       — won by guessing the full word outright
//   { type: 'last_standing', winnerNumber }        — won because everyone else was disqualified
//   { type: 'no_winner' }                          — ran out of shared attempts, or all players removed, nobody won
// tag: the tag(number) helper from index.js, used so winner/loser names mention-format consistently
//
// Returns nothing; sends the message directly.
async function sendMatchReport(sock, chatId, gameState, outcome, tag) {
    const disqualified = gameState.disqualified || []

    // "Participants" = everyone who was ever in the round: current survivors + everyone DQ'd.
    // We rebuild this from disqualified + whoever is still in players (winner included).
    const survivorEntries = gameState.players.map(number => ({
        number,
        name: gameState.playerNames[number] || number,
        disqualified: false
    }))
    const dqEntries = disqualified.map(entry => ({
        number: entry.number,
        name: entry.name,
        disqualified: true,
        reason: entry.reason
    }))

    const allParticipants = [...survivorEntries, ...dqEntries]
    const totalJoined = allParticipants.length
    const totalDisqualified = dqEntries.length

    let headerLine = ''
    let winnerLine = ''
    let winnerNumber = null

    switch (outcome.type) {
        case 'winner_letter':
            winnerNumber = outcome.winnerNumber
            headerLine = '🏆 *WRG MATCH COMPLETE*'
            winnerLine = `🎉 *Winner*\n✅ ${tag(winnerNumber)}`
            break
        case 'winner_instant':
            winnerNumber = outcome.winnerNumber
            headerLine = '🏆 *WRG MATCH COMPLETE*'
            winnerLine = `🎉 *Winner (Instant Word Guess)*\n✅ ${tag(winnerNumber)}`
            break
        case 'last_standing':
            winnerNumber = outcome.winnerNumber
            headerLine = '🏆 *WRG MATCH COMPLETE*'
            winnerLine = `🎉 *Winner (Last Player Standing)*\n✅ ${tag(winnerNumber)}\n_All other players were disqualified._`
            break
        case 'no_winner':
        default:
            headerLine = '🛑 *WRG MATCH COMPLETE*'
            winnerLine = `😶 *No Winner*\nThe round ended with no surviving player.`
            break
    }

    // Participant list: winner first (if any), then everyone else, marked ✅/❌
    const participantLines = []
    if (winnerNumber) {
        participantLines.push(`✅ ${tag(winnerNumber)} (Winner)`)
    }
    for (const entry of allParticipants) {
        if (entry.number === winnerNumber) continue
        const mark = entry.disqualified ? '❌' : '✅'
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

    const mentionSet = new Set(allParticipants.map(e => `${e.number}@s.whatsapp.net`))
    if (winnerNumber) mentionSet.add(`${winnerNumber}@s.whatsapp.net`)

    await sock.sendMessage(chatId, {
        text: report,
        mentions: [...mentionSet]
    })
}

module.exports = {
    DQ_REASONS,
    recordDisqualification,
    checkLastPlayerStanding,
    sendMatchReport
}
