const path = require("node:path");
const contract = require("./package-contract");

module.exports = async function afterSign(context) {
  if (contract.packageMode() !== "release") return;
  const appPath = path.join(context.appOutDir, `${contract.PRODUCT_NAME}.app`);
  contract.run("/usr/bin/xcrun", ["stapler", "staple", "-v", appPath]);
  contract.run("/usr/bin/xcrun", ["stapler", "validate", "-v", appPath]);
  contract.run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
};
