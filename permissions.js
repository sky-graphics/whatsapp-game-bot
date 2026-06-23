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
 * Resolve the tier of a sender.
 *
 * @param {string} senderNumber  — plain digits, e.g. "237682477421"
 * @param {object} settings      — { adminNumber }
 * @param {string} [senderJid]  — optional full JID; used as LID fallback
 *                                 so creator is recognised even when
 *                                 WhatsApp routes via @lid instead of @s.whatsapp.net
 * @returns {'CREATOR'|'ADMIN'|'PUBLIC'}
 *
 * FIX BUG-22: added senderJid as optional third arg with LID fallback
 */
/**
 * Strip the device suffix from a JID so two JIDs for the same
 * account (e.g. 237xxx@s.whatsapp.net vs 237xxx:15@lid) can be
 * compared without false negatives.
 *   '77705185873989:15@lid'  → '77705185873989@lid'
 *   '237682477421@s.whatsapp.net' → '237682477421@s.whatsapp.net'
 */
function stripDevice(jid) {
    if (!jid) return ''
    const [localpart, domain] = jid.split('@')
    if (!domain) return jid
    const base = localpart.split(':')[0]
    return `${base}@${domain}`
}

function getTier(senderNumber, settings, senderJid) {
    const clean      = (senderNumber || '').replace(/[^0-9]/g, '')
    const creatorJid = process.env.CREATOR_JID || ''
    const creatorNum = creatorJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')

    // ── CREATOR checks ──────────────────────────────────────────
    // 1. Plain PN digits match (works when WhatsApp routes via @s.whatsapp.net)
    if (creatorNum && clean && clean === creatorNum) return TIERS.CREATOR

    // 2. Full JID match — the ONLY reliable check when WhatsApp routes via @lid.
    //    We compare base JIDs (device suffix stripped) because the same account
    //    can appear as 'xxx:15@lid' on one message and 'xxx@lid' on another.
    //    NOTE: LID digits ≠ PN digits — they are completely different number spaces.
    //    Comparing LID digit strings against PN digit strings always fails. We must
    //    compare the full JID (same domain, same local part) against the stored JID.
    if (senderJid && creatorJid) {
        if (stripDevice(senderJid) === stripDevice(creatorJid)) return TIERS.CREATOR
    }

    // ── ADMIN checks ─────────────────────────────────────────────
    const adminNum = (settings.adminNumber || '').replace(/[^0-9]/g, '')

    // 1. Plain PN digits match
    if (adminNum && clean && clean === adminNum) return TIERS.ADMIN

    // 2. Full JID match against stored adminJid (may be @lid on modern Baileys)
    const adminJid = settings.adminJid || ''
    if (senderJid && adminJid) {
        if (stripDevice(senderJid) === stripDevice(adminJid)) return TIERS.ADMIN
    }

    return TIERS.PUBLIC
}

/**
 * Convenience booleans — use these everywhere instead of inline string compares.
 */
function isCreator(senderNumber, settings, senderJid) {
    return getTier(senderNumber, settings, senderJid) === TIERS.CREATOR
}

function isAdmin(senderNumber, settings, senderJid) {
    const tier = getTier(senderNumber, settings, senderJid)
    return tier === TIERS.CREATOR || tier === TIERS.ADMIN
}

function isPublic(senderNumber, settings, senderJid) {
    return getTier(senderNumber, settings, senderJid) === TIERS.PUBLIC
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
    set:          TIERS.ADMIN,
    // FIX BUG-18: clearadmin and status were missing from COMMAND_TIERS
    clearadmin:   TIERS.ADMIN,
    status:       TIERS.ADMIN,

    // Public — anyone (onboarding gate)
    admin: TIERS.PUBLIC
}

/**
 * Returns true if the given tier is allowed to run the command.
 * Creator can always run admin commands.
 */
function canRunCommand(tier, command) {
    const required = COMMAND_TIERS[command]
    if (!required) return false

    if (required === TIERS.PUBLIC)   return true
    if (required === TIERS.ADMIN)    return tier === TIERS.ADMIN || tier === TIERS.CREATOR
    if (required === TIERS.CREATOR)  return tier === TIERS.CREATOR
    return false
}

// ─── Settings resolution (conflict-safe) ─────────────────────
/**
 * Resolve the effective value for a setting key.
 * Creator overrides always win. Admin settings are the tenant layer.
 */
function resolveSetting(key, settings, defaultValue) {
    if (
        settings.creatorOverrides &&
        settings.creatorOverrides[key] !== undefined
    ) {
        return settings.creatorOverrides[key]
    }
    if (settings[key] !== undefined) return settings[key]
    return defaultValue
}

/**
 * Write a setting. Creator writes to creatorOverrides (global).
 * Admin writes to root settings (tenant-scoped).
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
 * Commands ALWAYS reply to the sender's own DM.
 */
function getReplyTarget(tier, senderJid, settings) {
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
 */
function nameTag(number, nameCache, settings) {
    const name = (nameCache && nameCache[number]) || 'Player'

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
    stripDevice,
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
