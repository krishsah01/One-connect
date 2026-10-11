# Releasing the Mac app

A release is a DMG people drag into Applications, plus a signed update bundle the installed app
fetches by itself. `.github/workflows/release.yml` builds both on a macOS runner.

## Cut a release

1. Set the version in `packages/desktop/src-tauri/tauri.conf.json` (and the package manifests) to a
   plain `MAJOR.MINOR.PATCH`, add a CHANGELOG section, and commit.
2. Tag that commit with the same version and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The workflow refuses a tag that does not match the app version. It publishes:
   - `One-Connect-macOS-arm64.dmg`, the installer;
   - `One-Connect-macOS-arm64.app.tar.gz` and its `.sig`, the update bundle;
   - `SHA256SUMS.txt`;
   - `latest.json` on the `updates` release, which installed apps poll every six hours.

To try a build without publishing, run the workflow from the Actions tab on a branch; the files are
kept as a workflow artifact. Running it on a tag with **pre-release** checked publishes a GitHub
pre-release but does not update the feed, so existing installs are not offered preview builds.

Locally, `pnpm desktop:dmg` builds the app and DMG (macOS asks once to let the terminal control
Finder, which lays out the DMG window).

## What the secrets unlock

| Secret | Without it | With it |
|---|---|---|
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | Ad-hoc signed: macOS blocks first launch until the user chooses **Open Anyway** in System Settings → Privacy & Security. | Signed with your Developer ID and hardened runtime. |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` | Not notarized. | The app and DMG are notarized and stapled: it opens with no warning, even offline. |
| `TAURI_SIGNING_PRIVATE_KEY` | No update bundle or feed. | Installed apps offer **Restart to update** for new releases. |
| `APPLE_SIGNING_IDENTITY` | Read from the certificate. | Pins a specific identity if the certificate holds several. |

## Set up the Apple secrets (once)

1. Join the Apple Developer Program as an individual or organization.
2. In Xcode → Settings → Accounts, or at developer.apple.com → Certificates, create a
   **Developer ID Application** certificate. In Keychain Access, export it with its private key as a
   `.p12` file and choose a password.
3. At App Store Connect → Users and Access → Integrations → App Store Connect API, create a key with
   the **Developer** role. Download the `.p8` file (it downloads only once) and note the key ID and
   issuer ID.
4. Add the secrets from your own terminal:

   ```sh
   base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE
   gh secret set APPLE_CERTIFICATE_PASSWORD
   gh secret set APPLE_API_KEY --body "<key ID>"
   gh secret set APPLE_API_ISSUER --body "<issuer ID>"
   gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
   ```

## The updater key

The app ships the public key (`plugins.updater.pubkey` in `tauri.conf.json`) and accepts only update
bundles signed by the matching private key. The private key was generated at
`~/.tauri/one-connect-updater.key` on the maintainer's Mac, without a password. Upload it once:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/one-connect-updater.key
```

Back it up somewhere safe (a password manager). **If it is lost, installed apps can never be updated
again**; users would have to download the next version by hand. To rotate it, ship one release signed
with the old key whose config carries the new public key.

## Notes

- Apple silicon only. An Intel or universal build needs `--target universal-apple-darwin` and both
  Rust targets installed.
- The bundle identifier `dev.agentcontrolcenter.desktop` is bound into notarization, the update feed
  and the app-data folder. Change it before the first signed release or keep it for good.
- The engine's only native binary is the bundled Node runtime, already signed by the Node.js project.
