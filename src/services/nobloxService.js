import noblox from "noblox.js"
import dotenv from "dotenv";
import { checkMessage, model } from "./geminiService.js";
import { EmbedBuilder } from "discord.js";
import { 
  getSubscription, 
  getSubscriptionByGroup, 
  logModeration
} from "./firebaseService.js";
import { client } from "../bot.js";
dotenv.config();

export async function initializeNoblox() {
  try {
    await noblox.setCookie(process.env.ROBLOX_COOKIE);
    console.log("✅ Noblox.js initialized successfully!");
  } catch (error) {
    console.error("❌ Failed to initialize Noblox.js:", error);
  }
}

export async function getUsername(robloxId) {
  return await noblox.getUsernameFromId(robloxId);
}

export async function getIdFromUsername(username) {
  try {
    return await noblox.getIdFromUsername(username);
  } catch (error) {
    console.error("❌ Failed to fetch user ID:", error);
    return null;
  }
}

export async function getOwnedGroups(robloxId) {
  try {
    const groups = await noblox.getGroups(robloxId);
    const ownedGroups = groups.filter((group) => group.Rank === 255);

    return ownedGroups.map((group) => ({
      id: group.Id.toString(),
      name: group.Name,
    }));
  } catch (error) {
    console.error("❌ Failed to fetch owned groups:", error);
    return false;
  }
}

export async function getGroupInfo(groupId) {
  try {
    const group = await noblox.getGroup(groupId);
    return {
      id: group.id,
      name: group.name,
      memberCount: group.memberCount,
      description: group.description,
    };
  } catch (error) {
    console.error(`❌ Failed to get group info for ${groupId}:`, error);
    return null;
  }
}

export async function verifyGroupOwnership(robloxId, groupId) {
  try {
    const group = await noblox.getGroup(groupId);
    return group.owner && group.owner.userId == robloxId;
  } catch (error) {
    console.error("❌ Failed to verify group ownership:", error);
    return false;
  }
}

/**
 *
 * @param {number | string} groupId
 */
