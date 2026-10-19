# Classifier Tagging & Filter Convention

## Core Principle: No Tags
Classifiers must **never** add tags to assets. The `tags` table is reserved for user assignment; the scanner does not write tags either.

## Dedicated Filters Over Tags
Classifiers must persist their results into structured asset metadata (e.g. `metadata.pack`, `metadata.bpm`, `metadata.spriteType`, `metadata.folders`). Querying and search must rely on dedicated filter prefixes handled by the filter parser:
- `pack:<name>` / `p:<name>` for pack classifier results
- `bpm:<range|tempo>` for BPM classifier results
- `sprite:<type>` for sprite classifier results
- `folder:<name>` for folder classifier results (any subfolder of the library-relative path)

The same applies to scanner facts: extension, category, and location are queried with `ext:`, `cat:`, `path:`/`in:`/`dir:`, and `is:archive`, never through tags.
