# Shipped recipes

Recipes the package ships, one `<id>.recipe.json` per recipe revision, validated by the `Recipe` schema in `src/services/architect/schemas.ts`. The catalog loads every `*.recipe.json` here and reports invalid files with their reason ([ARCH](../../ext/ARCH.md#decision-log), TODO 2.4).

The first three cover Z-Image Turbo (text to image, image to image) and FLUX.1-schnell (text to image), the families of GAPS Q12. They're `proposed`, written by an agent: the owner's review makes them `curated` (spec §8.4). Test fixtures, certification `fixture`, live in `src/__tests__/architect/fixtures/` and are never placed here.