export async function joinRobloxGroup(groupId) {
  const url = `https://groups.roblox.com/v1/groups/${groupId}/users`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`,
      },
      body: JSON.stringify({
        userId: parseInt(process.env.ROBLOX_ID),
      }),
    });
    if (response.ok) {
      console.log(`✅ Successfully joined group ${groupId}`);
    } else {
      console.error(
        `❌ Failed to join group ${groupId}: ${response.statusText}`
      );
    }
  } catch (error) {
    console.error(`❌ Failed to join group ${groupId}:`, error);
  }
}

export async function getPlayerThumbnail(userId) {
  try {
    // Handle potential non-numeric or undefined userId
    if (!userId) {
      console.log("Missing userId parameter in getPlayerThumbnail");
      return null;
    }
    
    // Ensure userId is a number
    const numericUserId = parseInt(userId);
    
    // Validate that we have a valid number
    if (isNaN(numericUserId)) {
      console.log(`Invalid userId provided to getPlayerThumbnail: ${userId}`);
      return null;
    }
    
    // Call the noblox.js function with numeric userId
    const thumbnails = await noblox.getPlayerThumbnail([numericUserId], 420, "png", false, "Headshot");
    return thumbnails[0]?.imageUrl || null;
  } catch (error) {
    console.error("❌ Failed to fetch player thumbnail:", error);
    return null;
  }
}

export async function leaveGroup(groupId) {
  try {
    // Check if the bot is in the group before trying to leave
    try {
      // Try to get the bot's rank in the group
      const rank = await noblox.getRankInGroup(groupId);
      
      // If rank is 0, the bot is not in the group
      if (rank > 0) {
        console.log(`Leaving group ${groupId} (current rank: ${rank})...`);
        await noblox.leaveGroup(groupId);
        console.log(`Successfully left group ${groupId}`);
        return true;
      } else {
        console.log(`Bot is not in group ${groupId} (rank: ${rank}), skipping leave operation`);
        return false; // Not in group, no action needed
      }
    } catch (groupError) {
      // If there's an error getting the rank, assume the bot is not in the group
      console.log(`Unable to get rank in group ${groupId}, assuming not a member`);
      return false;
    }
  } catch (error) {
    console.error(`Error trying to leave group ${groupId}:`, error);
    return false; // Return false to indicate failure
  }
}

let lastCheckedPostId = null;

export async function getNewWallPosts(groupid, limit = 100) {
  try {
      const posts = await noblox.getWall(groupid, "Desc", limit);

      if (!posts.data || posts.data.length === 0) return [];

      const newPosts = posts.data.filter(post => !lastCheckedPostId || post.id > lastCheckedPostId);

      if (newPosts.length > 0) lastCheckedPostId = newPosts[0].id;

      return newPosts.map(post => ({
          id: post.id,
          body: post.body,  
          poster: post.poster,  
          created: post.created,
          updated: post.updated
      }));

  } catch (error) {
      return [];
  }
}

function toDiscordTimestamp(date, format = "f") {
  const unixTimestamp = Math.floor(new Date(date).getTime() / 1000);
  return `<t:${unixTimestamp}:${format}>`;
}

export async function checkPosts(groupid, posts) {
  try {
    let moderatedPosts = [];
    const sub = await getSubscriptionByGroup(groupid.toString());
    
    // Check if subscription exists and has moderation prompt
    if (!sub || !sub.moderationPrompt) {
      console.log(`No valid subscription or moderation prompt found for group ${groupid}, skipping checks`);
      return [];
    }
    
    // Get the subscription's enabled services
    const enabledServices = sub.moderationServices || ["deletions"];
    console.log(`Group ${groupid} has enabled services:`, enabledServices);
    
    // Process posts with delay between each to avoid overwhelming the API
    for (const post of posts) {
      try {
        // Check message against the moderation criteria
        const moderationResult = await checkMessage(post.body, sub.moderationPrompt);
        console.log(`Moderation result for post ${post.id}:`, moderationResult);
        
        // Skip if the message was approved
        if (moderationResult.approved) {
          continue;
        }
        
        // Get action from the result
        const action = moderationResult.action || "none";
        
        // Skip if no action or if the service for this action isn't enabled
        if (action === "none" || 
           (action === "deletion" && !enabledServices.includes("deletions")) ||
           (action === "exile" && !enabledServices.includes("exiles")) ||
           (action === "demotion" && !enabledServices.includes("demotions")) ||
           (action === "rankchange" && !enabledServices.includes("demotions"))) {
          console.log(`Skipping action ${action} for post ${post.id} as it's not enabled`);
          continue;
        }
        
        // Get user ID and username from the post
        const userId = post.poster.user.userId;
        const username = post.poster.user.username;
        
        // Take appropriate action based on the result
        switch (action) {
          case "deletion":
            console.log(`Deleting post ${post.id} in group ${groupid}`);
            await noblox.deleteWallPost(groupid, post.id);
            
            // Log the deletion
            const currentUser = await noblox.getCurrentUser();
            await logModeration({
              type: "deletion",
              groupId: groupid.toString(),
              robloxId: userId.toString(),
              message: post.body,
              reason: moderationResult.reason || "Violated group wall rules",
              botId: currentUser.UserID.toString()
            });
            
            // Send deletion notification if channel exists
            if (sub.channelId) {
              try {
                const pfp = await getPlayerThumbnail(userId);
                const embed = new EmbedBuilder()
                  .setAuthor({name: username, url: `https://roblox.com/users/${userId}`, iconURL: pfp})
                  .setDescription(`Moderated the following post:`)
                  .setFields(
                    { name: "Poster", value: `Username: ${username}\nUser ID: ${userId}\nUser Role: ${post.poster.role.name} | ${post.poster.role.rank}` },
                    { name: "Post", value: `Post: ${post.body}\nPost ID: ${post.id}\nPost Created: ${toDiscordTimestamp(post.created.toString())}\nPost Edited: ${toDiscordTimestamp(post.updated.toString())}` },
                    { name: "Action", value: "Post Deletion" },
                    { name: "Reason", value: moderationResult.reason || "Violated group rules" }
                  )
                  .setColor(0xff6b6b) // Red color for deletions
                  .setTimestamp();
                
                const channel = await client.channels.fetch(sub.channelId);
                await channel.send({embeds: [embed]});
              } catch (notifyError) {
                console.error(`Error sending notification for moderation:`, notifyError);
              }
            }
            break;
            
          case "exile":
            console.log(`Exiling user ${userId} from group ${groupid}`);
            // Delete the post first
            await noblox.deleteWallPost(groupid, post.id);
            // Then exile the user
            await exileUser(groupid, userId, moderationResult.reason, post.body);
            break;
            
          case "demotion":
            console.log(`Demoting user ${userId} in group ${groupid}`);
            // Delete the post first
            await noblox.deleteWallPost(groupid, post.id);
            // Then demote the user by the specified number of levels
            const demotionLevels = moderationResult.demotionLevels || 1;
            
            // Only allow up to 3 demotions to prevent abuse
            const safeDemotionLevels = Math.min(demotionLevels, 3);
            
            if (safeDemotionLevels === 1) {
              // Standard single-level demotion
              await demoteUser(groupid, userId, null, moderationResult.reason, post.body);
            } else {
              // Multi-level demotion
              // Get user's current rank
              const currentRank = await noblox.getRankInGroup(groupid, userId);
              const roles = await noblox.getRoles(groupid);
              const sortedRoles = roles.sort((a, b) => a.rank - b.rank);
              
              // Find current role index
              const currentRoleIndex = sortedRoles.findIndex(role => role.rank === currentRank);
              
              if (currentRoleIndex > 0) {
                // Calculate target rank (ensure we don't go below lowest rank)
                const targetRoleIndex = Math.max(0, currentRoleIndex - safeDemotionLevels);
                const targetRole = sortedRoles[targetRoleIndex];
                
                // Set to the target rank directly
                await demoteUser(groupid, userId, targetRole.rank, 
                  `${moderationResult.reason} (Demoted ${safeDemotionLevels} levels)`, post.body);
              }
            }
            break;
            
          case "rankchange":
            console.log(`Changing rank of user ${userId} in group ${groupid} to "${moderationResult.targetRank}"`);
            // Delete the post first
            await noblox.deleteWallPost(groupid, post.id);
            
            try {
              // Get all group roles
              const roles = await noblox.getRoles(groupid);
              
              // Find the target role by name (case insensitive)
              const targetRankName = moderationResult.targetRank;
              const targetRole = roles.find(role => 
                role.name.toLowerCase() === targetRankName.toLowerCase()
              );
              
              if (!targetRole) {
                console.error(`Couldn't find role named "${targetRankName}" in group ${groupid}`);
                // Try to demote instead as a fallback
                await demoteUser(groupid, userId, null, `${moderationResult.reason} (Rank change failed, demoted instead)`, post.body);
              } else {
                // Set the user to the specific rank
                const oldRank = await noblox.getRankNameInGroup(groupid, userId);
                await noblox.setRank(groupid, userId, targetRole.rank);
                
                // Log as a demotion for consistency
                const currentUser = await noblox.getCurrentUser();
                await logModeration({
                  type: "demotion",
                  groupId: groupid.toString(),
                  robloxId: userId.toString(),
                  reason: moderationResult.reason || "Rank changed due to rule violation",
                  botId: currentUser.UserID.toString(),
                  message: `Rank changed from ${oldRank} to ${targetRole.name}`,
                  postMessage: post.body
                });
                
                // Notify if channel exists
                if (sub.channelId) {
                  try {
                    const pfp = await getPlayerThumbnail(userId);
                    const embed = new EmbedBuilder()
                      .setAuthor({name: username, url: `https://roblox.com/users/${userId}`, iconURL: pfp})
                      .setDescription(`Changed user's rank in the group:`)
                      .setFields(
                        {name: "User", value: `Username: ${username}\nUser ID: ${userId}`},
                        {name: "Action", value: `Rank changed from ${oldRank} to ${targetRole.name}`},
                        {name: "Reason", value: moderationResult.reason || "Violated group rules"},
                        {name: "Post", value: post.body}
                      )
                      .setColor(0x9b59b6) // Purple color for rank changes
                      .setTimestamp();
                    
                    const channel = await client.channels.fetch(sub.channelId);
                    await channel.send({embeds: [embed]});
                  } catch (notifyError) {
                    console.error(`Error sending notification for rank change:`, notifyError);
                  }
                }
              }
            } catch (rankError) {
              console.error(`Error changing rank for user ${userId}:`, rankError);
            }
            break;
        }
        
        // Add to moderated posts list
        moderatedPosts.push({
          ...post,
          action: action,
          reason: moderationResult.reason
        });
        
        // Add a small delay between processing posts to avoid rate limiting
        if (posts.length > 2) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error) {
        console.error(`Error processing post ${post.id}:`, error);
        // Continue with next post even if one fails
        continue;
      }
    }
    return moderatedPosts;
  } catch (error) {
    console.log(error);
    return [];
  }
}

