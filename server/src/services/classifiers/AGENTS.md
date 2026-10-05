# Classifier Tagging & Filter Convention

## Core Principle: No Tags By Default
Classifiers must **not** add tags to assets by default. The `tags` table is reserved for user curation and explicit tagging.

## Dedicated Filters Over Tags
Classifiers must persist their results into structured asset metadata (e.g. `metadata.pack`, `metadata.bpm`, `metadata.spriteType`). Querying and search must rely on dedicated filter prefixes handled by the filter parser:
- `pack:<name>` / `p:<name>` for pack classifier results
- `bpm:<range|tempo>` for BPM classifier results
- `sprite:<type>` for sprite classifier results

## Explicit Opt-In Only
Tag creation is strictly opt-in and disabled by default (`applyTag: false`, `applyBpmTag: false`, `applySpriteTag: false`). Tags are only written to the database if the user or caller explicitly enables them in settings (`applyTag === true`). When re-classifying, classifiers must always purge previously generated tags for their source (`removeAssetTagsBySource`) before applying any requested tags.
