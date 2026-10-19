// PHASE E — TAG/LEVEL badges (blueprint E2).
//
// The 100 patch-method names double as TAG badges. Tiers are by LIFETIME
// credits earned (creditsEarned on the User doc), ascending through the
// list's 5 themes:
//   0–9      Desi Tadka   (Desi Power)
//   10–49    Ghost        (Stealth / Ghost)
//   50–199   Turbo        (Speed / Storm)
//   200–999  Diamond      (Premium / Royal)
//   1000+    Neural       (AI / Tech)
//
// Source of truth is computeSocialTag(creditsEarned) called on read; the
// `tag` field on User is a persisted convenience, recomputed on every
// credit grant (ledgerService / redeem / admin / referrals).
const TIERS = [
    { min: 1000, tag: 'Neural' },
    { min: 200, tag: 'Diamond' },
    { min: 50, tag: 'Turbo' },
    { min: 10, tag: 'Ghost' },
    { min: 0, tag: 'Desi Tadka' }
];

function computeSocialTag(creditsEarned) {
    const earned = Math.max(0, Number(creditsEarned) || 0);
    for (const tier of TIERS) {
        if (earned >= tier.min) return tier.tag;
    }
    return 'Desi Tadka';
}

// PHASE E — call on a Mongoose user doc after granting credits: grows
// lifetime-earned on positive deltas and recomputes the TAG badge.
// Synchronous doc mutation only (caller saves). Never throws.
function bumpEarnedAndRetag(userDoc, delta) {
    try {
        if (userDoc && Number(delta) > 0) {
            userDoc.creditsEarned = (Number(userDoc.creditsEarned) || 0) + Number(delta);
        }
        if (userDoc) userDoc.tag = computeSocialTag(userDoc.creditsEarned);
    } catch (_) { /* non-critical */ }
}

module.exports = { computeSocialTag, bumpEarnedAndRetag, SOCIAL_TAG_TIERS: TIERS };