/**
 * Exile a user from a group and log the action
 * @param {number|string} groupId - Roblox group ID
 * @param {number|string} userId - Roblox user ID to exile
 * @param {string} reason - Reason for the exile
 * @param {string} postMessage - Original post message that triggered the action (optional)
 * @returns {Promise<boolean>} Success status
 */
export async function exileUser(groupId, userId, reason, postMessage = null) {
  try {
    // Ensure we have numeric values for noblox.js
    const numericGroupId = parseInt(groupId);
    const numericUserId = parseInt(userId);
    
    if (isNaN(numericGroupId) || isNaN(numericUserId)) {
      throw new Error("Invalid group ID or user ID");
    }
    
    // Get the user's info
    const username = await getUsername(numericUserId);
    
    // Exile the user
    await noblox.exile(numericGroupId, numericUserId);
    
    // Get the bot's ID for logging
    const currentUser = await noblox.getCurrentUser();
    
    // Log to Firestore
    await logModeration({
      type: "exile",
      groupId: groupId.toString(),
      robloxId: userId.toString(),
      reason: reason || "Violated group rules",
      botId: currentUser.UserID.toString(),
      message: postMessage || "" // Store the post message in logs
    });
    
    // Get subscription for Discord notification
    const sub = await getSubscriptionByGroup(groupId.toString());
    if (sub && sub.channelId) {
      try {
        // Get user thumbnail
        const pfp = await getPlayerThumbnail(numericUserId);
        
        // Build the embed fields
        const embedFields = [
          {name: "User", value: `Username: ${username}\nUser ID: ${numericUserId}`},
          {name: "Action", value: "Exile (Kick)"},
          {name: "Reason", value: reason || "Violated group rules"}
        ];
        
        // Add post message field if available
        if (postMessage) {
          embedFields.push({name: "Triggering Post", value: postMessage.length > 1024 ? 
            `${postMessage.substring(0, 1021)}...` : postMessage});
        }
        
        // Send Discord notification
        const embed = new EmbedBuilder()
          .setAuthor({name: username, url: `https://roblox.com/users/${numericUserId}`, iconURL: pfp})
          .setDescription(`Exiled user from the group:`)
          .setFields(embedFields)
          .setColor(0xe67e22) // Orange color
          .setTimestamp();
        
        const channel = await client.channels.fetch(sub.channelId);
        await channel.send({embeds: [embed]});
      } catch (notifyError) {
        console.error(`Error sending notification for exile of user ${userId}:`, notifyError);
        // Continue even if notification fails
      }
    }
    
    console.log(`Exiled user ${username} (${numericUserId}) from group ${numericGroupId}`);
    return true;
  } catch (error) {
    console.error(`Error exiling user from group:`, error);
    return false;
  }
}

