---
name: explicit-web
description: Retrieve sources through an explicitly chosen route
on-demand: true
---
Use existing webfetch/search permissions and domain guards. Identify the destination before submitting a query. Keep hosted fallback disabled unless the user explicitly authorizes that endpoint and disclosure. Never forward credentials, secret markers, private queries or authentication headers to a fallback destination. A missing credential is an error, not consent to switch providers. Report the route and whether fallback occurred. Use packages/tools/src/web-routing.ts only behind the daemon's normal permission boundary. Do not install providers or edit another harness's configuration.
