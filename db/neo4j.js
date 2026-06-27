/**
 * neo4j.js — graph database connection and query helpers (v2)
 *
 * Changes from v1:
 *   - writeFarmerNode: removed gender field, added farmAccess
 *   - writeEvidenceGraph: NEW — writes the full evidence graph
 *     payload produced by ussdFlow.js buildEvidenceGraphPayload()
 *   - getEvidenceProfile, getNetworkBonus, seedDemoCooperative: unchanged
 *
 * Node model (v2):
 *   (:Farmer)         — phoneHash, location, farmAccess, crop, scoredAt
 *   (:FarmTenure)     — type, leaseLength, evidenceRole
 *   (:CropActivity)   — cropType, season, herdSize, milkCooperative, evidenceRole
 *   (:CommunityGroup) — type, paymentFrequency, evidenceRole
 *   (:LoanRecord)     — outcome, evidenceRole
 *   (:InputPurchase)  — frequency, evidenceRole
 *   (:MPesaConsent)   — granted, evidenceRole
 *   (:Cooperative)    — name (pre-existing, for network evidence)
 *   (:Lender)         — name (pre-existing)
 *   (:ClimateZone)    — (pre-existing)
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

async function query(cypher, params = {}) {
  const d = getDriver();
  if (!d) return [];

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

// ── Schema setup ───────────────────────────────────────────────────────────────

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

// ── Farmer node write ──────────────────────────────────────────────────────────

/**
 * Upsert a Farmer node.
 * gender removed — not collected or stored.
 * farmAccess added — replaces land size as tenure signal.
 */
