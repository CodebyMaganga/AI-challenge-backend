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
 * Network score boost (0–120 pts) added on top of base USSD score:
 *   +80  cooperative repayment rate > 85%
 *   +40  at least 2 neighbors (same coop) with full repayment
 *   +30  has an active peer guarantor
 *   -40  cooperative repayment rate < 60% (red flag)
 *
 * Falls back gracefully to 0 bonus if Neo4j is not configured.
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

// ── Network score boost ───────────────────────────────────────────────────────

/**
 * Look up the farmer's cooperative network and compute a bonus score.
 * Returns an object: { bonus: number, reason: string|null }
 *
 * Bonus breakdown (max 120 pts):
 *   +80   coop repayment rate >= 85%
 *   +40   2+ coop neighbors fully repaid
 *   +30   active guarantor linked
 *   -40   coop repayment rate < 60%
 */
async function getNetworkBonus(phoneHash) {
  const result = { bonus: 0, reason: null };

  // ── Cooperative repayment rate ────────────────────────────────────────────
  const coopRows = await query(
    `MATCH (f:Farmer {phoneHash: $phoneHash})-[:MEMBER_OF]->(c:Cooperative)
     OPTIONAL MATCH (c)<-[:MEMBER_OF]-(member:Farmer)-[loan:BORROWED_FROM]->()
     WITH c,
          count(loan)                          AS totalLoans,
          sum(CASE WHEN loan.repaid THEN 1 ELSE 0 END) AS repaidLoans
     WHERE totalLoans > 0
     RETURN c.name AS coopName,
            round(toFloat(repaidLoans) / totalLoans * 100, 1) AS repayRate,
            totalLoans`,
    { phoneHash }
  );

  if (coopRows.length > 0) {
    const rate = coopRows[0].repayRate;
    const total = coopRows[0].totalLoans;

    if (rate >= 85 && total >= 5) {
      result.bonus += 80;
      result.reason = `Cooperative repayment rate: ${rate}% across ${total} members`;
    } else if (rate < 60 && total >= 5) {
      result.bonus -= 40;
      result.reason = `Cooperative repayment concern: ${rate}% rate`;
    }
  }

  // ── Neighbor repayment (same coop, repaid fully) ──────────────────────────
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
    const neighbors = neo4j.integer.toNumber(neighborRows[0].goodNeighbors || 0);
    if (neighbors >= 2) {
      result.bonus += 40;
      result.reason = (result.reason ? result.reason + '; ' : '') +
        `${neighbors} cooperative neighbors with clean repayment`;
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
    const guarantors = neo4j.integer.toNumber(guarantorRows[0].guarantors || 0);
    if (guarantors >= 1) {
      result.bonus += 30;
      result.reason = (result.reason ? result.reason + '; ' : '') +
        `Active peer guarantor with clean history`;
    }
  }

  result.bonus = Math.max(-40, Math.min(120, result.bonus));
  return result;
}

// ── Seed demo cooperative data ────────────────────────────────────────────────
// Run once to create a realistic cooperative network for demos

async function seedDemoCooperative() {
  const d = getDriver();
  if (!d) { console.log('Neo4j not configured — skip seed'); return; }

  // Create Siaya Dairy Coop with 10 members, 9 repaid
  await query(`MERGE (c:Cooperative {name: 'Siaya Dairy Coop'}) SET c.region = 'Siaya'`);

  for (let i = 1; i <= 10; i++) {
    const hash = `demo_member_${i}`;
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

  console.log('✅ Demo cooperative seeded: Siaya Dairy Coop (90% repayment, 10 members)');
}

module.exports = {
  query,
  initSchema,
  writeFarmerNode,
  getNetworkBonus,
  seedDemoCooperative,
  getDriver,
};