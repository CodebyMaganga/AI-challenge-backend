
// services/gapConstants.js
const GAPS = {
  NO_LOAN_HISTORY: 'NO_LOAN_HISTORY',
  DEFAULTED: 'DEFAULTED',
  NO_COOP: 'NO_COOP',
  INACTIVE_COOP: 'INACTIVE_COOP',
  NO_GROUP: 'NO_GROUP',
  LOW_MPESA: 'LOW_MPESA',
  SMALL_FARM: 'SMALL_FARM',
};

// Tier meta – used for loan amounts and point ranges
function tierMeta(tier) {
  const metas = {
    1: { limit: 'KES 30,000' },
    2: { limit: 'KES 15,000' },
    3: { limit: 'KES 5,000' },
    4: { limit: 'Bado / Not yet' },
  };
  return metas[tier] || metas[4];
}

module.exports = { GAPS, tierMeta };