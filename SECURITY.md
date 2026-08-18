# Security Policy

## Supported versions

TrailStep is early-stage. Security fixes are prioritized for the current published versions of the public `@trailstep/*` packages.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Report security concerns privately by using GitHub's private vulnerability reporting if it is enabled for this repository, or by contacting the maintainer directly through the GitHub profile for `@chily-john`.

Please include as much detail as possible:

- affected package or workflow
- affected version or commit
- reproduction steps
- expected impact
- any known mitigations

## Response expectations

TrailStep is maintained part-time, but security reports will be prioritized. The maintainer will aim to acknowledge valid reports within 7 days and provide updates as investigation progresses.

## Scope

Security-sensitive areas include:

- workflow execution and continuation behavior
- local artifact handling
- package installation/update flows
- GitHub/npm release automation
- agent/provider command execution
- secret or credential handling

Out-of-scope reports include social engineering, spam, denial-of-service against public GitHub infrastructure, or findings that require already having full local machine access without a TrailStep-specific escalation.
