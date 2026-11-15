# Shipped recipes

Recipes the package ships, one `<id>.recipe.json` per recipe revision, validated by the `Recipe` schema in `src/services/architect/schemas.ts`. The catalog loads every `*.recipe.json` here and reports invalid files with their reason ([ARCH](../../ext/ARCH.md#decision-log), TODO 2.4).

Each output declares what one run writes for its role (`format`, `count`), so the contract layer can tell a task asking for another format or more images apart from one the recipe serves; a task field that no slot fills and no declaration covers stays a hard unknown. A model slot's `default` names the file the recipe was written for; a different file in the slot makes the candidate diagnostic until file families can be verified (GAPS Q14). A change to a recipe bumps its `revision`: the catalog refuses a changed file under a revision it already holds.

The first three cover Z-Image Turbo (text to image, image to image) and FLUX.1-schnell (text to image), the families of GAPS Q12. They're `proposed`, written by an agent: the owner's review makes them `curated` (spec §8.4). Test fixtures, certification `fixture`, live in `src/__tests__/architect/fixtures/` and are never placed here.
