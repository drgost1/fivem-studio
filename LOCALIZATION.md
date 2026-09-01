# Localization

FiveM Studio currently ships one locale: English (`en`). The catalog lives in
`fivem-studio/src/i18n.ts`; there is no locale selector, plural-rule engine, or
runtime translation dependency yet.

## Adding or changing text

New user-facing renderer text belongs in the `english` catalog and is rendered
through `t(...)` with a stable, descriptive key. Keep diagnostic strings from
Electron and the private runtime in their owning layer when they are primarily
developer logs or error details rather than interface labels.

Use named placeholders for variable content:

```ts
"resource.actionFailure": "Could not {action} {resource}: {message}"

t("resource.actionFailure", { action, resource, message })
```

TypeScript derives `MessageKey` from the catalog, so `npm run typecheck`
rejects unknown literal keys. Missing placeholder values intentionally remain
visible as `{name}`; this makes catalog mistakes detectable instead of silently
dropping information. React escapes the returned string when it is rendered as
text, but callers in another output context remain responsible for that
context's escaping.

When changing a component:

1. Reuse an existing key only when its meaning and grammar match.
2. Add a new key rather than constructing a sentence from translated
   fragments.
3. Keep accessibility labels and visible status/error text in the catalog too.
4. Run `npm run typecheck` and exercise variable, empty, and error states.

Existing inline English can move into the catalog as its component is changed.
Before adding a second locale, add locale selection and fallback behavior,
define pluralization and number/date formatting, and introduce a catalog parity
check. The existing stable keys are the extraction and fallback contract; a
second language should not require component markup to be rewritten.
