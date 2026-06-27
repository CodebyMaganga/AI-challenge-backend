// db/chamaRegistry.js
/**
 * Static chama registry — used by the field officer dashboard dropdown.
 *
 * In production this would be a MongoDB collection seeded from
 * the Cooperative Societies Registry (Ministry of Industrialisation, Kenya).
 *
 * For the hackathon, this static file is enough to demonstrate
 * the community verification workflow.
 */

module.exports = [
  // ── Kiambu ──────────────────────────────────────────────────────────────────
  {
    id: "CH001",
    county: "Kiambu",
    subCounty: "Kikuyu",
    ward: "Karai",
    name: "Karai Women Dairy Chama",
    type: "Women's Savings Group",
    memberCount: 24,
    active: true,
  },
  {
    id: "CH002",
    county: "Kiambu",
    subCounty: "Kikuyu",
    ward: "Gikambura",
    name: "Gikambura Green Growers",
    type: "Farmer Group",
    memberCount: 18,
    active: true,
  },
  {
    id: "CH003",
    county: "Kiambu",
    subCounty: "Limuru",
    ward: "Limuru Central",
    name: "Limuru Dairy Women Group",
    type: "Women's Savings Group",
    memberCount: 31,
    active: true,
  },
  {
    id: "CH004",
    county: "Kiambu",
    subCounty: "Thika",
    ward: "Kamenu",
    name: "Kamenu Smallholder SACCO",
    type: "SACCO",
    memberCount: 140,
    active: true,
  },

  // ── Murang'a ─────────────────────────────────────────────────────────────────
  {
    id: "CH005",
    county: "Murang'a",
    subCounty: "Kigumo",
    ward: "Kigumo",
    name: "Kigumo Women Coffee Group",
    type: "Women's Savings Group",
    memberCount: 22,
    active: true,
  },
  {
    id: "CH006",
    county: "Murang'a",
    subCounty: "Kangema",
    ward: "Rwathia",
    name: "Rwathia Tea Growers Coop",
    type: "Agricultural Cooperative",
    memberCount: 87,
    active: true,
  },

  // ── Machakos ─────────────────────────────────────────────────────────────────
  {
    id: "CH007",
    county: "Machakos",
    subCounty: "Machakos Town",
    ward: "Mutituni",
    name: "Mutituni Women Akiba Group",
    type: "Women's Savings Group",
    memberCount: 15,
    active: true,
  },
  {
    id: "CH008",
    county: "Machakos",
    subCounty: "Kathiani",
    ward: "Kathiani Central",
    name: "Kathiani Smallholder Farmers",
    type: "Farmer Group",
    memberCount: 34,
    active: true,
  },

  // ── Nakuru ────────────────────────────────────────────────────────────────────
  {
    id: "CH009",
    county: "Nakuru",
    subCounty: "Nakuru Town East",
    ward: "Biashara",
    name: "Biashara Women Finance Chama",
    type: "Women's Savings Group",
    memberCount: 19,
    active: true,
  },
  {
    id: "CH010",
    county: "Nakuru",
    subCounty: "Rongai",
    ward: "Visoi",
    name: "Visoi Dairy Cooperative",
    type: "Agricultural Cooperative",
    memberCount: 62,
    active: true,
  },

  // ── Nyeri ─────────────────────────────────────────────────────────────────────
  {
    id: "CH011",
    county: "Nyeri",
    subCounty: "Tetu",
    ward: "Dedan Kimathi",
    name: "Tetu Women Dairy Group",
    type: "Women's Savings Group",
    memberCount: 28,
    active: true,
  },
  {
    id: "CH012",
    county: "Nyeri",
    subCounty: "Mathira",
    ward: "Ruguru",
    name: "Ruguru Coffee Farmers SACCO",
    type: "SACCO",
    memberCount: 210,
    active: true,
  },
];