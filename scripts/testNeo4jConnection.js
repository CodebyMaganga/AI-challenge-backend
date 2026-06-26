require("dotenv").config();
const neo4j = require("neo4j-driver");

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(
    process.env.NEO4J_USERNAME,
    process.env.NEO4J_PASSWORD
  )
);

async function test() {
  try {
    await driver.verifyConnectivity();
    console.log("✅ Connected to Neo4j Aura");

    const session = driver.session({
      database: process.env.NEO4J_DATABASE
    });

    const result = await session.run("MATCH (n) RETURN count(n) AS count");

    console.log("Nodes:", result.records[0].get("count").toNumber());

    await session.close();
  } catch (err) {
    console.error("❌ Connection failed:", err.message);
  } finally {
    await driver.close();
  }
}

test();