# Recipes App

A PWA for managing recipes, with cross-device sync via a shared Dropbox account.

## Architecture

- **Frontend**: Single-file PWA (`recipes.html`) — React + Babel inline, same shape as the invoices app. Installed to phone home screen.
- **Backend**: One Vercel serverless function (`api/recipes.js`) that reads/writes a JSON store in a single Dropbox account, plus a `?extract=1` endpoint that turns a recipe URL into structured data.
- **Storage**: Dropbox "App folder" — scoped permissions, app can only see `Apps/Recipes/`. One JSON file per recipe (`recipe-<id>.json`) to avoid concurrent-write conflicts.
- **Auth**: Single shared Dropbox account; OAuth done once by Bea, refresh token stored as `DROPBOX_REFRESH_TOKEN` Vercel env var. End users see no Dropbox login.
- **Access gate**: Shared passcode env var (`APP_PASSCODE`) the PWA prompts for once on first launch and includes as a header on every API call. Without it, the Vercel URL would be world-readable.
- **Extraction**: JSON-LD `Recipe` schema first (works on most recipe sites — fast, free, accurate). Falls back to Claude (Anthropic API) when a page has no structured data, with a tight prompt that pulls only ingredients (with measurements) and steps.
- **Offline**: Service worker caches the shell + recipe API responses (network-first), and the client also keeps a `localStorage` mirror of the recipe list for instant load.

## Repo layout

```
recipes.html       – PWA entry, single file (UI is a placeholder; will reskin once Bea's design is in)
api/recipes.js     – Vercel serverless function: passcode gate, Dropbox CRUD, URL extractor
sw.js              – service worker
manifest.json      – PWA manifest
vercel.json        – routes + headers
package.json       – dependencies (dropbox SDK)
```

## Conventions inherited from the invoices app

- Date-based version chip in the UI (`v2026.05.02.1`) bumped on every release alongside `CACHE_NAME` in `sw.js`.
- Locked pinch-zoom + side rubber-band (viewport meta + `touch-action: pan-y` + `overscroll-behavior: none`).
- Network-first service worker.

## Recipe schema (one JSON file per recipe)

```json
{
  "id": "string",
  "title": "string",
  "description": "string",
  "ingredients": ["2 tbsp olive oil", "..."],
  "instructions": ["Heat oil in a large pan…", "..."],
  "prepTime":  "15m",
  "cookTime":  "30m",
  "totalTime": "45m",
  "servings":  "4 servings",
  "image":     "https://… (source URL, not downloaded)",
  "author":    "string",
  "sourceUrl": "string",
  "tags":      ["weeknight", "vegetarian"],
  "notes":     "Halve the salt next time…",
  "rating":    0,
  "extractedBy": "json-ld | json-ld-partial | claude | manual",
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

## Setup checklist

This is a one-time setup. Order matters: Dropbox first (gives credentials), then Vercel deployment with those credentials wired in.

### 1. Register the Dropbox app

1. Go to <https://www.dropbox.com/developers/apps> → **Create app**.
2. Choose **Scoped access** → **App folder** (NOT Full Dropbox — App folder mode sandboxes us to `Apps/Recipes/`).
3. Name the app e.g. `Recipes` (must be globally unique; if taken, append your initials).
4. On the app's settings page:
   - **Permissions tab**: enable `files.content.write` and `files.content.read`. Click **Submit**.
   - **Settings tab**: copy the **App key** (= `DROPBOX_APP_KEY`) and **App secret** (= `DROPBOX_APP_SECRET`).

### 2. Generate a long-lived refresh token

The refresh token lets the serverless function renew its own access tokens forever without you logging in again.

1. In a browser, visit (replace `<APP_KEY>`):

   ```
   https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline
   ```

2. Authorize. Copy the resulting authorization code.

3. Exchange the code for a refresh token (replace all three placeholders):

   ```bash
   curl -X POST https://api.dropbox.com/oauth2/token \
     -d code=<CODE> \
     -d grant_type=authorization_code \
     -d client_id=<APP_KEY> \
     -d client_secret=<APP_SECRET>
   ```

4. The JSON response contains `refresh_token` — that's `DROPBOX_REFRESH_TOKEN`. Save it.

### 3. Create the Vercel project

1. Push this folder to a GitHub repo (e.g. `recipes-app`).
2. <https://vercel.com/new> → import the repo. Framework preset: "Other". Root directory: project root. Build command: leave empty.
3. Before clicking **Deploy**, add environment variables:

   | Name                     | Value                                              |
   | ------------------------ | -------------------------------------------------- |
   | `APP_PASSCODE`           | a passcode you choose (any string)                 |
   | `DROPBOX_APP_KEY`        | from step 1                                        |
   | `DROPBOX_APP_SECRET`     | from step 1                                        |
   | `DROPBOX_REFRESH_TOKEN`  | from step 2                                        |
   | `ANTHROPIC_API_KEY`      | from <https://console.anthropic.com> (optional)    |
   | `CLAUDE_MODEL`           | optional override; default `claude-haiku-4-5-20251001` |

4. Deploy. Once live, open the URL on your iPhone/iPad and add to Home Screen.

### 4. Try it

- First launch will prompt for the passcode.
- Tap **Add recipe** → paste a URL from any recipe site → review → save.
- The recipe lands in your Dropbox at `Apps/Recipes/recipe-<id>.json` and shows up on every other device that's unlocked the app.

## Local development

```bash
npm install
npx vercel dev   # runs the serverless function locally; passcode + Dropbox creds via .env.local
```

`.env.local` (gitignored) example:

```
APP_PASSCODE=changeme
DROPBOX_APP_KEY=…
DROPBOX_APP_SECRET=…
DROPBOX_REFRESH_TOKEN=…
ANTHROPIC_API_KEY=…
```

## Releases

When pushing a new version:
1. Bump `APP_VERSION` in `recipes.html`.
2. Bump `CACHE_NAME` in `sw.js` to match (so installed PWAs pick up the new shell).
3. Push to `main` — Vercel auto-deploys.
