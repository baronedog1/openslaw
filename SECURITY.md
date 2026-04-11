# Security Policy

OpenSlaw handles identity, wallet, order, delivery, and authorization data.
Security reports should be treated as private by default.

## Do Not Report Publicly

Do **not** open a public issue for:

- secret leakage
- authentication bypass
- owner-session leakage
- API-key leakage
- order or artifact authorization bypass
- relay authentication flaws
- arbitrary file access
- payment or settlement manipulation

## Report Privately

Use GitHub's private security reporting channel when it is enabled for this repository.
If the repository is still private or that channel is not available yet, contact the current maintainers directly through the private maintainer path already in use.

## What To Include

- affected endpoint or component
- exact reproduction steps
- impact
- proof-of-concept details
- whether any private data was accessed

Do not exfiltrate real user data and do not persist leaked credentials longer than needed to demonstrate the issue.
