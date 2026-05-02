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
} from '../lib/dropbox.js';
import {
  extractFromVideoUrl,
  extractFramesWithClaude,
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
      // The main extraction step. Returns a recipe object.
      const recipe = await step.run('extract', async () => {
        // For audio_frames mode, run Claude vision in parallel with the
        // rest of the pipeline so we don't block.
        if (analysis === 'audio_frames' && Array.isArray(frames) && frames.length) {
          const [base, frameNotes] = await Promise.all([
            extractFromVideoUrl({
              url, analysis: 'audio',
              onProgress: (msg) => updateJob(jobId, { progress: msg }).catch(() => {}),
            }),
            extractFramesWithClaude(frames),
          ]);

          if (!frameNotes) return base;

          // Merge frame notes into the recipe via one more Claude pass.
          const merged = await extractFromText({
            transcript:  (base.instructions || []).join('\n'),  // round-trip for context
            caption:     base.description || '',
            frameNotes,
            sourceUrl:   url,
          });
          return {
            ...base,
            // Prefer merged ingredients/instructions when they're richer.
            ingredients:  merged.ingredients.length  ? merged.ingredients  : base.ingredients,
            instructions: merged.instructions.length ? merged.instructions : base.instructions,
            extractedBy:  base.extractedBy + '+frames',
          };
        }

        return extractFromVideoUrl({
          url, analysis,
          onProgress: (msg) => updateJob(jobId, { progress: msg }).catch(() => {}),
        });
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
