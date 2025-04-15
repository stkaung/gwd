import dotenv from "dotenv";
dotenv.config();

const BLOXLINK_API_KEY = process.env.BLOXLINK_API_KEY;

// Get the Roblox ID of a user from their Discord ID
export async function getRobloxId(serverId, discordId) {
  try {
    const response = await fetch(
      `https://api.blox.link/v4/public/guilds/${serverId}/discord-to-roblox/${discordId}`,
      {
        headers: { Authorization: BLOXLINK_API_KEY },
      }
    );
    const json = await response.json();
    console.log(json);
    return json.robloxID || null;
  } catch (error) {
    console.error(
      "❌ Error fetching Roblox ID from Bloxlink:",
      error.response?.data || error.message
    );
    return null;
  }
}

export default { getRobloxId };
