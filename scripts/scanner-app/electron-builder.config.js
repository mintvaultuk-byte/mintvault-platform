const path = require("node:path");

const APP_IDENTIFIER = "com.mintvault.scanner";
const PRODUCT_NAME = "MintVault Scanner";
const MINIMUM_MACOS = "12.0";
const mode = process.env.MINTVAULT_PACKAGE_MODE || "local";
const release = mode === "release";
const contract = require("./scripts/package-contract");

if (!new Set(["local", "release"]).has(mode)) {
  throw new Error("MINTVAULT_PACKAGE_MODE must be local or release");
}

const identity = release ? process.env.MINTVAULT_DEVELOPER_ID_APPLICATION : "-";
if (release && !identity) {
  throw new Error("release packaging requires MINTVAULT_DEVELOPER_ID_APPLICATION");
}
if (release && contract.validateTeamIdentifier(process.env.MINTVAULT_APPLE_TEAM_ID) !== contract.releaseTeamAuthority()) {
  throw new Error("release package Team does not match the owner-pinned MintVault authority");
}

module.exports = {
  appId: APP_IDENTIFIER,
  productName: PRODUCT_NAME,
  artifactName: "MintVault-Scanner-${version}-arm64.${ext}",
  asar: true,
  asarUnpack: [
    "node_modules/@img/sharp-darwin-arm64/lib/*.node",
    "node_modules/@img/sharp-libvips-darwin-arm64/lib/*.dylib",
  ],
  directories: {
    output: "dist",
    buildResources: "build",
  },
  files: [
    "main.js",
    "preload.js",
    "package.json",
    "renderer/**/*",
    "assets/**/*",
    "lib/**/*",
    "!lib/agent-plist.js",
    "!**/*.map",
    "!**/*.test.js",
    "!**/test{,s}/**/*",
    "!node_modules/**/{install,test,tests,example,examples,docs}/**/*",
    "!node_modules/**/*.{c,cc,cpp,gyp,h,hpp,m,swift}",
    "!node_modules/**/*.d.ts",
    { from: "build/generated", to: "generated", filter: ["release-team-pin.js"] },
  ],
  extraFiles: [
    { from: "native/bin/mv-capture-helper", to: "Helpers/mv-capture-helper" },
    { from: "native/bin/mv-identity-helper", to: "Helpers/mv-identity-helper" },
  ],
  extraResources: [
    { from: "native/bin/helper-manifest.json", to: "helper-manifests/helper-manifest.json" },
    { from: "native/bin/identity-helper-manifest.json", to: "helper-manifests/identity-helper-manifest.json" },
    { from: "build/generated/release-trust.json", to: "release-trust.json" },
  ],
  mac: {
    category: "public.app-category.business",
    icon: path.join(__dirname, "build", "scanner.icns"),
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    minimumSystemVersion: MINIMUM_MACOS,
    identity,
    type: "distribution",
    hardenedRuntime: release,
    gatekeeperAssess: false,
    entitlements: path.join(__dirname, "build", "entitlements.mac.plist"),
    entitlementsInherit: path.join(__dirname, "build", "entitlements.mac.inherit.plist"),
    preAutoEntitlements: false,
    strictVerify: true,
    signIgnore: [
      "/Contents/Helpers/mv-capture-helper$",
      "/Contents/Helpers/mv-identity-helper$",
    ],
    notarize: release,
    extendInfo: {
      LSUIElement: true,
      LSMinimumSystemVersion: MINIMUM_MACOS,
      NSHumanReadableCopyright: "Copyright © MintVault. All rights reserved.",
    },
  },
  dmg: {
    sign: release,
    title: `${PRODUCT_NAME} ${process.env.npm_package_version || ""}`.trim(),
  },
  publish: [{
    provider: "generic",
    url: process.env.MINTVAULT_UPDATE_BASE_URL || "https://updates.invalid/mintvault/scanner",
    channel: "latest",
  }],
  forceCodeSigning: release,
  beforePack: path.join(__dirname, "scripts", "before-pack.js"),
  afterSign: path.join(__dirname, "scripts", "after-sign.js"),
};
