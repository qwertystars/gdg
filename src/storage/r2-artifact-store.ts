/**
 * R2-backed ArtifactStore for the Cloudflare runtime. Mirrors the R2 object
 * layout (README "R2 object layout") over the ARTIFACTS binding, replacing
 * LocalArtifactStore under workerd. Implements the ArtifactStore interface.
 */

import type { ArtifactStore } from "./artifact-store";

/** Minimal structural R2 bucket binding. */
interface R2Like {
  put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream | null; size: number } | null>;
  delete(key: string): Promise<unknown>;
}

export class R2ArtifactStore implements ArtifactStore {
  private readonly bucket: R2Like;

  constructor(bucket: R2Like) {
    this.bucket = bucket;
  }

  async read(key: string): Promise<string> {
    const object = await this.bucket.get(key);
    if (object === null) throw new Error(`Artifact not found: ${key}`);
    if (!object.body) throw new Error(`Artifact empty: ${key}`);
    return this.textFromStream(object.body);
  }

  async write(key: string, contents: string): Promise<string> {
    await this.bucket.put(key, contents);
    return key;
  }

  async cleanup(): Promise<void> {
    return;
  }

  private async textFromStream(stream: ReadableStream): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }
}
