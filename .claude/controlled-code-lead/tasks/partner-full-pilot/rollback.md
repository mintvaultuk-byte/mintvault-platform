# Rollback — partner-full-pilot continuation

If the repaired staging paths regress, redeploy the immediately preceding staging application commit `f51f0a4c122bd91a49c4df557fc6c7e9a97d8db4` through the safe staging deploy path. This repair has no migration, data rewrite, or external-provider mutation, so no database or storage rollback is required.
