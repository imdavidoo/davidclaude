import OpenAI, { toFile } from "openai";

const openai = new OpenAI();

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string
): Promise<string> {
  const file = await toFile(audioBuffer, filename);
  const result = await openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file,
  });
  return result.text;
}