async function writeFarmerNode({ phoneHash, tier, crop, farmAccess, location, coopName, hadLoan, repaid }) {
  await query(
    `MERGE (f:Farmer {phoneHash: $phoneHash})
     SET f.tier       = $tier,
         f.crop       = $crop,
         f.farmAccess = $farmAccess,
         f.location   = $location,
         f.updatedAt  = datetime()`,
    { phoneHash, tier, crop, farmAccess, location }
  );

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

// ── Evidence graph write (NEW in v2) ───────────────────────────────────────────

/**
 * Write the full evidence graph produced by ussdFlow.js buildEvidenceGraphPayload().
 *
 * The payload shape is:
 * {
 *   phoneHash: string,
 *   nodes: [{ label: string, props: object }],
 *   relationships: [{ from: string, to: string, type: string }]
 * }
 *
 * Strategy:
 *   - Each non-Farmer node is keyed by (phoneHash + label) to allow
 *     upsert without collision across multiple assessments.
 *   - Relationships are MERGE'd so re-running an assessment doesn't
 *     create duplicate edges.
 *   - CommunityGroup nodes of type 'chama'/'sacco'/'coop' are also
 *     linked to the global Cooperative node if one exists, enabling
 *     the existing getEvidenceProfile Layer 1/2/3 queries to work.
 */
async function writeEvidenceGraph({ nodes, relationships, phoneHash }) {
  if (!phoneHash) {
    console.warn('writeEvidenceGraph called without phoneHash — skipping');
    return;
  }

  // Ensure farmer node exists first
  await query(
    `MERGE (f:Farmer {phoneHash: $phoneHash})
     SET f.updatedAt = datetime()`,
    { phoneHash }
  );

  // Write each node (skip Farmer — already written above)
  for (const node of nodes) {
    if (node.label === 'Farmer') continue;

    // Build SET clause from props — exclude undefined values
    const cleanProps = Object.fromEntries(
      Object.entries(node.props).filter(([, v]) => v !== undefined && v !== null)
    );

    if (Object.keys(cleanProps).length === 0) continue;

    const setParts = Object.keys(cleanProps).map(k => `n.${k} = $${k}`).join(', ');

    await query(
      `MERGE (f:Farmer {phoneHash: $phoneHash})
       MERGE (n:${node.label} {phoneHash: $phoneHash, nodeLabel: '${node.label}'})
       SET ${setParts}`,
      { phoneHash, ...cleanProps }
    );

    // Special case: CommunityGroup with type chama/sacco/coop
    // Link it to a global Cooperative node so getEvidenceProfile queries can traverse it
    if (node.label === 'CommunityGroup' && ['chama', 'sacco', 'coop'].includes(cleanProps.type)) {
      const coopName = `${cleanProps.type}_${phoneHash.slice(0, 8)}`;
      await query(
        `MERGE (c:Cooperative {name: $coopName})
         SET c.type = $type, c.updatedAt = datetime()
         WITH c
         MATCH (f:Farmer {phoneHash: $phoneHash})
         MERGE (f)-[:MEMBER_OF]->(c)`,
        { coopName, type: cleanProps.type, phoneHash }
      );
    }

    // Special case: LoanRecord — also write to BORROWED_FROM for getEvidenceProfile
    if (node.label === 'LoanRecord' && cleanProps.outcome) {
      const repaid = cleanProps.outcome === 'repaid_full' || cleanProps.outcome === 'repaid_chama';
      await query(
        `MERGE (l:Lender {name: 'self_reported'})
         WITH l
         MATCH (f:Farmer {phoneHash: $phoneHash})
         MERGE (f)-[r:BORROWED_FROM]->(l)
         SET r.repaid = $repaid, r.outcome = $outcome, r.recordedAt = datetime()`,
        { phoneHash, repaid, outcome: cleanProps.outcome }
      );
    }
  }

  // Write relationships between evidence nodes
  for (const rel of relationships) {
    if (rel.from === 'Farmer' && rel.to !== 'Farmer') {
      // Farmer → evidence node
      await query(
        `MATCH (f:Farmer {phoneHash: $phoneHash})
         MATCH (n {phoneHash: $phoneHash, nodeLabel: $toLabel})
         MERGE (f)-[:${rel.type}]->(n)`,
        { phoneHash, toLabel: rel.to }
      ).catch(err => {
        // Non-fatal: relationship may fail if node wasn't written (null props)
        console.warn(`writeEvidenceGraph rel ${rel.type} skipped:`, err.message);
      });
    } else if (rel.from === 'CommunityGroup' && rel.to === 'CropActivity') {
      // CommunityGroup → CropActivity (milk cooperative payment record)
      await query(
        `MATCH (g {phoneHash: $phoneHash, nodeLabel: 'CommunityGroup'})
         MATCH (c {phoneHash: $phoneHash, nodeLabel: 'CropActivity'})
         MERGE (g)-[:${rel.type}]->(c)`,
        { phoneHash }
      ).catch(err => {
        console.warn(`writeEvidenceGraph coop→crop rel skipped:`, err.message);
      });
    }
  }
}

// ── Evidence profile (unchanged from v1) ──────────────────────────────────────

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

  // Layer 1: Cooperative repayment rate
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
      evidence.signals.push(
        `Member of ${evidence.coopName} — ${rate}% repayment rate (${total} members)`
      );
    }
  }

  // Layer 2: Same-coop neighbors with clean repayment
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
      evidence.signals.push(`${neighbors} cooperative neighbors with verified clean repayment`);
    }
  }

  // Layer 3: Second-degree links
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
      evidence.adjustment += 15;
      evidence.signals.push(`${sd} second-degree connections with clean repayment in shared network`);
    }
  }

  // Peer guarantors
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
      evidence.signals.push(`${guarantors} active peer guarantor(s) with verified repayment history`);
    }
  }

  evidence.adjustment = Math.max(-40, Math.min(120, evidence.adjustment));
  return evidence;
}

// ── Network bonus (backward-compatible wrapper) ────────────────────────────────

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

// ── Seed demo data (unchanged) ─────────────────────────────────────────────────

async function seedDemoCooperative() {
  const d = getDriver();
  if (!d) { console.log('Neo4j not configured — skip seed'); return; }

  await query(`MERGE (c:Cooperative {name: 'Siaya Dairy Coop'}) SET c.region = 'Siaya'`);

  for (let i = 1; i <= 10; i++) {
    const hash   = `demo_member_${i}`;
    const repaid = i <= 9;
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
  writeEvidenceGraph,   // NEW
  getEvidenceProfile,
  getNetworkBonus,
  seedDemoCooperative,
  getDriver,
};