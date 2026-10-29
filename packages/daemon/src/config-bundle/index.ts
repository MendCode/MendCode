/**
 * Personal configuration bundles (docs/config-bundle.md): export the user's MendCode setup to one verifiable file, preview
 * an import against another data directory, apply it with backups and a journal, roll it back, and compare the result.
 * Separate from packages: a bundle carries the user's own folder, installed packages and settings, never secrets or history.
 */
export { BUNDLE_FORMAT, BUNDLE_VERSION, ConfigBundleError, readBundle, parseBundle, serializeBundle, manifestHash, type Bundle, type BundleManifest } from "./bundle"
export { classifyEntry, classifySetting, CONFIG_IMPORTS_DIR, PORTABLE_SETTINGS, APPROVAL_SETTINGS, MACHINE_SETTINGS, type MatrixColumn } from "./classify"
export { exportBundle, bundleSettings, hostHints, installedTreeHash, type InventoryRow, type ExportInput } from "./export"
export { planImport, linkOnPath, dependencyNames, type ImportPlan, type PlanStep, type Resolution } from "./plan"
export { applyImport, rollbackImport, listImports, type ImportPorts, type ImportJournal, type ImportResult } from "./apply"
export { compareWithBundle, type CompareReport, type CompareRow } from "./compare"
