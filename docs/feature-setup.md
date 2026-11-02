# Feature setup audit

Setup changes only what the user confirms. Missing credentials, operating-system permissions, repository policy, models and
service installation are prerequisites, never authority to obtain or replace them silently. Existing low-level commands stay.

## Implemented priority paths

- **PR review (balanced):** `/pr setup [all|requested]` and `mendcode pr setup --session ID`. A read-only preflight precedes
  one publishing confirmation. Login, local remote and base configuration reads overlap; activity, claims and role memories
  are not read. The base config determines the default role. Missing prerequisites stay on a scrollable page. If `public`
  has review enabled while origin does not, the page offers the safe route of using a clone of that repository; remotes do not
  change. GitHub is the quick path; other forges retain the existing manual route.
- **Voice (full):** `/voice setup` checks the selected provider and readiness and confirms the upload implications before
  enabling. It does not record, switch providers, install a recorder or grant microphone/speech permissions. Missing external
  prerequisites remain on the result page. Existing on-device defaults remain unchanged.
- **Code graph (balanced):** `/graph setup` confirms project indexing and performs the build through `codegraph.overview`.
  It keeps global indexing, autopilot and models unchanged. A protected folder or missing indexer is reported, not bypassed.

These were prioritized as direct everyday entry points, not from measured usage telemetry.

## Other multi-step paths

- **Experimental switches:** retain explicit flags; do not bulk-enable them. First-use guidance should name the exact flag,
  tier, network/spending implications and feature command together. PR has the integrated implementation above. Other flags
  retain their current first-use messages; a universal setup dispatcher is deferred because permissions and effects differ.
- **Providers and connect (core):** retain `/connect` as the existing guided first-use page: provider/method selection,
  credential form, test outcome and model-page action. Credentials are not guessed and model selection remains the user's.
- **Remote control pairing:** prefer a prerequisite page, not automatic pairing. Bot credentials and sending a pairing code
  from the user's chat are external proof of control; they cannot be combined into silent activation. The current commands
  remain; replacing their toast guidance with a unified page is deferred.
- **Computer use (explicit opt-in, any tier):** preserve separate target approval and macOS Accessibility/Screen Recording
  grants. A prerequisite page is preferable to automatically opening helpers or permissions. Existing tool errors give the
  missing permission and helper path; a dedicated page is deferred.
- **Loops (core):** preserve the existing creation form/templates and explicit schedule, budget and activation. No default
  recurring job is created by setup; model calls and external effects need a concrete objective.
- **Workflows (core; script workflows tier-gated):** preserve preview/start and their permissions/budget confirmation.
  Creating a plan is not consent to execute it. A valid existing workflow already has the single start entry point.
- **Reviewer server and hosted Action:** retain topology documentation and external prerequisites (machine login, service,
  repository secrets, base policy). `/pr setup all` replaces local reviewer activation only; it neither installs a service nor
  publishes a hosted workflow. Those effects require separate, machine-specific approval.

## Limits

The audit does not claim every legacy first-use message has been migrated. The implemented minimum is PR plus voice and graph.
External credentials, live forge writes, OS permissions and service availability are not proven by fixture tests.
