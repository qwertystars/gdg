const fs = require("node:fs");

const value = BigInt(fs.readFileSync(0, "utf8").trim());
console.log(String(value * 2n));
