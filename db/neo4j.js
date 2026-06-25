/**
 * neo4j.js — graph database connection and query helpers
 *
 * What lives in Neo4j (not MongoDB):
 *   Nodes:    Farmer, Cooperative, Lender, ClimateZone
 *   Edges:    MEMBER_OF, BORROWED_FROM, VOUCHED_BY, LOCATED_IN
 *
 * Why graph for these?
 *   A farmer with no personal loan history but who belongs to a
 *   cooperative where 94% of members repaid is NOT the same risk
 *   as a farmer who stands alone. That relationship signal is one
 *   Cypher query. In MongoDB it would require multiple lookups and
 *   manual aggregation.
 *
 *   Second-degree discovery: a farmer may have NO direct coop record
 *   but sell to an aggregator who buys from 40 reliable farmers. Neo4j
 *   traverses that path in one query. MongoDB cannot.
 *
 * Evidence profile structure:
 *   {
 *     found: boolean,           // did Neo4j find any relationships?
 *     coopRepayRate: number|null,
 *     coopSize: number|null,
 *     coopName: string|null,
 *     goodNeighbors: number,    // same-coop farmers with clean repayment
 *     guarantors: number,
 *     secondDegreeLinks: number, // farmers connected via shared aggregator/lender
 *     adjustment: number,        // net score adjustment (-40 to +120)
 *     signals: string[],         // human-readable list of what was found
 *   }
 *
 * getNetworkBonus() is kept for backward compatibility — it now wraps
 * getEvidenceProfile() and returns the same { bonus, reason } shape.
 *
 * Falls back gracefully to empty evidence if Neo4j is not configured.
 */

const neo4j = require('neo4j-driver');

let driver = null;

function getDriver() {
  if (!driver && process.env.NEO4J_URI) {
    driver = neo4j.driver(
      process.env.NEO4J_URI,
      neo4j.auth.basic(
        process.env.NEO4J_USER,
        process.env.NEO4J_PASSWORD
      )
    );
  }
  return driver;
}

/**
 * Run a Cypher query. Returns array of record objects.
 * Handles session lifecycle automatically.
 */
async function query(cypher, params = {}) {
  const d = getDriver();
  if (!d) return [];                    // Neo4j not configured — silent fallback

  const session = d.session({ database: process.env.NEO4J_DATABASE });
  try {
    const result = await session.run(cypher, params);
    return result.records.map(r => r.toObject());
  } catch (err) {
    console.error('Neo4j query error:', err.message);
    return [];
  } finally {
    await session.close();
  }
}

// ── Schema setup — run once on first deploy ───────────────────────────────────

async function initSchema() {
  const d = getDriver();
  if (!d) return;

  const constraints = [
    `CREATE CONSTRAINT farmer_phone IF NOT EXISTS
     FOR (f:Farmer) REQUIRE f.phoneHash IS UNIQUE`,
    `CREATE CONSTRAINT coop_name IF NOT EXISTS
     FOR (c:Cooperative) REQUIRE c.name IS UNIQUE`,
    `CREATE CONSTRAINT lender_name IF NOT EXISTS
     FOR (l:Lender) REQUIRE l.name IS UNIQUE`,
  ];

  for (const c of constraints) {
    await query(c);
  }
  console.log('✅ Neo4j schema ready');
}

// ── Farmer node write ─────────────────────────────────────────────────────────

/**
 * Upsert a Farmer node and attach relationships.
 * Called after scoring — phoneHash is used instead of raw phone number.
 *
 * @param {object} params
 *   phoneHash, tier, crop, land, coopName (optional), hadLoan, repaid, gender
 */
async function writeFarmerNode({ phoneHash, tier, crop, land, coopName, hadLoan, repaid, gender }) {
  // Upsert farmer node
  await query(
    `MERGE (f:Farmer {phoneHash: $phoneHash})
     SET f.tier      = $tier,
         f.crop      = $crop,
         f.land      = $land,
         f.gender    = $gender,
         f.updatedAt = datetime()`,
    { phoneHash, tier, crop, land, gender }
  );

  // Attach cooperative relationship
  if (coopName) {
    await query(
      `MERGE (c:Cooperative {name: $coopName})
       WITH c
       MATCH (f:Farmer {phoneHash: $phoneHash})
       MERGE (f)-[r:MEMBER_OF]->(c)
       SET r.since = coalesce(r.since, date())`,
      { coopName, phoneHash }
    );
  }

  // Attach loan repayment relationship
  if (hadLoan) {
    await query(
      `MERGE (l:Lender {name: 'self_reported'})
       WITH l
       MATCH (f:Farmer {phoneHash: $phoneHash})
       MERGE (f)-[r:BORROWED_FROM]->(l)
       SET r.repaid = $repaid, r.recordedAt = datetime()`,
      { phoneHash, repaid }
    );
  }
}

