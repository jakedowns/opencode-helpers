# Publishing the shared nudge packages

Current package names:

| Package | Directory | Tag |
|---|---|---|
| `@jakedowns/opencode-nudge-core` | `packages/nudge-core` | `nudge-core@0.1.0` |
| `@jakedowns/opencode-nudge` | `packages/nudge-opencode` | `nudge-opencode@0.1.0` |

The release workflow is `.github/workflows/release.yml`. It uses npm trusted
publishing (OIDC), so no `NPM_TOKEN` secret is needed.

## 1. Manual setup (one-time)

### GitHub

- Create `github.com/jakedowns/opencode-helpers`.
- Push this repository and its tags.
- The workflow's `if:` checks `github.repository == 'jakedowns/opencode-helpers'`;
  change it if the repo name differs.

### npm

The `@jakedowns` scope already exists (the plugin is published under it).

For **each** package:

1. Open the package on npmjs.com.
2. Settings → Trusted publishing → GitHub Actions.
3. Set:
   - Organization/user: `jakedowns`
   - Repository: `opencode-helpers`
   - Workflow filename: `release.yml`
   - Environment: blank
4. Confirm 2FA is enabled on the npm account.

If npm does not offer trusted publishing until the package exists, do a
one-time local publish first:

```bash
cd packages/nudge-core
npm publish --access public
cd ../nudge-opencode
npm publish --access public
```

Then add the trusted publisher to both packages. Future releases should use the
tag workflow.

## 2. Publish

Core first, adapter second:

```bash
git tag -a nudge-core@0.1.0 -m "nudge-core 0.1.0" && git push origin nudge-core@0.1.0
# wait for the workflow, then:
git tag -a nudge-opencode@0.1.0 -m "nudge-opencode 0.1.0" && git push origin nudge-opencode@0.1.0
```

Verify:

```bash
npm view @jakedowns/opencode-nudge-core@0.1.0 version
npm view @jakedowns/opencode-nudge@0.1.0 version
```

## 3. Then the progress plugin

Only after both packages are live:

1. Change `plugin/package.json` dependency from the staged `0.1.0` to the
   published version.
2. Run a clean install and the plugin tests.
3. Publish progress `2.28.0` with `nudgeEngine: "legacy"` default.
4. Dogfood `"shadow"`, then `"shared"`.

Do not tag a progress release while the dependency is unpublished.
