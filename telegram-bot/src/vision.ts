import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";

const openai = new OpenAI();

export async function describeImage(
  imageBuffer: Buffer,
  mimeType: string,
  caption?: string
): Promise<string> {
  return describeImages([{ buffer: imageBuffer, mimeType }], caption);
}

export interface ImageInput {
  buffer: Buffer;
  mimeType: string;
}

export async function describeImages(
  images: ImageInput[],
  caption?: string
): Promise<string> {
  const content: ChatCompletionContentPart[] = images.map((img) => ({
    type: "image_url" as const,
    image_url: {
      url: `data:${img.mimeType};base64,${img.buffer.toString("base64")}`,
      detail: "auto" as const,
    },
  }));

  const count = images.length;
  let textPrompt: string;
  if (caption && count > 1) {
    textPrompt = `The user sent ${count} images with the caption: "${caption}". Describe each image briefly, then address the caption/question if applicable.`;
  } else if (caption) {
    textPrompt = `The user sent this image with the caption: "${caption}". Describe the image in detail, then address the caption/question if applicable.`;
  } else if (count > 1) {
    textPrompt = `The user sent ${count} images. Describe each image briefly.`;
  } else {
    textPrompt = "Describe this image in detail. What does it show?";
  }

  content.push({ type: "text", text: textPrompt });

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content }],
    max_tokens: count > 1 ? 500 * count : 1000,
  });

  return response.choices[0]?.message?.content ?? "(no description)";
}
