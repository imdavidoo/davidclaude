import OpenAI, { toFile } from "openai";
import { MODELS } from "./config";

const openai = new OpenAI();

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string
): Promise<string> {
  const file = await toFile(audioBuffer, filename);
  const result = await openai.audio.transcriptions.create({
    model: MODELS.transcription,
    file,
  });
  return result.text;
}
