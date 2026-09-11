# Superseded patches

Two unapplied patches that were sitting in the repository root, moved here on
2026-09-11 rather than deleted, because the reasoning in the first one is still
worth reading.

## `0001-prototype-anatomy.patch`

*Bring the five screens to the prototype's anatomy and density.* Produced against
`design-prototypes/APPLYING-TO-PRODUCT.md`. Touches
`packages/ui/src/components/{primitives,screens}.css.ts`,
`apps/app/src/{overview,beneficiaries}/surfaces.tsx`, a story and an accessibility
test — 182 insertions, 25 deletions.

**Superseded.** The 2026-09-11 decision retires the React screens and
`packages/ui` in favour of the v6 static workspace, so this patch restyles files
that are on their way out. It does not apply cleanly to anything that will exist.

**Still worth reading before the v6 content pass.** Its commit message records
which prototype traits could be expressed on the frozen scales and which could not
— table padding against the 12/16/20 space scale, a hairline instead of a 16px
radius and layered shadows — with the § reference for each. That mapping is the
same work the v6 workspace now has to go through, and it was done carefully.

The root also held a byte-identical second export of this same commit
(`0001-Bring-the-five-screens-...patch`); the duplicate was deleted.

## `0002-Add-the-design-UI-handoff-note-ignore-Cowork-s-output.patch`

Two unrelated hunks.

- The `.gitignore` hunk — ignoring `Claude outputs/` — **was applied directly** on
  2026-09-11. That directory mirrors files already tracked elsewhere.
- The `HANDOFF_DESIGN_UI.md` hunk adds a note that already exists untracked in the
  working tree, and which v6 has since overtaken. `V6_FRONTEND_REVIEW.md` in the
  repository root is the current state of play.

Nothing here needs applying. Delete the folder once the v6 content pass is done.
