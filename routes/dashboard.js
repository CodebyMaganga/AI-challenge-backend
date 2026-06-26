// routes/dashboard.js
const express = require('express');
const router = express.Router();
const neo4j = require('neo4j-driver');

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

router.get('/location-risk', async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (l:Location)
      OPTIONAL MATCH (f:Farmer)-[:LOCATED_IN]->(l)
      OPTIONAL MATCH (f)-[:HAD_LOAN]->(loan)
      RETURN l.name AS location,
             COUNT(DISTINCT f) AS totalFarmers,
             COUNT(loan) AS totalLoans,
             SUM(CASE WHEN loan.status = 'DEFAULTED' THEN 1 ELSE 0 END) AS defaults,
             CASE WHEN COUNT(loan) > 0 THEN toFloat(SUM(CASE WHEN loan.status='DEFAULTED' THEN 1 ELSE 0 END)) / COUNT(loan) ELSE 0 END AS defaultRate
    `);
    const data = result.records.map(r => r.toObject());
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

router.get('/farmer-network/:phoneHash', async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (f:Farmer {phoneHash: $phoneHash})-[:MEMBER_OF]->(g)<-[:MEMBER_OF]-(peer)
      OPTIONAL MATCH (peer)-[:HAD_LOAN]->(l)
      RETURN peer.phoneHash AS peer,
             peer.crop AS crop,
             COUNT(l) AS loans,
             AVG(CASE l.status WHEN 'REPAID' THEN 1 ELSE 0 END) AS repayRatio
    `, { phoneHash: req.params.phoneHash });
    const data = result.records.map(r => r.toObject());
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

module.exports = router;