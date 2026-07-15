import type { VqImageModel } from "@shared/vq-schema";
import type { VqAiProviderId, VqProviderDescriptor } from "@shared/vq-ai-provider";
import type { VqProviderConnectionSnapshot } from "../lib/vq-provider-connection";

export interface VqArtworkGenerationRequest {
  prompt: string;
  model?: VqImageModel;
  references?: string[];
  idempotencyKey: string;
}

export interface VqArtworkGenerationResult {
  provider: VqAiProviderId;
  model: string;
  jobId?: string;
  png: Buffer;
  width: number;
  height: number;
}

export interface VqArtworkProvider {
  readonly id: VqAiProviderId;
  readonly descriptor: VqProviderDescriptor;
  generateArtwork(request: VqArtworkGenerationRequest): Promise<VqArtworkGenerationResult>;
  checkConnection(nowMs?: number): Promise<VqProviderConnectionSnapshot>;
  getStatus(nowMs?: number): Promise<VqProviderConnectionSnapshot>;
  getAvailableModels(): VqProviderDescriptor["models"];
  getCreditBalance?(): Promise<number | null>;
}
