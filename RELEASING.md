# Releasing Veil

Two separate things live in this document, and they solve different problems:

- **The release feed** answers "is there a newer Veil?" — it is what makes the
  update button in Settings do something.
- **Code signing** answers "is this Veil, from you?" — it is what stops Windows
  calling your installer unknown, and what stops a compromised GitHub release
  from being installed over the top of a working browser.

You can do the first without the second. Do not assume the first implies it.

---

## 1. Wiring the update feed

### One-time setup

```bash
npm run set-owner -- YOUR-GITHUB-USERNAME
```

That writes `build.publish[0].owner` in `package.json`. electron-builder bakes
it into `resources/app-update.yml` inside the packaged app, and that file is
the only thing the running browser consults. Check it after a build:

```bash
cat dist/win-unpacked/resources/app-update.yml
```

Then create the repository and push:

```bash
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/veil-browser.git
git branch -M main
git push -u origin main
```

**The repository has to be public.** electron-updater fetches
`latest.yml` and the installer as an anonymous HTTP client. A private repo
would need a GitHub token compiled into the app, and a token shipped to every
user is not a secret — it is a credential you have published, with write access
to your account. Public repo, or no automatic updates.

### Cutting a release

```bash
npm version 1.0.1
git push --follow-tags
```

The tag push triggers `.github/workflows/release.yml`, which builds on a
GitHub-hosted Windows runner and uploads to a **draft** release. Nothing
reaches anybody until you open Releases and press Publish — electron-updater
ignores drafts, so a half-built version cannot escape.

If you ever see **two drafts sharing one tag**, the assets have been split
between them and only the one holding `latest.yml` is usable. Move the stray
asset into that draft and delete the other. The workflow creates the release
before building specifically to stop this, but a hand-run build without that
step can still do it.

To build on your own machine instead (needed once you sign locally — see
below), set a GitHub token with `repo` scope in the environment and run:

```bash
npm run release
```

Do not paste a token into a file in this repo. Put it in your own environment.

### What the installed browser then does

`src/main/updater.js` checks the feed on demand. It never downloads and never
installs without being asked; `autoDownload` and `autoInstallOnAppQuit` are
both off, deliberately. If the feed is unreachable it says so instead of
pretending to be current.

`version` in `package.json` is the whole comparison. A release tagged `v1.0.1`
built from a `package.json` that still says `1.0.0` will be published and then
ignored by every installed copy.

---

## 1b. macOS (Apple Silicon)

A `.dmg` cannot be built on Windows, so the `macos` job in the workflow does
it on a GitHub-hosted Apple Silicon runner. It waits for the Windows job so
that only one of the two creates the draft release.

It produces `Veil-1.0.0-arm64.dmg`, `Veil-1.0.0-arm64-mac.zip` and
`latest-mac.yml`. The zip is not a convenience copy - electron-updater reads
it, not the dmg.

### Gatekeeper, and why the Mac build is harsher than the Windows one

There is no Developer ID certificate, so `CSC_IDENTITY_AUTO_DISCOVERY=false`
tells electron-builder to stop looking for one and ship the app unsigned.

On Apple Silicon that is a real obstacle, not a warning to click through.
macOS quarantines anything downloaded from a browser, and an unsigned
quarantined app is refused with **"Veil is damaged and can't be opened"** -
which is a lie, but an unhelpfully convincing one. There is no "open anyway"
button in that dialog.

The fix, once, after dragging Veil to Applications:

```bash
xattr -dr com.apple.quarantine /Applications/Veil.app
```

Right-click → Open works on some macOS versions and not others; the command
above always works. Put it in the release notes, because a Mac user who hits
"damaged" without warning will reasonably assume the download is corrupt.

**Auto-updates do not work unsigned on macOS.** electron-updater validates the
signature before swapping the app in, and there is nothing to validate. Mac
users can be told about a new version but must install it by hand. This is not
true of the Windows build, where the check is skipped when unsigned. Fixing it
means the Apple Developer Program, $99/year - a separate purchase from any
Windows certificate.

### Building on a Mac directly

```bash
npm run dist:mac      # local build, no upload
npm run release:mac   # build and upload to the draft release
```

---

## 1c. Linux (Ubuntu and anything close to it)

The `linux` job builds on an Ubuntu runner and produces two things:

- `Veil-1.0.7.AppImage` — runs from anywhere, installs nothing
- `veil-browser_1.0.7_amd64.deb` — `sudo apt install ./veil-browser_1.0.7_amd64.deb`

**Prefer the .deb.** Electron's sandbox needs a helper binary owned by root
with the setuid bit set. Installing the .deb does that; an AppImage cannot,
because it is never installed. On Ubuntu 24.04 and later, where unprivileged
user namespaces are restricted by AppArmor, that difference decides whether the
app starts at all. If the AppImage refuses to start with a message about the
SUID sandbox helper, this is why, and:

```bash
./Veil-1.0.7.AppImage --no-sandbox
```

will start it — at the cost of the renderer sandbox, which is not a trade worth
making permanently in a browser. The .deb is the answer.

There is no code signing on Linux and nothing expects any, so unlike macOS
this build has no Gatekeeper problem to work around. Auto-updates are not
wired up for Linux: electron-updater supports AppImage updates, but Veil's
updater has only ever been pointed at the Windows and macOS feeds, so Linux
users are told about a new version and install it by hand.

