# Shipped recipes

Recipes the package ships, one `<id>.recipe.json` per recipe revision, validated by the `Recipe` schema in `src/services/architect/schemas.ts`. The catalog loads every `*.recipe.json` here and reports invalid files with their reason ([ARCH](../../ext/ARCH.md#decision-log), TODO 2.4).

None are shipped yet: which model families the first curated recipes cover is GAPS Q12. Test fixtures, certification `fixture`, live in `src/__tests__/architect/fixtures/` and are never placed here.
