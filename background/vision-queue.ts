import { type SDKModelSettings, describeImageWithModel } from '../ai/sdk-client.js';
import { readScreenshotDataUrl } from './screenshot-store.js';

export type VisionDescribeSettings = SDKModelSettings;

export type VisionQueueResult = {
  description: string;
};

export type VisionQueueError = {
  message: string;
};

export type VisionQueueJob = {
  /** Prefer screenshotId so the queue does not pin multi-MB base64 strings. */
  screenshotId?: string;
  dataUrl?: string;
  prompt: string;
  settings: VisionDescribeSettings;
  timeoutMs: number;
  maxTokens?: number;
  onComplete: (result: VisionQueueResult) => void;
  onError: (error: VisionQueueError) => void;
};

const MAX_CONCURRENT_VISION_JOBS = 2;
/** Drop oldest waiting jobs when the backlog grows past this. */
export const MAX_QUEUED_VISION_JOBS = 4;

export class VisionQueue {
  private inFlight = 0;
  private queue: VisionQueueJob[] = [];

  get activeCount() {
    return this.inFlight;
  }

  get pendingCount() {
    return this.queue.length;
  }

  enqueue(job: VisionQueueJob) {
    if (!job.screenshotId && !job.dataUrl) {
      job.onError({ message: 'Vision job requires screenshotId or dataUrl.' });
      return;
    }

    this.queue.push(job);
    // Cap waiting backlog (in-flight jobs are not in this array).
    while (this.queue.length > MAX_QUEUED_VISION_JOBS) {
      const dropped = this.queue.shift();
      if (!dropped) break;
      try {
        dropped.onError({ message: 'Vision queue full — oldest job dropped.' });
      } catch {
        // Listener errors must not break the queue.
      }
    }
    this.pump();
  }

  private pump() {
    while (this.inFlight < MAX_CONCURRENT_VISION_JOBS && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) return;
      this.inFlight += 1;
      void this.run(job).finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.pump();
      });
    }
  }

  private async resolveDataUrl(job: VisionQueueJob): Promise<string | null> {
    if (typeof job.dataUrl === 'string' && job.dataUrl) return job.dataUrl;
    if (typeof job.screenshotId === 'string' && job.screenshotId) {
      return readScreenshotDataUrl(job.screenshotId);
    }
    return null;
  }

  private async run(job: VisionQueueJob) {
    try {
      const dataUrl = await this.resolveDataUrl(job);
      if (!dataUrl) {
        job.onError({ message: 'Vision job image unavailable (expired or missing).' });
        return;
      }
      const description = await describeImageWithModel({
        settings: job.settings,
        dataUrl,
        prompt: job.prompt,
        maxTokens: job.maxTokens ?? 512,
        abortSignal: AbortSignal.timeout(job.timeoutMs),
      });
      job.onComplete({ description: description || '' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.onError({ message });
    }
  }
}

export const isVisionBridgeEnabled = (settings: Record<string, unknown>) => settings.visionBridge !== false;

export const isVisionBridgeSync = (settings: Record<string, unknown>) => settings.visionBridgeSync === true;
