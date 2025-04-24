import {v4} from "uuid"
import fs from "fs"
import admin from "firebase-admin"
import { leaveGroup } from "./nobloxService.js"
const uuidv4 = () => {
  return v4()
}

const accountJson = JSON.parse(fs.readFileSync("./serviceAccountKey.json", "utf8"));
// Initialize Firebase Admin SDK with service account credentials
const serviceAccount = accountJson

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

export const usersCollection = db.collection("users");
export const subscriptionsCollection = db.collection("subscriptions");

export async function addSubscription(discordId, groupId, moderationPrompt, stripe, channelId, moderationServices = ["deletions"]) {
  try {
    // Generate random IDs for subscription and stripe customer
    const subscriptionId = `sub_${uuidv4()}`;

    // Check if the user exists in the 'users' collection
    const userRef = usersCollection.doc(discordId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      // User doesn't exist, create a new user document
      const newUser = {
        discordId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        subscriptions: [], // Empty array to hold future subscriptions
      };
      await userRef.set(newUser);
      console.log("New user document created:", discordId);
    }

    // Create the subscription data with default moderation prompt if none provided
    const subscriptionData = {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      discordId,
      endDate: new Date(new Date().setMonth(new Date().getMonth() + 1)), // Set to 1 month from now
      groupId,
      moderationPrompt:
        moderationPrompt || "Delete messages that break community guidelines.", // Default value if undefined
      startDate: admin.firestore.FieldValue.serverTimestamp(),
      subscriptionId,
      stripe: stripe,
      channelId: channelId,
      moderationServices: moderationServices
    };

    // Add subscription to the subscriptions collection
    try {
      const subscriptionRef = subscriptionsCollection.doc(subscriptionId);
      await subscriptionRef.set(subscriptionData);

      await userRef.update({
        subscriptions: admin.firestore.FieldValue.arrayUnion(subscriptionId),
      });

      console.log("Subscription added for user:", discordId);
      return subscriptionData; // Return the subscription data
    } catch (error) {
      console.error("Error adding subscription:", error);
      throw error;
    }
  } catch (error) {
    console.error("Error in addSubscription:", error);
    throw error;
  }
}

export async function cancelSubscription(discordId, groupId) {
  try {
    if (!discordId || !groupId) {
      throw new Error("discordId and groupId are required");
    }

    // Get all subscriptions for this user and group
    const subscriptionsSnapshot = await subscriptionsCollection
      .where("discordId", "==", discordId)
      .where("groupId", "==", groupId)
      .get();

    if (subscriptionsSnapshot.empty) {
      throw new Error("No subscription found");
    }

    // Get the user document reference
    const userRef = usersCollection.doc(discordId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      throw new Error("User document not found");
    }

    // Get subscription IDs to remove
    const subscriptionIds = subscriptionsSnapshot.docs.map((doc) => doc.id);

    // Delete each subscription document
    const deletePromises = subscriptionsSnapshot.docs.map((doc) =>
      doc.ref.delete()
    );

    // Remove subscription IDs from user document
    await userRef.update({
      subscriptions: admin.firestore.FieldValue.arrayRemove(...subscriptionIds),
    });

    await Promise.all(deletePromises);

    // Check if user has any remaining subscriptions
    const remainingSubscriptionsSnapshot = await subscriptionsCollection
      .where("discordId", "==", discordId)
      .get();
    
    try {
      // Import here to avoid circular dependency
      const { stopMonitoringGroup } = await import("./nobloxService.js");
      await stopMonitoringGroup(groupId);
    } catch (error) {
      console.error("Error stopping group monitoring:", error);
    }
    
    await leaveGroup(groupId)

    // Return whether they have any subscriptions left
    return remainingSubscriptionsSnapshot.empty;
  } catch (error) {
    console.error("Error cancelling subscription:", error);
    throw error;
  }
}

export async function getSubscribedGroups(userId) {
  try {
    if (!userId) {
      throw new Error("userId is required");
    }

    // First get the user document to get their subscription IDs
    const userDoc = await db.collection("users").doc(userId.toString()).get();

    if (!userDoc.exists) {
      console.log("No user found for ID:", userId);
      return [];
    }

    const userData = userDoc.data();
    const subscriptionIds = userData.subscriptions || [];

    if (subscriptionIds.length === 0) {
      return [];
    }

    // Get all active subscriptions
    const subscriptionsSnapshot = await db
      .collection("subscriptions")
      .where("discordId", "==", userId.toString())
      .get();

    const subscribedGroupIds = [];

    subscriptionsSnapshot.forEach((doc) => {
      const subscription = doc.data();
      if (subscription.groupId) {
        subscribedGroupIds.push(subscription.groupId.toString());
      }
    });

    console.log("Found subscribed group IDs:", subscribedGroupIds);
    return subscribedGroupIds;
  } catch (error) {
    console.error("Error getting subscribed groups:", error);
    return []; // Return empty array on error
  }
}

