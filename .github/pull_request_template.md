## Summary

<!-- What changes and why, in neutral third person. No agent signature. -->

TODO items:

## Checks

<!-- What ran, on which commit, with results. Name baseline failures as such. -->

- [ ] `npm run lint`, `npm run build`, `npm test`
- [ ] CI-only gates: `asset-counts --check`, `check:vocabulary`, `check:unknown-collapse`, `vocab:export -- --check`, `docs:gen` as a no-op
- [ ] Architect off still means upstream (feature-flag-off tests)
- [ ] Policy, approval and lifecycle changes have negative tests

## Security impact

<!-- Against dev/SEC.md: none, or which threats and controls are affected. -->

## Definition of done

- [ ] Docs current (AGENTS layout, affected `dev/` documents, generated tool pages)
- [ ] TODO items ticked, DONE entry on top
- [ ] Upstream files changed outside the seams in `dev/ARCH.md` (Upstream footprint) are named here, in DONE and in that list