// ── Evidence profile ──────────────────────────────────────────────────────────

/**
 * Discover all relationship evidence for a farmer in the graph.
 *
 * This is the core Neo4j value: we look for evidence before assuming
 * a farmer has none. Three layers of discovery:
 *
 *   Layer 1 — Direct cooperative membership & repayment rate
 *   Layer 2 — Same-coop neighbors with clean repayment history
 *   Layer 3 — Second-degree links (shared aggregator / lender network)
 *             This is what MongoDB cannot easily do — we traverse two hops.
 *
 * Returns a structured evidence object. Never throws — falls back to
 * empty evidence so scoring always completes.
 */
async function getEvidenceProfile(phoneHash) {
  const evidence = {
    found:             false,
    coopRepayRate:     null,
    coopSize:          null,
    coopName:          null,
    goodNeighbors:     0,
    guarantors:        0,
    secondDegreeLinks: 0,
    adjustment:        0,
    signals:           [],
  };

  // ── Layer 1: Cooperative repayment rate ──────────────────────────────────
  const coopRows = await query(
    `MATCH (f:Farmer {phoneHash: $phoneHash})-[:MEMBER_OF]->(c:Cooperative)
     OPTIONAL MATCH (c)<-[:MEMBER_OF]-(member:Farmer)-[loan:BORROWED_FROM]->()
     WITH c,
          count(loan)                                          AS totalLoans,
          sum(CASE WHEN loan.repaid THEN 1 ELSE 0 END)        AS repaidLoans
     WHERE totalLoans > 0
     RETURN c.name AS coopName,
            round(toFloat(repaidLoans) / totalLoans * 100, 1) AS repayRate,
            totalLoans`,
    { phoneHash }
  );

  if (coopRows.length > 0) {
    const rate  = coopRows[0].repayRate;
    const total = neo4j.integer.isInteger(coopRows[0].totalLoans)
      ? neo4j.integer.toNumber(coopRows[0].totalLoans)
      : coopRows[0].totalLoans;

    evidence.found         = true;
    evidence.coopRepayRate = rate;
    evidence.coopSize      = total;
    evidence.coopName      = coopRows[0].coopName;

    if (rate >= 85 && total >= 5) {
      evidence.adjustment += 80;
      evidence.signals.push(
        `Member of ${evidence.coopName} — ${rate}% repayment rate across ${total} members`
      );
    } else if (rate < 60 && total >= 5) {
      evidence.adjustment -= 40;
      evidence.signals.push(
        `Cooperative repayment concern: ${rate}% rate at ${evidence.coopName}`
      );
    } else if (total >= 5) {
      // Moderate rate — still evidence, no score change
      evidence.signals.push(
        `Member of ${evidence.coopName} — ${rate}% repayment rate (${total} members)`
      );
    }
  }

  // ── Layer 2: Same-coop neighbors with clean repayment ────────────────────
  const neighborRows = await query(
    `MATCH (f:Farmer {phoneHash: $phoneHash})-[:MEMBER_OF]->(c:Cooperative)
     MATCH (neighbor:Farmer)-[:MEMBER_OF]->(c)
     WHERE neighbor.phoneHash <> $phoneHash
     MATCH (neighbor)-[loan:BORROWED_FROM]->()
     WHERE loan.repaid = true
     RETURN count(DISTINCT neighbor) AS goodNeighbors`,
    { phoneHash }
  );

  if (neighborRows.length > 0) {
    const neighbors = neo4j.integer.isInteger(neighborRows[0].goodNeighbors)
      ? neo4j.integer.toNumber(neighborRows[0].goodNeighbors)
      : (neighborRows[0].goodNeighbors || 0);

    evidence.goodNeighbors = neighbors;

    if (neighbors >= 2) {
      evidence.found = true;
      evidence.adjustment += 40;
      evidence.signals.push(
        `${neighbors} cooperative neighbors with verified clean repayment`
      );
    }
  }

  // ── Layer 3: Second-degree links via shared aggregator/lender ────────────
  // This is the key Neo4j differentiator: two-hop traversal.
  // Farmer → MEMBER_OF → Cooperative ← MEMBER_OF ← OtherFarmer → BORROWED_FROM → Lender
  // We find farmers who share a lender with this farmer's cooperative members,
  // and count how many of those second-degree connections have repaid.
  //
  // For thin-file farmers with NO direct coop record, this can still find
  // evidence through a shared aggregator or micro-lender network.
  const secondDegreeRows = await query(
    `MATCH (f:Farmer {phoneHash: $phoneHash})
     OPTIONAL MATCH (f)-[:MEMBER_OF]->(c:Cooperative)<-[:MEMBER_OF]-(neighbor:Farmer)
     WHERE neighbor.phoneHash <> $phoneHash
     WITH f, collect(DISTINCT neighbor) AS coopNeighbors
     UNWIND CASE WHEN size(coopNeighbors) > 0 THEN coopNeighbors ELSE [f] END AS pivot
     MATCH (pivot)-[:BORROWED_FROM]->(l:Lender)<-[:BORROWED_FROM]-(linked:Farmer)
     WHERE linked.phoneHash <> $phoneHash
       AND NOT linked IN coopNeighbors
     MATCH (linked)-[loan:BORROWED_FROM]->()
     WHERE loan.repaid = true
     RETURN count(DISTINCT linked) AS secondDegree`,
    { phoneHash }
  );

  if (secondDegreeRows.length > 0) {
    const sd = neo4j.integer.isInteger(secondDegreeRows[0].secondDegree)
      ? neo4j.integer.toNumber(secondDegreeRows[0].secondDegree)
      : (secondDegreeRows[0].secondDegree || 0);

    evidence.secondDegreeLinks = sd;

    if (sd >= 3) {
      evidence.found = true;
      // Second-degree gives a smaller boost — it's weaker signal
      evidence.adjustment += 15;
      evidence.signals.push(
        `${sd} second-degree connections with clean repayment history in shared network`
      );
    }
  }

  // ── Peer guarantor ────────────────────────────────────────────────────────
  const guarantorRows = await query(
    `MATCH (g:Farmer)-[:VOUCHED_BY]->(f:Farmer {phoneHash: $phoneHash})
     MATCH (g)-[loan:BORROWED_FROM]->()
     WHERE loan.repaid = true
     RETURN count(g) AS guarantors`,
    { phoneHash }
  );

  if (guarantorRows.length > 0) {
    const guarantors = neo4j.integer.isInteger(guarantorRows[0].guarantors)
      ? neo4j.integer.toNumber(guarantorRows[0].guarantors)
      : (guarantorRows[0].guarantors || 0);

    evidence.guarantors = guarantors;

    if (guarantors >= 1) {
      evidence.found = true;
      evidence.adjustment += 30;
      evidence.signals.push(
        `${guarantors} active peer guarantor(s) with verified repayment history`
      );
    }
  }

  // Clamp adjustment
  evidence.adjustment = Math.max(-40, Math.min(120, evidence.adjustment));

  return evidence;
}

