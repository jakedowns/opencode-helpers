# opencode-helpers

Shared packages for OpenCode plugins.

**Status:** Phase 0 scaffold. Not published. Do not push, tag, or `npm publish`
until the maintainer confirms.

## Packages

| Package | Purpose |
|---|---|
| `@jakedowns/opencode-nudge-core` | Pure nudge policy, rules, matcher, scheduler, wording pools |
| `@jakedowns/opencode-nudge` | OpenCode host adapter: hooks, shared state, one `nudge` key/tool |

Consumers: `@jakedowns/progress-tool-opencode-plugin`, the voice plugin
(`/media/share/opencode-audio-tool`), and future tools.

## Commands

```bash
npm install
npm test
npm run build
```

No package is published yet. The release workflow will be added with the first
tagged release; see `TODO-nudges.md` in the progress-tool repo.