/**
 * Demote a user in a group and log the action
 * @param {number|string} groupId - Roblox group ID
 * @param {number|string} userId - Roblox user ID to demote
 * @param {number} newRank - New rank ID to set (optional, will demote one level if not provided)
 * @param {string} reason - Reason for the demotion
 * @param {string} postMessage - Original post message that triggered the action (optional)
 * @returns {Promise<boolean>} Success status
 */
export async function demoteUser(groupId, userId, newRank, reason, postMessage = null) {
  try {
    // Ensure we have numeric values for noblox.js
    const numericGroupId = parseInt(groupId);
    const numericUserId = parseInt(userId);
    
    if (isNaN(numericGroupId) || isNaN(numericUserId)) {
      throw new Error("Invalid group ID or user ID");
    }
    
    // Get the user's info
    const username = await getUsername(numericUserId);
    
    // Get current rank info
    const currentRankName = await noblox.getRankNameInGroup(numericGroupId, numericUserId);
    const currentRank = await noblox.getRankInGroup(numericGroupId, numericUserId);
    
    let newRankName = "Unknown";
    let newRankNumber = newRank;
    
    if (newRank) {
      // If specific rank is provided, set to that rank
      newRankName = await noblox.getRankNameInGroup(numericGroupId, numericUserId);
      await noblox.setRank(numericGroupId, numericUserId, newRank);
    } else {
      // If no rank specified, demote by one level
      // Get all group roles
      const roles = await noblox.getRoles(numericGroupId);
      
      // Find the role one level below the current one
      const sortedRoles = roles.sort((a, b) => a.rank - b.rank);
      const currentRoleIndex = sortedRoles.findIndex(role => role.rank === currentRank);
      
      if (currentRoleIndex > 0) {
        const newRole = sortedRoles[currentRoleIndex - 1];
        newRankName = newRole.name;
        newRankNumber = newRole.rank;
        await noblox.setRank(numericGroupId, numericUserId, newRole.rank);
      } else {
        throw new Error("User is already at the lowest rank");
      }
    }
    
    // Get the bot's ID for logging
    const currentUser = await noblox.getCurrentUser();
    
    // Log to Firestore
    await logModeration({
      type: "demotion",
      groupId: groupId.toString(),
      robloxId: userId.toString(),
      reason: reason || "Rank demotion",
      botId: currentUser.UserID.toString(),
      message: postMessage ? `${postMessage}\n\nDemoted from ${currentRankName} to ${newRankName}` : 
                           `Demoted from ${currentRankName} to ${newRankName}`
    });
    
    // Get subscription for Discord notification
    const sub = await getSubscriptionByGroup(groupId.toString());
    if (sub && sub.channelId) {
      try {
        // Get user thumbnail
        const pfp = await getPlayerThumbnail(numericUserId);
        
        // Build the embed fields
        const embedFields = [
          {name: "User", value: `Username: ${username}\nUser ID: ${numericUserId}`},
          {name: "Action", value: `Demotion from ${currentRankName} (Rank ${currentRank}) to ${newRankName} (Rank ${newRankNumber})`},
          {name: "Reason", value: reason || "Rank demotion"}
        ];
        
        // Add post message field if available
        if (postMessage) {
          embedFields.push({name: "Triggering Post", value: postMessage.length > 1024 ? 
            `${postMessage.substring(0, 1021)}...` : postMessage});
        }
        
        // Send Discord notification
        const embed = new EmbedBuilder()
          .setAuthor({name: username, url: `https://roblox.com/users/${numericUserId}`, iconURL: pfp})
          .setDescription(`Demoted user in the group:`)
          .setFields(embedFields)
          .setColor(0x3498db) // Blue color
          .setTimestamp();
        
        const channel = await client.channels.fetch(sub.channelId);
        await channel.send({embeds: [embed]});
      } catch (notifyError) {
        console.error(`Error sending notification for demotion of user ${userId}:`, notifyError);
        // Continue even if notification fails
      }
    }
    
    console.log(`Demoted user ${username} (${numericUserId}) in group ${numericGroupId} from ${currentRankName} to ${newRankName}`);
    return true;
  } catch (error) {
    console.error(`Error demoting user in group:`, error);
    return false;
  }
}

