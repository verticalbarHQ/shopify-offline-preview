# Shopify comparison harness (internal)

"Done" for this project means matching real Shopify renders ([SPEC §9](../SPEC.md#9-verification-system)):
the same themes and data are rendered on a dedicated Shopify development store and compared with
the offline renderer. The tools for that live in `tools/oracle/`. They are development utilities,
not part of the published package, and they are not a store importer.

**Status.** No golden has been captured. The designated development store has not been dedicated
or wiped; the first wipe needs a manual export and the owner's confirmation at that moment. The
tools below have been exercised against authored HTTP fixtures only. A tool passing does not
establish store coverage, restoration, capture readiness or Shopify parity.

## Safety rules shared by all tools

- Every store operation checks the pinned development store (domain, shop ID, development-store
  status) and the marker metafield `sop.oracle_store = "true"` immediately before acting.
- Mutations need explicit authorization callbacks; serialized flags or hand-built receipts cannot
  stand in for verified execution. Themes are pushed unpublished and never published or deleted.
- Lost or uncertain write outcomes are never replayed blindly; private journals block further
  writes until an operator reconciles them.
- Errors expose fixed codes, never API messages or credential values. Raw payloads and readable
  outputs stay in owner-only files under the ignored `.local/`; public artifacts contain hashes.

## Parity check

`pnpm parity:check [--snapshot <base-snapshot.json>] --case-snapshots <manifest.json> [--release]`
compares instrumented offline renders with captures in `oracle/goldens/{dawn,horizon}/`. It requires
all 36 cases, the exact theme pins, paths, scenarios, base-fixture hash, calibrated case-snapshot
hashes and comparison-copy file hashes, and fails on Liquid errors or unimplemented events. Each
calibrated snapshot renders verbatim, including the observed clock and identifiers. `--release`
also enforces the seven-day capture window. It fails today because no captures exist.

## Preparation commands

These make no Shopify requests and grant no authorization.

- `pnpm oracle:corpus-prepare --path-map <fixture-path-map.json> [--environment <deps.json>]`
  prepares a temporary theme for the 235 nonempty documented filter examples. The path map pairs
  each original context path with a fixture path of the same page kind; the ten empty upstream
  examples are reported, not invented. `--environment` supplies authored dependency files (assets,
  locale JSON, settings files; never layouts, templates, sections or snippets), each with
  `encoding` (`utf8` or base64) and `provenance: "authored-fixture"`. Each case binds its exact
  harness bytes with `harnessHash`.
- `pnpm oracle:backup-audit --catalog <dir> --theme <dir>` audits existing pre-wipe exports against
  `.local/oracle.json`: file hashes, product counts, cursor chains, nested pagination and the archive
  inventory. Exit 2 means integrity or scope findings, 3 invalid input.
- `pnpm oracle:supplemental-backup-audit --kind <collections|product-media|content|inventory|collection-sources> --archive <dir>`
  checks supplemental exports the same way.
- `pnpm oracle:seed-prepare --snapshot <snapshot.json> --images <png-dir>` plans the desired store
  state for the 18-request matrix: identical persistent states are grouped, session carts kept
  separate, dependencies ordered, and ambiguous image metadata, inventory and menu references
  reported. Fixture images must be local PNGs matching their snapshot dimensions.
- `pnpm oracle:seed-requests-prepare --snapshot <snapshot.json> --images <png-dir> --admin-schema <schema.json>`
  compiles create/update request templates and validates them against a retained Admin API input
  schema. Real IDs, processed image URLs, the inventory location and the Online Store publication
  must resolve before a request can be formed. Store-generated values (resource, image and option
  value IDs) are calibrated after seeding; set option swatches and image focal points have no
  seeding adapter yet and are refused.

## Runtime components

Composed by `tools/oracle/seed-state-driver.ts`; no live CLI wires them to a store yet.

- **Seeding** (`seed-execution.ts`, `seed-binding-ledger.ts`, `seed-identities.ts`): accepts only
  steps compiled from the validated fixture matrix, rechecks the store and scopes on every attempt,
  allows at most four throttled attempts, and records ownership only from verified executions
  followed by identity reads. Content SEO is written and verified through the typed
  `global.title_tag` / `global.description_tag` metafields. Platform-default menu bootstrap, durable
  provenance recovery and staged-upload receipts remain unfinished.
- **Theme upload** (`theme-upload.ts`): connects a prepared comparison copy to an unpublished
  `shopify theme push`, stages only recognized theme files, verifies the returned theme's role,
  bytes and store, and keeps a journal that prevents a second push after success or an uncertain
  outcome. Native image probes use the same lane with their own journal scope.
- **Capture** (`case-capture.ts`, `cart-session.ts`, `capture-context.ts`): captures each page twice
  through the storefront with the preview theme, reading the complete store state, shop settings and
  Native image views before and after. Carts are isolated sessions built from owned, published
  fixture variants; cookies and tokens stay in memory. An opt-in context snippet records the Native
  clock and cart in the same response. Receipts hold hashes of the base fixture, case snapshot,
  request and raw responses.
- **Goldens** (`benchmark-theme.ts`, `artifacts.ts`, `case-archive.ts`):
  `preparePinnedBenchmarkTheme` downloads the pinned source to temporary storage;
  `createBenchmarkThemeVerifier` checks the full uploaded inventory; `makeGoldenArtifact` accepts
  only theme-bound case receipts and emits hashes; `savePrivateCaseArchive` keeps calibrated
  snapshots under `.local` with owner-only permissions for the parity loader.
- **Filter corpus** (`corpus*.ts`, `verify-corpus.ts`): the corpus source is bound to the vendored
  spec commit; captured outputs travel as base64 inside the HTML payload and must match across two
  captures. `replayCorpusCapture` and `verify-corpus.ts` replay a capture offline and compare output
  hashes and byte counts. Corpus receipts cannot mint benchmark goldens, and a passing comparison
  does not populate implementation evidence for other features in the same example.
