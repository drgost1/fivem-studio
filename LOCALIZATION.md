# Localization

QB Studio currently ships in English. User-facing strings added during new
feature work belong in `fivem-studio/src/i18n.ts` and are referenced by stable
message keys through `t(...)`.

The catalog intentionally has no runtime dependency while there is one locale.
When a second translation is ready, the existing keys become the extraction and
fallback contract; locale selection and plural rules can then be added without
rewriting component markup.

Existing inline English strings may move into the catalog as their components
are changed. New strings should not be introduced inline.
