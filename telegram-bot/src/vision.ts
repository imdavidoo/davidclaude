import OpenAI from "openai";

const openai = new OpenAI();

export async function describeImage(
  imageBuffer: Buffer,
  mimeType: string,
  caption?: string
): Promise<string> {
  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
          {
            type: "text",
            text: caption
              ? `The user sent this image with the caption: "${caption}". Describe the image in detail, then address the caption/question if applicable.`
              : "Describe this image in detail. What does it show?",
          },
        ],
      },
    ],
    max_tokens: 1000,
  });

  return response.choices[0]?.message?.content ?? "(no description)";
}
