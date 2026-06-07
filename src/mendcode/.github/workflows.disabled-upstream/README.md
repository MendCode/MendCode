# Disabled Upstream Workflows

These files are the original OpenCode GitHub Actions workflows, kept only as
upstream reference material.

They are intentionally outside `.github/workflows/` and use `.disabled`
extensions so they cannot run if the MendCode repository is published or copied
as-is. MendCode release, publish, CI, and registry workflows must be rebuilt
under the repository root with MendCode-owned permissions and secrets.
