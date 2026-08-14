function ensureDefaultAfterEnrolment({ app, enrolled, alreadyConfigured, persistConfigured }) {
  if (!app?.isPackaged || process.platform !== "darwin") return Object.freeze({ configured: false, reason: "not-packaged-macos" });
  if (!enrolled) return Object.freeze({ configured: false, reason: "not-enrolled" });
  if (alreadyConfigured) return Object.freeze({ configured: true, reason: "previously-configured", settings: app.getLoginItemSettings() });
  app.setLoginItemSettings({ openAtLogin: true });
  const settings = app.getLoginItemSettings();
  persistConfigured();
  return Object.freeze({ configured: true, reason: "default-enabled-after-enrolment", settings });
}

module.exports = Object.freeze({ ensureDefaultAfterEnrolment });
