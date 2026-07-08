# Deploy

modelpipe ships as a **release artifact**, not a git checkout — so the deploy host is never
confused with a dev clone, and config is never clobbered by an update.

## Cutting a release (maintainer, dev repo)

```sh
npm version 0.9.0 -m "release %s"   # bumps package.json + creates tag v0.9.0
git push && git push --tags
```

The `v*.*.*` tag triggers `.github/workflows/release.yml`: it runs the full suite, checks the
tag matches `package.json`, `npm pack`s the dependency-free tarball (exactly the files in
`package.json` → `files`), and publishes it as a **GitHub Release** asset.

## Installing / upgrading (deploy host)

```sh
scripts/deploy.sh            # install the latest release
scripts/deploy.sh v0.9.0     # or a specific version
```

Requires `node` and an authenticated `gh`. Layout under `$MODELPIPE_HOME`
(default `~/appimages/modelpipe-deploy`):

```
releases/<tag>/   unpacked artifact (immutable per version)
current           symlink → active release (atomic flip on upgrade)
config/           routes.json + .env  ← PRESERVED across upgrades
```

Live routing state (profile pin/offset, learned windows, dashboard overrides) lives in
`~/.modelpipe` and is likewise untouched by upgrades.

The script is idempotent: it downloads+unpacks a version once, seeds `config/` from an older
git-clone deploy on first run (never overwriting), flips the `current` symlink, writes the
systemd `--user` unit (pointing at `current` + external `config/`), and restarts. Rollback is
just `scripts/deploy.sh <older-tag>`.

> **Don't run the router from a git clone in production.** A clone invites accidental commits
> and drifts from `main`. Develop in the dev repo, release by tag, install the artifact here.
