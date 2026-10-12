# Antigravity Usage for BB

Adds weekly Antigravity quota windows to BB's Provider Usage panel.

## Requirements

- BB 0.43 or newer.
- An existing, working Antigravity ACP provider (`acp-antigravity`). This project does **not** install or replace an ACP provider.
- A local Antigravity login at `~/.gemini/antigravity-cli/antigravity-oauth-token`.

## Privacy and credentials

The plugin reads the local login token only to make the quota request. It does not log, display, or persist access or refresh tokens. If the access token is expired, it asks the locally installed `agy` CLI to refresh it by listing available models; this does not start an inference turn. As a fallback, an OAuth client secret may be supplied through `ANTIGRAVITY_OAUTH_CLIENT_SECRET`; the plugin contains no embedded OAuth secret.

## Install

```sh
bb plugin install git:https://github.com/defacid/bb-antigravity-usage.git
```
