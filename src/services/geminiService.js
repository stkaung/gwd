import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export async function checkMessage(message, moderationPrompt) {
  const prompt = `
        You are a strict content moderation bot. Your job is to analyze messages and determine if they match the moderation criteria provided.

        ### **Instructions:**
        - You will be given a **moderation rule** (criteria) and a **message** to analyze.
        - If the message **violates** the moderation rule, respond with **"true"**.
        - If the message **does not violate** the rule, respond with **"false"**.
        - Be strict and precise in your analysis.

        ### **Moderation Rule:**  
        "${moderationPrompt}"

        ### **Message to Analyze:**  
        "${message}"

        Does this message align with the moderation rule? Respond with only **"true"** or **"false".`;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text().trim().toLowerCase();

    return text.includes("true");
  } catch (error) {
    console.error("Error checking message:", error);
    return false;
  }
}

export default { model, checkMessage };
