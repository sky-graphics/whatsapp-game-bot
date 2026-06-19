// ============================================================
//  permissions.js — WRG Bot · Sky Graphics
//  Single source of truth for all role/tier logic.
//  Import this in index.js and adminCommands.js.
//  Never import gameEngine.js or matchSummary here — no circular deps.
// ============================================================

// ─── Tier constants ───────────────────────────────────────────
const TIERS = {
    CREATOR: 'CREATOR',
    ADMIN:   'ADMIN',
    PUBLIC:  'PUBLIC'
}

// ─── Difficulty display helpers ───────────────────────────────
const DIFFICULTY_EMOJI = {
    easy:      '🟢',
    normal:    '🟡',
    difficult: '🔴'
}

const DIFFICULTY_LABEL = {
    easy:      'Easy',
    normal:    'Normal',
    difficult: 'Difficult'
}

function difficultyBadge(difficulty) {
    const d = (difficulty || 'easy').toLowerCase()
    return `${DIFFICULTY_EMOJI[d] || '⚪'} *${DIFFICULTY_LABEL[d] || d.toUpperCase()}*`
}

// ─── Tier resolution ──────────────────────────────────────────
/**
 * Resolve the tier of a sender by their plain phone number.
 * Always pass the resolved PN (from msg.key.senderPn), never a JID.
 *
 * @param {string} senderNumber  — plain digits, e.g. "237682477421"
 * @param {object} settings      — { adminNumber }
 * @returns {'CREATOR'|'ADMIN'|'PUBLIC'}
 */
function getTier(senderNumber, settings) {
    const clean = (senderNumber || '').replace(/[^0-9]/g, '')

    // Creator check — compare plain numbers only, never JIDs
    const creatorJid = process.env.CREATOR_JID || ''
    const creatorNum = creatorJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
    if (creatorNum && clean === creatorNum) return TIERS.CREATOR

    // Admin check
    const adminNum = (settings.adminNumber || '').replace(/[^0-9]/g, '')
    if (adminNum && clean === adminNum) return TIERS.ADMIN

    return TIERS.PUBLIC
}

/**
 * Convenience booleans — use these everywhere instead of inline string compares.
 */
function isCreator(senderNumber, settings) {
    return getTier(senderNumber, settings) === TIERS.CREATOR
}

function isAdmin(senderNumber, settings) {
    const tier = getTier(senderNumber, settings)
    return tier === TIERS.CREATOR || tier === TIERS.ADMIN
}

function isPublic(senderNumber, settings) {
    return getTier(senderNumber, settings) === TIERS.PUBLIC
}

// ─── Command permission map ───────────────────────────────────
// Each command maps to the MINIMUM tier required to run it.
// CREATOR can always run ADMIN commands too (hierarchy).
const COMMAND_TIERS = {
    // Creator-only
    approve: TIERS.CREATOR,
    deny:    TIERS.CREATOR,
    reset:   TIERS.CREATOR,

    // Admin + Creator
    help:         TIERS.ADMIN,
    pause:        TIERS.ADMIN,
    resume:       TIERS.ADMIN,
    end:          TIERS.ADMIN,
    stop:         TIERS.ADMIN,
    confirm:      TIERS.ADMIN,
    cancel:       TIERS.ADMIN,
    addword:      TIERS.ADMIN,
    removeword:   TIERS.ADMIN,
    listwords:    TIERS.ADMIN,
    setwords:     TIERS.ADMIN,
    clearwords:   TIERS.ADMIN,
    setallwords:  TIERS.ADMIN,
    set:          TIERS.ADMIN,  // /set difficulty, /set public, /set start, /set maxtries, /set admin

    // Public — anyone (onboarding gate)
    admin: TIERS.PUBLIC
}

/**
 * Returns true if the given tier is allowed to run the command.
 * Creator can always run admin commands.
 *
 * @param {string} tier    — one of TIERS.*
 * @param {string} command — e.g. "help", "approve", "set"
 */
function canRunCommand(tier, command) {
    const required = COMMAND_TIERS[command]
    if (!required) return false  // unknown command — deny by default

    if (required === TIERS.PUBLIC)   return true
    if (required === TIERS.ADMIN)    return tier === TIERS.ADMIN || tier === TIERS.CREATOR
    if (required === TIERS.CREATOR)  return tier === TIERS.CREATOR
    return false
}

// ─── Settings resolution (conflict-safe) ─────────────────────
/**
 * Resolve the effective value for a setting key.
 * Creator overrides always win. Admin settings are the tenant layer.
 * Falls back to hardcoded defaults.
 *
 * @param {string} key           — e.g. "difficulty", "publicVisible"
 * @param {object} settings      — the main settings object (has adminSettings + creatorOverrides)
 * @param {any}    defaultValue  — fallback if neither layer has a value
 */
function resolveSetting(key, settings, defaultValue) {
    // Creator overrides always win
    if (
        settings.creatorOverrides &&
        settings.creatorOverrides[key] !== undefined
    ) {
        return settings.creatorOverrides[key]
    }
    // Admin tenant setting
    if (settings[key] !== undefined) return settings[key]
    // Hardcoded default
    return defaultValue
}

/**
 * Write a setting. Creator writes to creatorOverrides (global).
 * Admin writes to root settings (tenant-scoped).
 * This means creator can override admin but not vice versa.
 *
 * @param {string} tier      — TIERS.CREATOR or TIERS.ADMIN
 * @param {string} key
 * @param {any}    value
 * @param {object} settings  — mutated in place; call saveSettings() after
 */
function writeSetting(tier, key, value, settings) {
    if (tier === TIERS.CREATOR) {
        if (!settings.creatorOverrides) settings.creatorOverrides = {}
        settings.creatorOverrides[key] = value
    } else {
        settings[key] = value
    }
}

// ─── Reply target resolution ──────────────────────────────────
/**
 * Returns the JID that all command replies should go to for this sender.
 * Commands ALWAYS reply to the sender's own DM, never to the group.
 *
 * @param {string} tier         — TIERS.*
 * @param {string} senderJid    — the sender's resolved JID (from index.js)
 * @param {object} settings     — { adminJid }
 * @returns {string}            — JID to send reply to
 */
function getReplyTarget(tier, senderJid, settings) {
    // Always reply to whoever sent the command — no relaying through creator
    return senderJid
}

// ─── Name-only tag helper ─────────────────────────────────────
/**
 * Returns a display tag using the person's name + role badge if applicable.
 * Never shows a number or JID.
 *
 * Output examples:
 *   "Might Awa (Creator)"
 *   "John (Admin)"
 *   "Sarah"
 *
 * @param {string} number     — player's phone number (plain digits)
 * @param {object} nameCache  — { [number]: name }
 * @param {object} settings   — { adminNumber } — optional, pass when available
 */
function nameTag(number, nameCache, settings) {
    const name = nameCache[number] || 'Player'

    const creatorJid = process.env.CREATOR_JID || ''
    const creatorNum = creatorJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
    const clean      = (number || '').replace(/[^0-9]/g, '')

    if (creatorNum && clean === creatorNum) return `${name} (Creator)`

    const adminNum = ((settings && settings.adminNumber) || '').replace(/[^0-9]/g, '')
    if (adminNum && clean === adminNum) return `${name} (Admin)`

    return name
}

module.exports = {
    TIERS,
    DIFFICULTY_EMOJI,
    DIFFICULTY_LABEL,
    difficultyBadge,
    getTier,
    isCreator,
    isAdmin,
    isPublic,
    canRunCommand,
    COMMAND_TIERS,
    resolveSetting,
    writeSetting,
    getReplyTarget,
    nameTag
}