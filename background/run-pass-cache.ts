import type { ModelMessage } from 'ai';
import type { Message } from '../ai/message-schema.js';
import { type ModelMessageOptions, toModelMessages } from '../ai/model-convert.js';

function buildModelMessageOptionsKey(options: ModelMessageOptions = {}): string {
  return options.systemMessageMode || 'system';
}

export class RunPassCache {
  private cachedCount = 0;
  private cachedMessages: ModelMessage[] = [];
  private cacheOptionsKey = '';

  getModelMessages(messages: Message[], options: ModelMessageOptions = {}): ModelMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) {
      this.reset();
      return [];
    }

    const optionsKey = buildModelMessageOptionsKey(options);
    if (optionsKey !== this.cacheOptionsKey) {
      this.reset();
      this.cacheOptionsKey = optionsKey;
    }

    if (messages.length < this.cachedCount) {
      this.reset();
      this.cacheOptionsKey = optionsKey;
    }

    if (messages.length === this.cachedCount) {
      return this.cachedMessages;
    }

    if (this.cachedCount === 0) {
      this.cachedMessages = toModelMessages(messages, options);
      this.cachedCount = messages.length;
      return this.cachedMessages;
    }

    const tail = messages.slice(this.cachedCount);
    if (tail[0]?.role === 'tool') {
      // A tool result can depend on the assistant tool-call at the cache
      // boundary. Rebuild once so pair validation sees both sides.
      this.cachedMessages = toModelMessages(messages, options);
      this.cachedCount = messages.length;
      return this.cachedMessages;
    }
    const convertedTail = toModelMessages(tail, options);
    this.cachedMessages.push(...convertedTail);
    this.cachedCount = messages.length;
    return this.cachedMessages;
  }

  reset() {
    this.cachedCount = 0;
    this.cachedMessages = [];
    this.cacheOptionsKey = '';
  }
}
