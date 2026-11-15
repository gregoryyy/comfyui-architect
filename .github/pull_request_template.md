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

<!-- Against ext/SEC.md: none, or which threats and controls are affected. -->

## Definition of done

- [ ] Docs current (AGENTS layout, affected `ext/` documents, generated tool pages)
- [ ] TODO items ticked, DONE entry on top
- [ ] Upstream files changed outside the seams in `ext/input/BOOT.md` are named here and in DONE
