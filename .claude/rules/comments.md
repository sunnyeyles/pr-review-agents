# Comments

**Hard cap: 2 lines. One is better. None is best.**

This is enforced. `.claude/hooks/comment-length.sh` runs after every edit and
rejects any comment block over 2 lines that you added. Shorten it or delete it.

Say the one non-obvious fact in plain words. Nothing else.

Never write:

- essays, or any block that reads like prose
- why you did *not* do something, or what the code used to do
- a restatement of the code, the type signature, or the API contract
- ticket references (PROD-XXXX, #123)
- API usage that belongs at the API's own definition

Fix a stale comment by rewriting it. Never add a second comment beside it.

## Bad

```ts
/**
 * Names too common to identify anything, so searching one returns only
 * noise. A heuristic snapshot of the usual conventions, not a rule — the
 * `totalCount` in every result is what actually shows the model how noisy
 * its query was. Split by position: `packages.ts` is a real file name, and
 * `main/` a real directory, so neither list may judge the other's slot.
 */
```

## Good

```ts
// Split by position: a file-name list must not judge a directory slot.
```

## Escape hatch

`COMMENT_LINT_SKIP=1` turns the hook off. It is for the rare false positive
(comment-like text inside a template literal), not for writing longer comments.
