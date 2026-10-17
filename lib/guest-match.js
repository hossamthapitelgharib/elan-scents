// Strict matching of anonymous browsers that probably belong to one device/person.
//
// The result is used ONLY to count people more accurately (guest_identity_links). It never moves a
// basket, a visit or an event from one guest to another: those are merged only by an exact browser
// key (server cookie / UUID) or by a login. That is what keeps different people's baskets apart.

const WEIGHTS = { gpu: 3, screen: 2, canvas: 2, audio: 2, fonts: 2, tz: 1, hw: 1, platform: 1, lang: 1 };
const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

const LIMITS = {
  minComparableWeight: 10,   // of 15: too little evidence is never enough
  minSimilarity: 0.92,       // weighted share of equal parts among the comparable ones
  maxPopularity: 3,          // a fingerprint seen on more than 3 different guests is a common device
  recentMs: 24 * 3600 * 1000,
  minInteractions: 1,
  minActiveSeconds: 5
};

const HEX = /^[a-f0-9]{8,64}$/;

// Keeps only known parts with a plausible value; anything else is ignored.
function cleanParts(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(WEIGHTS)) {
    const v = input[key];
    if (typeof v === 'string' && HEX.test(v)) out[key] = v;
  }
  return out;
}

function similarity(a, b) {
  let same = 0, comparable = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    if (a[key] && b[key]) {
      comparable += weight;
      if (a[key] === b[key]) same += weight;
    }
  }
  return { comparable, score: comparable ? same / comparable : 0 };
}

function trustedBehavior(b) {
  return !!b && Number(b.interactions) >= LIMITS.minInteractions && Number(b.activeSeconds) >= LIMITS.minActiveSeconds;
}

/**
 * own / candidate: { parts, fp, ipHash, ipPrefixHash, cartHash, lastSeenAt, behavior?, convertedUserIds? }
 * popularity: number of different guests that already carry the candidate's overall fingerprint.
 * Returns { link, score, reasons }.
 */
function decide(own, candidate, popularity, now = Date.now()) {
  const reasons = [];
  const no = (why) => ({ link: false, score: 0, reasons: [why] });

  if (!trustedBehavior(own.behavior)) return no('own_behaviour_not_trusted');

  const ownUsers = own.convertedUserIds || [], otherUsers = candidate.convertedUserIds || [];
  // A guest that already belongs to a registered person is only ever linked to that same person.
  if ((ownUsers.length || otherUsers.length) && !ownUsers.some((u) => otherUsers.includes(u))) return no('registered_people_are_never_mixed');

  const a = cleanParts(own.parts), b = cleanParts(candidate.parts);
  const { comparable, score } = similarity(a, b);
  if (comparable < LIMITS.minComparableWeight) return no('too_little_evidence');
  if (score < LIMITS.minSimilarity) return no('parts_differ');
  reasons.push(`parts:${score.toFixed(2)}`);

  // Corroboration. The basket is only a helper and can never be enough by itself.
  let support = 0;
  if (own.ipHash && own.ipHash === candidate.ipHash) { support += 2; reasons.push('same_ip'); }
  else if (own.ipPrefixHash && own.ipPrefixHash === candidate.ipPrefixHash) { support += 1; reasons.push('same_ip_prefix'); }
  const recent = candidate.lastSeenAt && now - new Date(candidate.lastSeenAt).getTime() < LIMITS.recentMs;
  if (recent) { support += 1; reasons.push('recent'); }
  if (own.cartHash && own.cartHash === candidate.cartHash) { support += 1; reasons.push('same_basket_helper'); }
  if (own.fp && own.fp === candidate.fp) { support += 1; reasons.push('same_full_fingerprint'); }

  const network = reasons.includes('same_ip') || reasons.includes('same_ip_prefix');
  if (popularity > LIMITS.maxPopularity) return no('common_device_fingerprint');
  const needed = popularity <= 1 ? 2 : 4;          // a shared fingerprint needs far more support
  if (!network) return no('no_network_support');   // device parts alone, or a basket, never link
  if (support < needed) return no('not_enough_support');

  return { link: true, score: Number((score + support / 10).toFixed(3)), reasons };
}

// Short stable hash of a basket, used only as a helper signal.
function cartSignature(items) {
  if (!Array.isArray(items)) return '';
  const rows = items.map((i) => `${i.sid}:${i.q || 1}`).filter((s) => s.length > 2).sort();
  return rows.join('|');
}

module.exports = { WEIGHTS, TOTAL_WEIGHT, LIMITS, cleanParts, similarity, decide, trustedBehavior, cartSignature };
