// scripts/getHashes.js
require('dotenv').config(); // if needed for DB connection, but hashPhone is likely pure
const { hashPhone } = require('../db/sessionStore');

const phones = ['+254707849963', '+254727416611', '+254700000003'];

phones.forEach(phone => {
  console.log(`${phone} → ${hashPhone(phone)}`);
});