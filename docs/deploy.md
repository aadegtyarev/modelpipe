# Deploy

modelpipe runs straight from a git clone. `install.sh` clones (or updates) the repo and, on a
fresh install, runs the setup wizard; config lives in the clone and is never touched by updates.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/aadegtyarev/modelpipe/main/install.sh | bash
curl -fsSL .../install.sh | bash -s -- /opt/modelpipe   # choose the install dir
```

The install dir is picked in this order: the positional argument → `$MODELPIPE_HOME` → the
checkout `install.sh` lives in → `~/modelpipe`. A fresh install clones the repo and runs the
wizard, which writes `routes.json` + `.env` into the dir.

## Update

Re-run `install.sh` (or `./install.sh` from inside the clone):

```sh
cd ~/modelpipe && ./install.sh          # git pull --ff-only; wizard is NOT re-run
```

On an existing install it only fast-forwards the clone — your `routes.json` / `.env` are left
untouched. Pass `--reconfigure` to run the wizard again. Live routing state (profile pin/offset,
learned windows, dashboard overrides) lives in `~/.modelpipe` and is likewise untouched.

If a systemd `--user` `modelpipe` service exists, `install.sh` restarts it after the update.

## Run in the background (systemd --user)

Point a unit at the clone's entrypoint + config (see also
[configuration.md](configuration.md)):

```ini
# ~/.config/systemd/user/modelpipe.service
[Unit]
Description=modelpipe — Anthropic-format model router
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/modelpipe/bin/modelpipe.mjs %h/modelpipe/routes.json --env-file %h/modelpipe/.env
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now modelpipe
systemctl --user status modelpipe
```

## Cutting a release (maintainer)

Releases are still tagged so `GET /v1/version` reports a real build and the changelog stays
honest:

```sh
npm version 0.9.0 -m "release %s"   # bumps package.json + creates tag v0.9.0
git push && git push --tags
```

The `v*.*.*` tag triggers `.github/workflows/release.yml`: it runs the full suite, checks the tag
matches `package.json`, `npm pack`s the dependency-free tarball, and publishes it as a **GitHub
Release** asset for anyone who prefers a pinned tarball over tracking `main`.
