'use strict';

// v91 — shared plan-vocabulary mapping (BugHunter DB P0-1/P0-2, backend F8/F9).
//
// The User.proPlan enum is ['none','trial','monthly','yearly','lifetime'],
// but vouchers, payment proofs and admin calls speak the marketing
// vocabulary 'PRO' / 'VIP' / 'LIFETIME'. Assigning the raw vocabulary to
// user.proPlan used to throw a Mongoose ValidationError on EVERY default
// redeem / payment approval (500, voucher burned / proof stuck pending).
// Map first, assign second — never assign raw input to the enum.

const PRO_PLAN_ENUM = ['none', 'trial', 'monthly', 'yearly', 'lifetime'];

// PRO -> 'monthly' (a paid monthly plan), VIP -> 'yearly', LIFETIME -> 'lifetime'.
// Already-valid enum values pass through unchanged (case-insensitive).
function mapPlanToEnum(plan) {
    const p = String(plan || '').trim().toLowerCase();
    if (PRO_PLAN_ENUM.includes(p)) return p;
    if (p === 'pro') return 'monthly';
    if (p === 'vip') return 'yearly';
    if (p === 'lifetime' || p === 'life' || p === 'permanent') return 'lifetime';
    if (p === 'free' || p === '') return 'trial';
    return 'monthly'; // unknown paid vocabulary defaults to the paid monthly plan
}

function isValidProPlan(plan) {
    return PRO_PLAN_ENUM.includes(String(plan || '').trim().toLowerCase());
}

module.exports = { mapPlanToEnum, isValidProPlan, PRO_PLAN_ENUM };
