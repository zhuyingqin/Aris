/** Somni currently publishes the GPT Image family through its image endpoints. */
export function isImageGenerationModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gpt-image-");
}