```bash
npm run dist:linux     # local build on a Linux machine, no upload
npm run release:linux  # build and upload to the draft release
```

---

## 2. Signing

### What it actually buys you

1. **The installer stops saying "Unknown publisher".** SmartScreen's blue
   "Windows protected your PC" page is the current cost of handing someone an
   unsigned `.exe`; they have to click "More info" → "Run anyway", which is
   exactly the habit you do not want to teach a privacy-minded friend.
2. **Updates get verified.** This is the part that matters more. When a build
   is signed, electron-builder writes `publisherName` into `app-update.yml`,
   and `NsisUpdater.verifySignature()` then checks every downloaded installer
   against that name before running it. Right now that check is skipped —
   `publisherName` is absent, and the code returns `null` and installs anyway
   (`node_modules/electron-updater/out/NsisUpdater.js`). So today the security
   of an update rests entirely on GitHub's TLS and your account not being
   compromised. Signing adds a second lock that an attacker with your GitHub
   password still cannot pick.

Note the order: signing is worth more *because* you wired up updates. An app
that never updates has a smaller attack surface here.

### The awkward part

Since June 2023 you cannot simply buy a `.pfx` file and sign with it. Every
publicly trusted code-signing key must live on FIPS-certified hardware — a USB
token, or a cloud HSM. That rules out the old workflow of committing an
encrypted certificate and signing in CI.

Three realistic routes, cheapest first:

| Route | Rough cost | Works in GitHub Actions | Notes |
| --- | --- | --- | --- |
| **Azure Trusted Signing** | ~$10/month | Yes | Microsoft's own service. Individual identity validation is available. Certificates are short-lived and issued per-signing over an API, so there is no key for you to lose. |
| **OV certificate on a USB token** (Certum's open-source offering is the cheap end; Sectigo/DigiCert the expensive end) | ~€100–400/year | No — the token must be physically present | You sign on your own machine, with the token plugged in and a PIN typed by you. |
| **EV certificate** | ~$400+/year | Only with a cloud HSM variant | Historically the fastest route to a clean SmartScreen prompt. |

There is also **SignPath Foundation**, which issues free certificates to open
source projects. It is worth applying to now that this repo is public and
builds in GitHub Actions, but it is not something you can switch on today: an
application has to be reviewed and accepted, and signing then has to happen
inside CI on their terms. Treat it as a thing to set up over weeks, not the
answer to "I want to hand this over tonight".

Prices move; check before committing. Self-signed certificates are not on this
list on purpose: Windows treats them exactly like no signature at all unless
the recipient installs your root certificate first, which is a worse thing to
ask of someone than clicking "Run anyway".

### Azure Trusted Signing

Once the Azure resources exist (a Trusted Signing account, a certificate
profile, and an app registration with the *Trusted Signing Certificate Profile
Signer* role), add this to `build.win` in `package.json`:

```json
"azureSignOptions": {
  "publisherName": "Your Name",
  "endpoint": "https://eus.codesigning.azure.net",
  "codeSigningAccountName": "your-account",
  "certificateProfileName": "your-profile"
}
```

`publisherName` must match the certificate subject exactly — this is the
string the updater will later compare against, so a typo here means every
future update fails verification rather than failing loudly now.

Authentication comes from the environment, never from the repo:

```
AZURE_TENANT_ID
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
```

In GitHub Actions those go in repository secrets and get added to the `env:`
block of the `npm run release` step. Then the workflow signs as it builds.

### A certificate on a USB token

No `package.json` change. Plug the token in and build locally:

```bash
npm run release
```

electron-builder finds the certificate through Windows' own store. If you have
more than one, name it:

```json
"signtoolOptions": { "certificateSubjectName": "Your Name" }
```

You will be prompted for the token PIN, possibly several times — the build
signs `Veil.exe`, `elevate.exe`, the uninstaller, the NSIS installer and the
portable build separately. Some tokens can cache the PIN for a session; that
is a setting in the token's own software, not something to script around.

CI cannot do this. If you go this route, releases get built on your machine and
`.github/workflows/release.yml` becomes a convenience for unsigned test builds
only — or you delete it.

### Verifying it worked

```powershell
Get-AuthenticodeSignature "dist\Veil Setup 1.0.0.exe" | Format-List Status, SignerCertificate
```

`Status : Valid` is what you want. Note that electron-builder prints
`signing with signtool.exe` during every build, signed or not — it is
announcing the step, not the result. The command above is the truth.

Then check that the publisher name made it into the feed file, because this is
what future updates are checked against:

```bash
grep publisherName dist/win-unpacked/resources/app-update.yml
```

### Until it is signed

Handing over an unsigned build is not unreasonable; it is just something to say
out loud rather than let the recipient discover. Three things make it honest:

1. **Publish a checksum in the release notes** and have them check it before
   running anything:

   ```powershell
   Get-FileHash "$HOME\Downloads\Veil Setup 1.0.0.exe" -Algorithm SHA256
   ```

   This does not prove you built it — anyone can publish a hash for anything —
   but it does prove the download was not corrupted or swapped in transit.

2. **Warn them about SmartScreen.** "Windows protected your PC" → More info →
   Run anyway. Someone who cares about privacy should be suspicious of that
   screen, so tell them it is coming rather than let them decide alone.

3. **Say what the update path rests on.** Until there is a signature, an
   update is trusted because it came from your GitHub account over TLS. That
   is a real guarantee, and a narrower one than a signed build gives.