// Store active monitors to avoid duplicates
export const activeMonitors = new Map();

export async function monitorGroupWall(groupId) {
  // Avoid duplicate monitors for the same group
  if (activeMonitors.has(groupId)) {
    console.log(`Already monitoring group ${groupId}, skipping duplicate`);
    return;
  }
  
  console.log(`📡 Starting monitor for group wall ${groupId}...`);
  
  // Temporary placeholder to prevent duplicate starts while we initialize
  activeMonitors.set(groupId, {initializing: true});
  
  let isChecking = false;  // Lock variable to track if function is currently executing
  let consecutiveErrors = 0;
  
  // Use a longer interval of 15 seconds to reduce API calls
  const wallCheckIntervalId = setInterval(async () => {
    if (isChecking) return;  // If already checking, exit

    isChecking = true; // Set the lock
    try {
      const posts = await getNewWallPosts(groupId);

      if (posts.length > 0) {
        console.log(`🆕 Found ${posts.length} new post(s) to moderate in group ${groupId}.`);
        await checkPosts(groupId, posts.reverse()); // reverse to maintain chronological order
      }

      // Reset consecutive errors counter on success
      consecutiveErrors = 0;
    } catch (err) {
      console.error(`❌ Failed to fetch or check posts for group ${groupId}:`, err);
      consecutiveErrors++;
      
      // If we have multiple consecutive errors, increase the backoff
      if (consecutiveErrors > 3) {
        console.log(`Multiple consecutive errors detected for group ${groupId}, backing off for 30 seconds`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    } finally {
      isChecking = false;  // Release the lock
    }
  }, 15000);
  
  // Store interval IDs for potential cleanup (replace temporary placeholder)
  activeMonitors.set(groupId, {
    wallCheckIntervalId,
    timestamp: new Date().toISOString() // Add timestamp for debugging
  });
  
  // Debug logging for monitoring
  console.log(`✅ Successfully started monitoring for group ${groupId}`);
  console.log(`Current monitored groups: ${Array.from(activeMonitors.keys()).join(', ')}`);
  
  return { wallCheckIntervalId }; // Return interval ID for potential cleanup
}

// Stop monitoring a specific group
export function stopMonitoringGroup(groupId) {
  const intervals = activeMonitors.get(groupId);
  if (intervals) {
    if (typeof intervals === 'object') {
      // New format with multiple intervals
      clearInterval(intervals.wallCheckIntervalId);
    } else {
      // Legacy format with single interval ID
      clearInterval(intervals);
    }
    
    activeMonitors.delete(groupId);
    console.log(`Stopped monitoring group ${groupId}`);
  }
}

// Monitor multiple groups in parallel
export async function monitorMultipleGroupWalls(groupIds) {
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    console.log("No groups to monitor");
    return;
  }
  
  // Ensure all groupIds are strings to avoid inconsistencies
  const normalizedGroupIds = groupIds.map(id => id.toString());
  
  // Log which groups are already being monitored vs which are new
  const alreadyMonitored = normalizedGroupIds.filter(id => activeMonitors.has(id));
  const newGroups = normalizedGroupIds.filter(id => !activeMonitors.has(id));
  
  console.log(`Starting parallel monitoring for ${newGroups.length} new groups...`);
  
  if (alreadyMonitored.length > 0) {
    console.log(`Skipping ${alreadyMonitored.length} groups already being monitored: ${alreadyMonitored.join(', ')}`);
  }
  
  if (newGroups.length === 0) {
    console.log("No new groups to monitor");
    return;
  }
  
  try {
    // Use Promise.all to start all monitors concurrently
    await Promise.all(
      newGroups.map(groupId => monitorGroupWall(groupId))
    );
    
    console.log(`All ${newGroups.length} new group monitors started successfully`);
    
    // Debug log to show all currently monitored groups
    console.log(`Total monitored groups (${activeMonitors.size}): ${Array.from(activeMonitors.keys()).join(', ')}`);
  } catch (error) {
    console.error("Error starting multiple group monitors:", error);
  }
}

export default {
  initializeNoblox,
  getUsername,
  getIdFromUsername,
  getOwnedGroups,
  verifyGroupOwnership,
  joinRobloxGroup,
  monitorGroupWall,
  monitorMultipleGroupWalls,
  stopMonitoringGroup,
  getGroupInfo,
  getPlayerThumbnail,
  leaveGroup,
  exileUser,
  demoteUser
};
