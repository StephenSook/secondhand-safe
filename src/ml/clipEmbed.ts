import { CLIPVisionModelWithProjection, AutoProcessor, RawImage } from "@huggingface/transformers";

/**
 * CLIP ViT-B/32 image embedding with transformers.js, the same weights (Xenova/clip-vit-base-patch32) the
 * Python head was trained on. Runs in the browser (on the judge's phone) and in Node (parity test).
 */
export type Dtype = "fp32" | "fp16" | "q8";
const MODEL = "Xenova/clip-vit-base-patch32";

let cache: { dtype: Dtype; load: Promise<[Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>, CLIPVisionModelWithProjection]> } | null = null;

export function loadClip(dtype: Dtype = "q8", onProgress?: (pct: number) => void) {
  if (!cache || cache.dtype !== dtype) {
    cache = {
      dtype,
      load: Promise.all([
        AutoProcessor.from_pretrained(MODEL),
        CLIPVisionModelWithProjection.from_pretrained(MODEL, {
          dtype,
          progress_callback: (e: { status?: string; progress?: number }) => {
            if (onProgress && e.status === "progress" && typeof e.progress === "number") onProgress(e.progress);
          },
        }) as Promise<CLIPVisionModelWithProjection>,
      ]),
    };
  }
  return cache.load;
}

export async function embedImage(input: string | Blob | URL, dtype: Dtype = "q8"): Promise<Float32Array> {
  const [processor, model] = await loadClip(dtype);
  const image = input instanceof Blob ? await RawImage.fromBlob(input) : await RawImage.read(input);
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);
  return image_embeds.data as Float32Array;
}
