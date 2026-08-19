# 14 — Make the release pipeline trustworthy

**What to build:** Confidence that the one path by which this action reaches users actually works. The action ships as a single pre-built bundle published into a separate public action repository by `.github/workflows/release-action.yml`, and that path has never run end to end. Three things make it untrustworthy. First, `.github/workflows/ci.yml` never builds the bundle, so a bundling regression — a dependency that will not tree-shake, an import that breaks under the action's Node runtime — would surface for the first time at release, in front of users; CI must build the bundle on every run and smoke-test the artefact, proving it imports cleanly under the target Node version and stays inert when the GitHub Actions environment marker is absent, which is exactly the contract the entrypoint guard promises. Second, the release workflow is a live footgun: it reads the destination repository from a repository variable and the push credential from a secret, both currently unset, and with an empty repository input the checkout step silently falls back to THIS repository and the default workflow token, so an accidental version tag would stage the release payload over the source tree and force-push tags onto it. The workflow must fail fast, before the checkout step runs, with a message naming which piece of configuration is missing. Third, the staging step copies a LICENSE with a failure-tolerating fallback while both READMEs promise downstream consumers a licence, and no LICENSE file exists — add a real one at the repository root and let the copy fail loudly if it ever goes missing again. Finally, prove the path rather than assume it: exercise the release through a dry run or equivalent against a throwaway destination so the first real tag is not the first execution.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] CI builds the action bundle on every run, so a bundling regression fails the pull request rather than the release
- [ ] A smoke check runs the built bundle under the action's target Node version, proving it imports cleanly and performs no work when the GitHub Actions environment marker is absent
- [ ] The release workflow aborts before the checkout step, with a message identifying the missing piece, when either the destination repository variable or the push token secret is empty
- [ ] The release workflow can no longer fall back to the source repository or the default workflow token for the publish checkout
- [ ] A LICENSE file exists at the repository root, matching the licence both READMEs promise consumers
- [ ] The release copies that LICENSE into the published payload without a failure-tolerating fallback, so a missing licence fails the release
- [ ] The release path is exercised in a dry run or equivalent against a disposable destination, and the result is recorded, so the first real tag is not its first execution