export async function getLogs(groupId, robloxId) {
  try {
    if (!groupId || !robloxId) {
      throw new Error("groupId and robloxId are required");
    }

    // Get logs from Firebase for all moderation types
    const logsSnapshot = await db
      .collection("logs")
      .where("groupId", "==", groupId.toString())
      .where("robloxId", "==", robloxId.toString())
      .orderBy("issuedDate", "desc") // Sort by newest first
      .get();

    if (logsSnapshot.empty) {
      return [];
    }

    // Convert the logs to a more usable format
    const logs = [];
    logsSnapshot.forEach((doc) => {
      logs.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return logs;
  } catch (error) {
    console.error("Error getting logs:", error);
    throw error;
  }
}

/**
 * Log a moderation action in Firestore
 * @param {Object} logData - Log data object
 * @param {string} logData.type - Type of action (deletion, exile, demotion)
 * @param {string} logData.groupId - Group ID
 * @param {string} logData.robloxId - Roblox user ID
 * @param {string} logData.message - The content that was moderated (optional)
 * @param {string} logData.reason - Reason for moderation
 * @param {string} logData.botId - Bot's Roblox ID
 * @returns {Promise<string>} ID of the created log
 */
export async function logModeration(logData) {
  try {
    if (!logData.groupId || !logData.robloxId || !logData.type || !logData.botId) {
      throw new Error("Missing required log data");
    }

    // Valid log types
    const validTypes = ["deletion", "exile", "ban", "demotion"];
    if (!validTypes.includes(logData.type)) {
      throw new Error(`Invalid log type: ${logData.type}. Must be one of: ${validTypes.join(", ")}`);
    }

    // Create log entry
    const logEntry = {
      ...logData,
      issuedDate: admin.firestore.FieldValue.serverTimestamp(),
      robloxId: logData.robloxId.toString() // Ensure robloxId is a string
    };

    // Add to Firestore
    const docRef = await db.collection("logs").add(logEntry);
    console.log(`Created moderation log: ${docRef.id} (${logData.type})`);
    
    return docRef.id;
  } catch (error) {
    console.error("Error logging moderation action:", error);
    throw error;
  }
}

export async function updateSubscriptionGroup(discordId, oldGroupId, newGroupId) {
  try {
    if (!discordId || !oldGroupId || !newGroupId) {
      throw new Error("discordId, oldGroupId, and newGroupId are required");
    }

    // Get the subscription document
    const subscriptionsSnapshot = await subscriptionsCollection
      .where("discordId", "==", discordId)
      .where("groupId", "==", oldGroupId)
      .get();

    if (subscriptionsSnapshot.empty) {
      throw new Error("No subscription found");
    }

    // Update the subscription with the new group ID
    const updatePromises = subscriptionsSnapshot.docs.map((doc) =>
      doc.ref.update({
        groupId: newGroupId,
      })
    );

    await Promise.all(updatePromises);
    console.log(
      `Updated subscription group for discord ID ${discordId} from ${oldGroupId} to ${newGroupId}`
    );
  } catch (error) {
    console.error("Error updating subscription group:", error);
    throw error;
  }
}

export async function updateModerationCriteria(discordId, groupId, newCriteria) {
  try {
    if (!discordId || !groupId || !newCriteria) {
      throw new Error("discordId, groupId, and newCriteria are required");
    }

    const subscriptionsSnapshot = await subscriptionsCollection
      .where("discordId", "==", discordId)
      .where("groupId", "==", groupId)
      .get();

    if (subscriptionsSnapshot.empty) {
      throw new Error("No subscription found");
    }

    const updatePromises = subscriptionsSnapshot.docs.map((doc) =>
      doc.ref.update({
        moderationPrompt: newCriteria,
      })
    );

    await Promise.all(updatePromises);
    console.log(
      `Updated moderation criteria for discord ID ${discordId} and group ${groupId}`
    );
  } catch (error) {
    console.error("Error updating moderation criteria:", error);
    throw error;
  }
}

export async function updateSubscriptionEndDate(discordId, groupId, endDate) {
  try {
    if (!discordId || !groupId || !endDate) {
      throw new Error("discordId, groupId, and endDate are required");
    }

    const subscriptionsSnapshot = await subscriptionsCollection
      .where("discordId", "==", discordId)
      .where("groupId", "==", groupId)
      .get();

    if (subscriptionsSnapshot.empty) {
      throw new Error("No subscription found");
    }

    const updatePromises = subscriptionsSnapshot.docs.map((doc) =>
      doc.ref.update({
        endDate: admin.firestore.Timestamp.fromDate(endDate),
        cancelled: true
      })
    );

    await Promise.all(updatePromises);
    console.log(
      `Marked subscription as cancelled for discord ID ${discordId} and group ${groupId}, ending on ${endDate}`
    );
    return true;
  } catch (error) {
    console.error("Error updating subscription end date:", error);
    throw error;
  }
}

export async function getModerationCriteria(discordId, groupId) {
  try {
    if (!discordId || !groupId) {
      throw new Error("discordId and groupId are required");
    }

    // Get the subscription document
    const subscriptionsSnapshot = await subscriptionsCollection
      .where("discordId", "==", discordId)
      .where("groupId", "==", groupId)
      .get();

    if (subscriptionsSnapshot.empty) {
      return null;
    }

    // Return the moderation prompt from the first matching subscription
    return subscriptionsSnapshot.docs[0].data().moderationPrompt;
  } catch (error) {
    console.error("Error getting moderation criteria:", error);
    throw error;
  }
}

export async function getSubscription(discordId, groupId) {
  try {
    if (!discordId || !groupId) {
      throw new Error("discordId and groupId are required");
    }

    const subscriptionsSnapshot = await subscriptionsCollection
      .where("discordId", "==", discordId)
      .where("groupId", "==", groupId)
      .limit(1)
      .get();

    if (subscriptionsSnapshot.empty) {
      return null;
    }

    // Return the first matching subscription (should only be one)
    return {
      id: subscriptionsSnapshot.docs[0].id,
      ...subscriptionsSnapshot.docs[0].data(),
    };
  } catch (error) {
    console.error("Error getting subscription:", error);
    return null;
  }
}

export async function getAllSubscriptions() {
  try {
    // Get the subscription document
    const subscriptionsSnapshot = await subscriptionsCollection
      .get();

    const subs = [];
    for (const subscription of subscriptionsSnapshot.docs) {
      const data = subscription.data();
      const sub = {
        discordId: data.discordId,
        endDate: data.endDate,
        groupId: data.groupId,
        subscriptionId: data.subscriptionId,
        stripe: data.stripe,
        channelId: data.channelId,
        createdAt: data.createdAt,
        startDate: data.startDate,
        moderationPrompt: data.moderationPrompt
      }
      subs.push(sub)
    }
    return subs;
  } catch (error) {
    console.error("Error getting subscription:", error);
    throw error;
  }
}

getAllSubscriptions().then(result =>
  console.log(result)
)

export async function getSubscriptionByGroup(groupId) {
  try {
    if (!groupId) {
      throw new Error("groupId is required");
    }

    // Get the subscription document
    const subscriptionsSnapshot = await subscriptionsCollection
      .where("groupId", "==", groupId)
      .limit(1)
      .get();

    // Check if any subscriptions were found
    if (subscriptionsSnapshot.empty) {
      console.log(`No subscription found for group ${groupId}`);
      return null;
    }

    // Return the first (and should be only) subscription
    const subscription = subscriptionsSnapshot.docs[0].data();
    console.log(subscription);
    return {
      ...subscription,
      id: subscriptionsSnapshot.docs[0].id,
      discordId: subscription.discordId,
      channelId: subscription.channelId,
      stripeCustomerId: subscription.discordId,
      moderationPrompt: subscription.moderationPrompt // Just return the Discord ID as the Stripe customer ID
    };
  } catch (error) {
    console.error("Error getting subscription:", error);
    throw error;
  }
}

export async function updateModerationServices(discordId, groupId, services) {
  try {
    if (!discordId || !groupId || !services || !Array.isArray(services)) {
      throw new Error("discordId, groupId, and services array are required");
    }

    // Validate that services contains valid options
    const validServices = ["deletions", "exiles", "demotions"];
    const validatedServices = services.filter(service => validServices.includes(service));

    if (validatedServices.length === 0) {
      validatedServices.push("deletions"); // At minimum, include deletions service
    }

    // Get the subscription documents
    const subscriptionsSnapshot = await subscriptionsCollection
      .where("discordId", "==", discordId)
      .where("groupId", "==", groupId)
      .get();

    if (subscriptionsSnapshot.empty) {
      throw new Error("No subscription found");
    }

    // Update the moderationServices field for each matching subscription
    const updatePromises = subscriptionsSnapshot.docs.map((doc) =>
      doc.ref.update({
        moderationServices: validatedServices,
      })
    );

    await Promise.all(updatePromises);
    
    console.log(`Updated moderation services for discord ID ${discordId} and group ${groupId} to:`, validatedServices);
    return validatedServices;
  } catch (error) {
    console.error("Error updating moderation services:", error);
    throw error;
  }
}

export default {
  addSubscription,
  cancelSubscription,
  getSubscribedGroups,
  getLogs,
  updateSubscriptionGroup,
  updateModerationCriteria,
  updateSubscriptionEndDate,
  updateModerationServices,
  getModerationCriteria,
  getSubscription,
  getSubscriptionByGroup
};
