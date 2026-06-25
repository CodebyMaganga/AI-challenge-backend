// services/neo4jService.js
/**
 * Neo4j graph service for network‑based risk signals.
 *
 * If NEO4J_URI is set, connects to the database and returns
 * real location risk + social reputation scores.
 * If not, returns neutral defaults — so the engine never crashes.
 */

const neo4j = require('neo4j-driver');

let driver;
if (process.env.NEO4J_URI) {
  driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USERNAME || 'neo4j', process.env.NEO4J_PASSWORD || 'password')
  );
  console.log('✅ Neo4j driver initialized');
} else {
  console.warn('⚠️  NEO4J_URI not set — graph features will be neutral');
}

/**
 * Fetch location and social network risk for a farmer.
 * Returns:
 *   locationDefaultRate: float 0–1 (default rate in the farmer's ward)
 *   locationFarmerCount: number of farmers in same location
 *   socialScore: 0–100 (reputation based on connected peers' repayment)
 *   connectedPeers: number of peer farmers in same group/coop
 *   avgRepayRatio: average repayment ratio of those peers
 */
async function getNetworkRisk(phoneHash, location) {
  // No driver → return neutral
  if (!driver) {
    return {
      locationDefaultRate: 0,
      locationFarmerCount: 0,
      socialScore: 0,
      connectedPeers: 0,
      avgRepayRatio: 0,
    };
  }

  const session = driver.session();
  try {
    // 1. Location default rate
    const locationResult = await session.run(
      `MATCH (f:Farmer)-[:LOCATED_IN]->(l:Location {name: $location})
       OPTIONAL MATCH (f)-[:HAD_LOAN]->(loan:LoanApplication)
       WITH COUNT(DISTINCT f) AS totalFarmers,
            SUM(CASE WHEN loan.status = 'DEFAULTED' THEN 1 ELSE 0 END) AS defaults
       RETURN totalFarmers,
              CASE WHEN totalFarmers > 0 THEN toFloat(defaults) / totalFarmers ELSE 0 END AS defaultRate`,
      { location }
    );
    const locData = locationResult.records[0]?.toObject() || { totalFarmers: 0, defaultRate: 0 };

    // 2. Social reputation via group/co‑op membership
    const socialResult = await session.run(
      `MATCH (f:Farmer {phoneHash: $phoneHash})-[:MEMBER_OF]->(g:Group)<-[:MEMBER_OF]-(peer:Farmer)
       WHERE peer.phoneHash <> $phoneHash
       OPTIONAL MATCH (peer)-[:HAD_LOAN]->(loan:LoanApplication)
       WITH peer, COUNT(loan) AS peerLoans,
            SUM(CASE WHEN loan.status = 'REPAID' THEN 1 ELSE 0 END) AS repaid
       WHERE peerLoans > 0
       RETURN COUNT(peer) AS connectedPeers,
              AVG(toFloat(repaid)/peerLoans) AS avgRepayRatio`,
      { phoneHash }
    );
    const socialData = socialResult.records[0]?.toObject() || { connectedPeers: 0, avgRepayRatio: 0 };

    // Convert to 0–100 social score
    let socialScore = 0;
    if (socialData.connectedPeers > 0) {
      socialScore = 50 + (socialData.avgRepayRatio || 0) * 50;
    }

    return {
      locationDefaultRate: locData.defaultRate,
      locationFarmerCount: locData.totalFarmers,
      socialScore: Math.round(Math.min(100, socialScore)),
      connectedPeers: socialData.connectedPeers,
      avgRepayRatio: socialData.avgRepayRatio,
    };
  } catch (err) {
    console.error('Neo4j query error (using neutral fallback):', err.message);
    return {
      locationDefaultRate: 0,
      locationFarmerCount: 0,
      socialScore: 0,
      connectedPeers: 0,
      avgRepayRatio: 0,
    };
  } finally {
    await session.close();
  }
}

module.exports = { getNetworkRisk };