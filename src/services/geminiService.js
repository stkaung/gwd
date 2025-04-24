import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import noblox from "noblox.js";

// Disable deprecation warnings from noblox
noblox.setOptions({ show_deprecation_warnings: false });

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Rate limiting implementation
const rateLimiter = {
  tokens: 10, // Maximum tokens allowed per minute (adjust based on your API tier)
  refillRate: 10, // Tokens refilled per minute
  lastRefill: Date.now(),
  waitingQueue: [],
  
  async getToken() {
    // Refill tokens based on time elapsed
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const refillAmount = Math.floor(timePassed / (60 * 1000) * this.refillRate);
    
    if (refillAmount > 0) {
      this.tokens = Math.min(this.tokens + refillAmount, this.refillRate);
      this.lastRefill = now;
    }
    
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    
    // If no tokens available, calculate wait time
    const waitTime = Math.ceil((60 * 1000) / this.refillRate);
    console.log(`Rate limit reached. Waiting ${waitTime}ms before retry.`);
    
    // Wait for token to be available
    return new Promise(resolve => {
      setTimeout(() => {
        this.tokens = 1; // We get one new token
        this.tokens--; // Use it
        resolve(true);
      }, waitTime);
    });
  }
};

export async function checkMessage(message, moderationPrompt) {
  try {
    console.log(`Checking message ${message} with moderation prompt ${moderationPrompt}.`);
    
    // Wait for a token before making the API call
    await rateLimiter.getToken();
    
    const prompt = `
        You are a strict content moderation bot for a Roblox group. Your job is to analyze messages and determine if they match the moderation criteria provided.

        ### **Instructions:**
        - You will be given a **moderation rule set** (criteria) and a **message** to analyze.
        - If the message **violates** any of the moderation rules, determine the appropriate action.
        - Respond in a specific JSON format with your decision (see below).
        - Be strict and precise in your analysis.
        - For demotion commands, pay special attention to the number of ranks mentioned (e.g., "demote 2 ranks").
        - For rank change commands, identify the specific rank name mentioned (e.g., "change rank to Outcast").

        ### **Moderation Rules:**  
        "${moderationPrompt}"

        ### **Message to Analyze:**  
        "${message}"

        ### **Response Format:**
        Respond with a JSON object in this exact format:
        {
          "approved": true/false,         // true if the message should be allowed, false if it violates rules
          "action": "none/deletion/exile/demotion/rankchange", // what action should be taken if disapproved
          "reason": "brief explanation",  // brief explanation of why this action was chosen
          "demotionLevels": 1,            // if action is demotion, how many ranks to demote (default 1)
          "targetRank": ""                // if action is rankchange, the name of the rank to set
        }

        ### **Examples:**
        
        If the rules say "Delete messages with swear words":
        {
          "approved": false,
          "action": "deletion",
          "reason": "Message contains prohibited language",
          "demotionLevels": 0,
          "targetRank": ""
        }

        If the rules say "Exile users that talk about the events of 9/11":
        {
          "approved": false,
          "action": "exile",
          "reason": "Discussing prohibited historical events",
          "demotionLevels": 0,
          "targetRank": ""
        }

        If the rules say "Demote 2 ranks under if message contains confidential information":
        {
          "approved": false,
          "action": "demotion",
          "reason": "Sharing confidential information",
          "demotionLevels": 2,
          "targetRank": ""
        }

        If the rules say "Change rank to Outcast if message contains racism":
        {
          "approved": false,
          "action": "rankchange",
          "reason": "Racist content",
          "demotionLevels": 0,
          "targetRank": "Outcast"
        }

        If it doesn't violate rules, return:
        {
          "approved": true, 
          "action": "none",
          "reason": "Message follows community guidelines",
          "demotionLevels": 0,
          "targetRank": ""
        }

        Respond with ONLY the JSON object, no other text.`;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text().trim();
    console.log(`Raw moderation result: ${text}`);
    
    try {
      // Clean the response text to handle markdown formatted responses
      let jsonText = text;
      
      // Remove markdown code blocks if present
      if (jsonText.includes("```")) {
        // Extract content between code blocks
        const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch && codeBlockMatch[1]) {
          jsonText = codeBlockMatch[1].trim();
        } else {
          // If no match found but ``` exists, try removing all ```
          jsonText = jsonText.replace(/```(?:json)?|```/g, "").trim();
        }
      }
      
      // Parse the cleaned JSON
      const parsedResponse = JSON.parse(jsonText);
      console.log(`Parsed moderation result for message "${message}":`, parsedResponse);
      
      // Return the full result for the caller to handle
      return {
        approved: parsedResponse.approved === true,
        action: parsedResponse.action?.toLowerCase() || "none",
        reason: parsedResponse.reason || "Violation of group rules",
        demotionLevels: parseInt(parsedResponse.demotionLevels || 1),
        targetRank: parsedResponse.targetRank || ""
      };
    } catch (jsonError) {
      console.error("Error parsing cleaned JSON response:", jsonError);
      
      // Basic text-based heuristic fallback
      const isApproved = jsonText.includes('"approved": true') || jsonText.includes('"approved":true');
      let action = "none";
      if (jsonText.includes('"action": "deletion"') || jsonText.includes('"action":"deletion"')) action = "deletion";
      if (jsonText.includes('"action": "exile"') || jsonText.includes('"action":"exile"')) action = "exile";
      if (jsonText.includes('"action": "demotion"') || jsonText.includes('"action":"demotion"')) action = "demotion";
      if (jsonText.includes('"action": "rankchange"') || jsonText.includes('"action":"rankchange"')) action = "rankchange";
      
      // Try to extract reason using regex
      let reason = "Violation of group rules";
      const reasonMatch = jsonText.match(/"reason":\s*"([^"]*)"/);
      if (reasonMatch && reasonMatch[1]) {
        reason = reasonMatch[1];
      }
      
      // Try to extract demotionLevels using regex
      let demotionLevels = 1;
      const demotionMatch = jsonText.match(/"demotionLevels":\s*(\d+)/);
      if (demotionMatch && demotionMatch[1]) {
        demotionLevels = parseInt(demotionMatch[1]);
      }
      
      // Try to extract targetRank using regex
      let targetRank = "";
      const rankMatch = jsonText.match(/"targetRank":\s*"([^"]*)"/);
      if (rankMatch && rankMatch[1]) {
        targetRank = rankMatch[1];
      }
      
      console.log(`Used text-based fallback parsing for message "${message}"`);
      return {
        approved: isApproved,
        action: action,
        reason: reason,
        demotionLevels: demotionLevels,
        targetRank: targetRank
      };
    }
  } catch (error) {
    console.error("Error checking message:", error);
    
    // If rate limited, implement a backoff strategy
    if (error.status === 429) {
      console.log("Rate limited by Gemini API, using fallback moderation logic");
      
      // Basic fallback logic
      const messageText = message.toLowerCase();
      const containsBadWords = messageText.includes('hack') || 
                              messageText.includes('free robux') || 
                              messageText.includes('password');
      
      if (containsBadWords && messageText.includes('!')) {
        return { 
          approved: false, 
          action: "deletion", 
          reason: "Potentially harmful content (fallback detection)",
          demotionLevels: 1,
          targetRank: ""
        };
      }
    }
    
    // Log message details for debugging
    console.log(`Message that caused error: "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`);
    console.log(`Moderation prompt that caused error: "${moderationPrompt.slice(0, 100)}${moderationPrompt.length > 100 ? '...' : ''}"`);
    
    // Default fallback is to allow messages on error to prevent false positives
    return { 
      approved: true, 
      action: "none", 
      reason: "Error in moderation check - allowing message", 
      demotionLevels: 0,
      targetRank: ""
    };
  }
}

export default { model, checkMessage };
