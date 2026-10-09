# clubdeck-avatar

Change a Clubhouse profile photo using your existing Clubdeck login. The CLI prepares a 512 × 512 avatar and a full-size JPEG, uploads both, then checks the server profile and photo history.

Requires **Node.js 20.12+**, **FFmpeg**, and an existing Clubhouse login. There are no npm dependencies. Clubdeck does not need to be running; the script uses its saved authorization and calls the API directly.

## Setup

```sh
git clone https://github.com/yolojewjitsu/clubdeck-avatar.git
cd clubdeck-avatar
cp .env.example .env
```

Edit `.env`. On macOS, the default profile location in the example is normally appropriate. On another computer, set `CLUBDECK_PROFILE_PATH` to that computer's profile file. If FFmpeg is not on `PATH`, set `CLUBDECK_FFMPEG_BIN` to its executable path.

Paths with spaces should be quoted. A leading `~/` is expanded by the script. Node's env-file loader does **not** expand `$HOME` or references to other variables.

Check authorization without changing the avatar:

```sh
node --env-file=.env avatar.mjs status
```

## Change the avatar

```sh
node --env-file=.env avatar.mjs upload "/path/to/photo.jpg"
```

Or set `CLUBDECK_IMAGE_PATH` in your environment and omit the image argument:

```sh
node --env-file=.env avatar.mjs upload
```

The default `contain` composition preserves the entire image on a blurred square background. Use `CLUBDECK_CROP_MODE=cover` for a central square crop. Both modes produce a JPEG thumbnail; FFmpeg also normalizes the full image to JPEG and leaves the source file unchanged.

To inspect the composition before uploading:

```sh
node --env-file=.env avatar.mjs prepare "/path/to/photo.jpg"
```

This command is entirely local. Open `avatar.jpg` in the printed `runDir`. The `upload` command performs the same preparation in its own run directory.

## Verify and recover

Each upload creates a private run directory containing `avatar.jpg`, `full.jpg`, and `receipt.json`. Verification also saves `server-avatar.jpg` when the CDN download is available. Tokens are never saved in these files or printed.

```sh
# Check the latest attempted upload; this never uploads an image.
node --env-file=.env avatar.mjs verify

# Check a specific run.
node --env-file=.env avatar.mjs verify "/path/to/run-directory"
```

An accepted upload may take a few seconds to appear in the profile. The script polls reads after submitting **one** upload request. If verification is still pending, run `verify` again instead of re-uploading.

If an upload response is lost, its receipt is marked `uncertain` and further uploads are blocked. `verify` can recover the result when the server image exactly matches the submitted JPEG and photo history has grown. Otherwise, inspect `server-avatar.jpg` and the account manually: a re-encoded image cannot be proven identical by this fallback. After resolving the outcome, you can remove `latest.json` in `CLUBDECK_OUTPUT_DIR` to allow another upload; keep the run directory as a record.

Concurrent uploads are blocked with `upload.lock`. If the process was killed, first ensure no uploader is running, run `verify`, and then remove the stale lock file.

Exit codes: `0` for successful commands/verified uploads; `1` for errors; `2` for verification pending or inconclusive.

## Environment variables

| Variable | Default / purpose |
| --- | --- |
| `CLUBDECK_PROFILE_PATH` | Saved Clubdeck `profile.json`; required unless all three credential variables below are set |
| `CLUBDECK_IMAGE_PATH` | Optional image path; a CLI image argument takes precedence |
| `CLUBDECK_OUTPUT_DIR` | `~/.local/state/clubdeck-avatar`; receipts and prepared images |
| `CLUBDECK_FFMPEG_BIN` | `ffmpeg`; command on `PATH` or an executable path |
| `CLUBDECK_CROP_MODE` | `contain` or `cover` |
| `CLUBHOUSE_APP_VERSION` | `26.09.16` |
| `CLUBHOUSE_APP_BUILD` | `1038456` |
| `CLUBHOUSE_DEVICE_MANUFACTURER` | `Google` |
| `CLUBHOUSE_DEVICE_MODEL` | `Pixel 9` |
| `CLUBHOUSE_COUNTRY` | `US` |
| `CLUBDECK_REQUEST_TIMEOUT_MS` | `35000`; total deadline per HTTP request |
| `CLUBDECK_VERIFY_ATTEMPTS` | `6`; maximum profile/history checks per verification |
| `CLUBDECK_VERIFY_DELAY_MS` | `3000`; delay between checks |
| `CLUBHOUSE_TOKEN` | Optional authorization token instead of reading a profile file |
| `CLUBHOUSE_USER_ID` | Required together with the token and device ID |
| `CLUBHOUSE_DEVICE_ID` | Required together with the token and user ID |

Exported environment variables take precedence over values loaded by `node --env-file=.env`. `.env` is ignored by Git. The repository includes only `.env.example`; keep credentials and generated account data out of commits.

## Protocol

The script uses the workflow verified on 2026-10-10:

1. Call `POST /api/me` with Android client headers and a fresh `CH-Session-Id`.
2. Require `ENABLE_PROFILE_PHOTO_HISTORY` and read the existing profile/history.
3. In the same session, call `POST /api/update_photo` using multipart parts `file` (`avatar.jpg`) and `full_file` (`full.jpg`). Each part has its own MIME type and content length.
4. Check `get_profile` and `get_user_photo_history`. Compare image identities across thumbnail URL variants; history keys can have different timestamp precision.

This is an unofficial client for an undocumented API. The default client version/build are known working values, not automatically updated versions. Server changes may require updating them or the protocol code. The CLI does not patch, open, or restart Clubdeck.

## Development

```sh
npm run check
npm test
```

Tests use synthetic images/data and mocked requests. They never modify a real account. Live `status` and `verify` are available for read-only validation.

## License

[MIT](LICENSE).
