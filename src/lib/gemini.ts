import { GoogleGenAI, GenerateContentResponse } from "@google/genai";

// Standard initialization for AI Studio
const genAI = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || '' 
});

export async function* streamGeminiResponse(
  modelName: string,
  history: { role: string; parts: { text: string }[] }[],
  currentMessage: string,
  attachment?: { mimeType: string; data: string },
  config?: any
) {
  const model = modelName || 'gemini-flash-latest';
  
  const chat = genAI.chats.create({
    model: model,
    history: history,
    config: {
      temperature: config?.temperature ?? 0.7,
      maxOutputTokens: config?.maxTokens ?? 2000,
      systemInstruction: config?.systemInstruction || "You are MyAI, a helpful and friendly personal assistant.",
    }
  });

  const parts: any[] = [{ text: currentMessage }];
  if (attachment) {
    parts.push({
      inlineData: {
        mimeType: attachment.mimeType,
        data: attachment.data,
      },
    });
  }

  const result = await chat.sendMessageStream({ message: parts });

  for await (const chunk of result) {
    const responseChunk = chunk as GenerateContentResponse;
    yield responseChunk.text || '';
  }
}

export async function generateChatTitle(firstMessage: string) {
  try {
    const response = await genAI.models.generateContent({
      model: "gemini-flash-latest",
      contents: `Generate a very short (max 4 words) title for a chat that starts with: "${firstMessage}"`,
    });
    return response.text.trim().replace(/^"|"$/g, '');
  } catch (error) {
    console.error("Title generation failed", error);
    return "New Chat";
  }
}
