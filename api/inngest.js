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
import {
  dbxReadJson,
  dbxWriteJson,
  dbxUpload,
} from '../lib/dropbox.js';
import {
  extractFromVideoUrl,
  extractFramesWithClaude,
  resolveSocialVideo,
  detectPlatform,
} from '../lib/video-pipeline.js';
import {
  extractFromText,
} from '../lib/recipe-extract.js';

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
    const { jobId, url, analysis, frames } = event.data;
    if (!jobId) throw new Error('jobId missing from event');

    // Mark the job as processing so the client sees movement.
    await step.run('mark-processing', async () => {
      await updateJob(jobId, { status: 'processing', progress: 'Starting' });
    });

    try {
      // ----- Step 1: resolve the social URL via RapidAPI. -----
      // Independent step so RapidAPI flakes (rate limits, transient 5xx)
      // retry without redoing Whisper or Claude.
      const platform = detectPlatform(url);
      const reel = (platform === 'instagram' || platform === 'tiktok')
        ? await step.run('resolve', async () => {
            await updateJob(jobId, { progress: `Resolving ${platform} video` }).catch(() => {});
            return resolveSocialVideo(url, platform);
          })
        : null;

      // ----- Step 2: extract recipe + archive mp4. -----
      // Runs the pipeline (caption-link → caption-only → Whisper → optional
      // Gemini fallback) AND uploads the mp4 to Dropbox. The mp4 Buffer
      // stays inside this single step so it never crosses Inngest's step-
      // result serialization boundary (heavy buffers serialize badly).
      // Retries here re-do Whisper + Claude but NOT RapidAPI.
      const recipe = await step.run('extract-and-archive', async () => {
        let result;
        if (analysis === 'audio_frames' && Array.isArray(frames) && frames.length) {
          const [baseResult, frameNotes] = await Promise.all([
            extractFromVideoUrl({
              url, analysis: 'audio', prefetchedReel: reel,
              onProgress: (msg) => updateJob(jobId, { progress: msg }).catch(() => {}),
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
            onProgress: (msg) => updateJob(jobId, { progress: msg }).catch(() => {}),
          });
        }

        // Archive mp4 to Dropbox if we got one.
        let videoPath = null;
        if (result.mp4Buffer && result.mp4Buffer.length > 0) {
          await updateJob(jobId, { progress: 'Archiving video' }).catch(() => {});
          videoPath = `/videos/${jobId}.mp4`;
          try {
            await dbxUpload(videoPath, result.mp4Buffer);
            console.log(`[archive] uploaded ${result.mp4Buffer.length} bytes to ${videoPath}`);
          } catch (err) {
            console.warn('[archive] dropbox upload failed:', err.message);
            videoPath = null;
          }
        }

        return { ...result.recipe, videoPath };
      });

      // Persist the recipe under a stable id and update the job.
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
        await dbxWriteJson(`/recipe-${id}.json`, finalRecipe);
        return id;
      });

      await step.run('mark-done', async () => {
        await updateJob(jobId, {
          status: 'done',
          progress: 'Recipe saved',
          recipeId,
        });
      });

      return { recipeId };
    } catch (err) {
      console.error('[inngest worker] failed:', err);
      // Update job with error status — surface to the user.
      await updateJob(jobId, {
        status: 'error',
        error: String(err && err.message ? err.message : err).slice(0, 500),
      }).catch(() => {});
      throw err; // let Inngest retry
    }
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateJob(jobId, patch) {
  let job;
  try {
    job = await dbxReadJson(`/jobs/job-${jobId}.json`);
  } catch {
    job = { id: jobId };
  }
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  await dbxWriteJson(`/jobs/job-${jobId}.json`, next);
  return next;
}

function newRecipeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Inngest serve handler — exposes /api/inngest as the webhook URL.
// ---------------------------------------------------------------------------

const serveHandler = serve({
  client: inngest,
  functions: [extractVideoFn],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});

// Vercel serverless functions expect a default export; Inngest's serve()
// returns one already.
export default serveHandler;
export const config = { api: { bodyParser: false } };
