import { PROGRAM_NAME } from "@mendcode/program"
import { packageFiles as files, scaffoldPackage as scaffold } from "@mendcode/extension-api/package-scaffold"

export { PACKAGE_NAME_PATTERN, type PackageScaffold, type ScaffoldPackageResult } from "@mendcode/extension-api/package-scaffold"
export const packageFiles = (name: string) => files(name, PROGRAM_NAME)
export const scaffoldPackage = (options: { name: string; parent: string }) => scaffold({ ...options, program: PROGRAM_NAME })