// ── Network bonus (backward-compatible wrapper) ───────────────────────────────

/**
 * Kept for backward compatibility. Wraps getEvidenceProfile() and returns
 * the original { bonus, reason } shape so existing callers don't break.
 */
async function getNetworkBonus(phoneHash) {
  try {
    const evidence = await getEvidenceProfile(phoneHash);
    return {
      bonus:  evidence.adjustment,
      reason: evidence.signals.length > 0 ? evidence.signals[0] : null,
    };
  } catch (err) {
    console.warn('getNetworkBonus fallback:', err.message);
    return { bonus: 0, reason: null };
  }
}

// ── Seed demo cooperative data ────────────────────────────────────────────────

async function seedDemoCooperative() {
  const d = getDriver();
  if (!d) { console.log('Neo4j not configured — skip seed'); return; }

  // Create Siaya Dairy Coop with 10 members, 9 repaid
  await query(`MERGE (c:Cooperative {name: 'Siaya Dairy Coop'}) SET c.region = 'Siaya'`);

  for (let i = 1; i <= 10; i++) {
    const hash   = `demo_member_${i}`;
    const repaid = i <= 9; // 90% repayment rate
    await query(
      `MERGE (f:Farmer {phoneHash: $hash})
       SET f.crop = 'dairy', f.tier = ${repaid ? 1 : 3}
       MERGE (c:Cooperative {name: 'Siaya Dairy Coop'})
       MERGE (f)-[:MEMBER_OF]->(c)
       MERGE (l:Lender {name: 'demo_lender'})
       MERGE (f)-[r:BORROWED_FROM]->(l)
       SET r.repaid = $repaid`,
      { hash, repaid }
    );
  }

  // Seed a second lender network for second-degree discovery demo
  await query(`MERGE (l:Lender {name: 'kilimo_microfinance'}) SET l.region = 'Siaya'`);
  for (let i = 1; i <= 5; i++) {
    const hash = `kilimo_borrower_${i}`;
    await query(
      `MERGE (f:Farmer {phoneHash: $hash})
       SET f.crop = 'maize', f.tier = 1
       MERGE (l:Lender {name: 'kilimo_microfinance'})
       MERGE (f)-[r:BORROWED_FROM]->(l)
       SET r.repaid = true`,
      { hash }
    );
  }

  console.log('✅ Demo cooperative seeded: Siaya Dairy Coop (90% repayment, 10 members)');
  console.log('✅ Second-degree network seeded: Kilimo Microfinance (5 clean borrowers)');
}

module.exports = {
  query,
  initSchema,
  writeFarmerNode,
  getEvidenceProfile,
  getNetworkBonus,
  seedDemoCooperative,
  getDriver,
};