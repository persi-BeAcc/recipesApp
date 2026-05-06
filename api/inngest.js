// api/inngest.js
//
// Inngest webhook + worker function. Inngest invokes this endpoint when a
// `recipes/video.extract` event is sent (from api/extract-video.js).
//
// The worker has effectively unlimited time — Inngest handles execution
// outside Vercel's request timeout. Each `step.run()` is independently
// retryable, which means a transient Whisper hiccup won't lose progress
// from RapidAPI or Claude.

import { Inngest } from 'inngest';
import { serve } from 'inngest/next';
import { ops } from '../lib/storage.js';
import {
  extractFromVideoUrl,
  extractFramesWithClaude,
  resolveSocialVideo,
  detectPlatform,
} from '../lib/video-pipeline.js';
import {
  extractFromText,
} from '../lib/recipe-extract.js';

if (!process.env.INNGEST_EVENT_KEY) {
  throw new Error('INNGEST_EVENT_KEY env var is required');
}
if (!process.env.INNGEST_SIGNING_KEY) {
  throw new Error('INNGEST_SIGNING_KEY env var is required (rejects unsigned events)');
}

const inngest = new Inngest({
  id: 'recipes-app',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

// ---------------------------------------------------------------------------
// Worker function
// ---------------------------------------------------------------------------

const extractVideoFn = inngest.createFunction(
  { id: 'extract-video', name: 'Extract recipe from video URL' },
  { event: 'recipes/video.extract' },
  async ({ event, step }) => {
    const { jobId, url, analysis, frames, dbxToken, storageProvider } = event.data;
    if (!jobId) throw new Error('jobId missing from event');
    if (!dbxToken) throw new Error('dbxToken missing from event');

    // Resolve the correct storage backend from the event payload.
    // Falls back to 'dropbox' for events sent before this change was deployed.
    const provider = storageProvider || 'dropbox';
    const { readJson, writeJson, upload } = ops(provider);

    await step.run('mark-processing', async () => {
      await updateJob(readJson, writeJson, dbxToken, jobId, { status: 'processing', progress: 'Starting' });
    });

    try {
      const platform = detectPlatform(url);
      const reel = (platform === 'instagram' || platform === 'tiktok')
        ? await step.run('resolve', async () => {
            await updateJob(readJson, writeJson, dbxToken, jobId, { progress: `Resolving ${platform} video` }).catch(() => {});
            return resolveSocialVideo(url, platform);
          })
        : null;

      const recipe = await step.run('extract-and-archive', async () => {
        let result;
        if (analysis === 'audio_frames' && Array.isArray(frames) && frames.length) {
          const [baseResult, frameNotes] = await Promise.all([
            extractFromVideoUrl({
              url, analysis: 'audio', prefetchedReel: reel,
              onProgress: (msg) => updateJob(readJson, writeJson, dbxToken, jobId, { progress: msg }).catch(() => {}),
            }),
            extractFramesWithClaude(frames),
          ]);
          if (frameNotes) {
            const merged = await extractFromText({
              transcript:  (baseResult.recipe.instructions || []).join('\n'),
              caption:     baseResult.recipe.description || '',
              frameNotes,
              sourceUrl:   url,
            });
            result = {
              recipe: {
                ...baseResult.recipe,
                ingredients:  merged.ingredients.length  ? merged.ingredients  : baseResult.recipe.ingredients,
                instructions: merged.instructions.length ? merged.instructions : baseResult.recipe.instructions,
                extractedBy:  baseResult.recipe.extractedBy + '+frames',
              },
              mp4Buffer: baseResult.mp4Buffer,
            };
          } else {
            result = baseResult;
          }
        } else {
          result = await extractFromVideoUrl({
            url, analysis, prefetchedReel: reel,
            onProgress: (msg) => updateJob(readJson, writeJson, dbxToken, jobId, { progress: msg }).catch(() => {}),
          });
        }

        // Archive mp4 if we got one. Cap at 200MB.
        let videoPath = null;
        const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
        if (result.mp4Buffer && result.mp4Buffer.length > 0) {
          if (result.mp4Buffer.length > MAX_ARCHIVE_BYTES) {
            console.log(`[archive] mp4 ${(result.mp4Buffer.length / 1024 / 1024).toFixed(1)}MB exceeds 200MB cap, skipping archive`);
          } else {
            await updateJob(readJson, writeJson, dbxToken, jobId, { progress: 'Archiving video' }).catch(() => {});
            videoPath = `/videos/${jobId}.mp4`;
            try {
              await upload(dbxToken, videoPath, result.mp4Buffer);
              console.log(`[archive] uploaded ${result.mp4Buffer.length} bytes to ${videoPath}`);
            } catch (err) {
              console.warn('[archive] upload failed:', err.message);
              videoPath = null;
            }
          }
        }

        // Archive thumbnail — social CDN links expire fast. We download once,
        // upload to /thumbnails/, and store the path; the frontend mints a
        // fresh temporary link via /api/video-link?kind=thumb on demand.
        let imageUrl = result.recipe.image;
        let thumbPath = null;
        if (reel && reel.thumbnail) {
          try {
            const r = await fetch(reel.thumbnail, { redirect: 'follow' });
            if (r.ok) {
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length > 0 && buf.length < 5_000_000) {
                const ct = r.headers.get('content-type') || 'image/jpeg';
                const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
                thumbPath = `/thumbnails/${jobId}.${ext}`;
                await upload(dbxToken, thumbPath, buf);
                imageUrl = '';
                console.log(`[archive] thumbnail at ${thumbPath}`);
              }
            }
          } catch (err) {
            console.warn('[archive] thumbnail failed:', err.message);
            thumbPath = null;
          }
        }

        return { ...result.recipe, videoPath, thumbPath, image: imageUrl };
      });

      const recipeId = await step.run('save-recipe', async () => {
        const id = newRecipeId();
        const now = new Date().toISOString();
        const finalRecipe = {
          ...recipe,
          id,
          tags: [],
          notes: '',
          rating: 0,
          createdAt: now,
          updatedAt: now,
        };
        await writeJson(dbxToken, `/recipe-${id}.json`, finalRecipe);
        return id;
      });

      await step.run('mark-done', async () => {
        await updateJob(readJson, writeJson, dbxToken, jobId, {
          status: 'done',
          progress: 'Recipe saved',
          recipeId,
        });
      });

      return { recipeId };
    } catch (err) {
      console.error('[inngest worker] failed:', err);
      await updateJob(readJson, writeJson, dbxToken, jobId, {
        status: 'error',
        error: String(err && err.message ? err.message : err).slice(0, 500),
      }).catch(() => {});
      throw err;
    }
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateJob(readJson, writeJson, token, jobId, patch) {
  let job;
  try {
    job = await readJson(token, `/jobs/job-${jobId}.json`);
  } catch {
    job = { id: jobId };
  }
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  await writeJson(token, `/jobs/job-${jobId}.json`, next);
  return next;
}

function newRecipeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const serveHandler = serve({
  client: inngest,
  functions: [extractVideoFn],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});

export default serveHandler;
export const config = { api: { bodyParser: false } };
