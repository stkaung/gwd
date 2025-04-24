import { config } from "dotenv";
config();
import Stripe from "stripe";
import { 
  addSubscription, 
  cancelSubscription, 
  getSubscription, 
  updateSubscriptionEndDate,
  subscriptionsCollection, // Import the subscriptions collection
  getModerationCriteria
} from "./firebaseService.js";
import { createPrivateChannelAndSendDM, getDiscordUser } from "../bot.js";
import { leaveGroup } from "./nobloxService.js";
import { getPlayerThumbnail } from "./nobloxService.js";
import { EmbedBuilder } from "discord.js";
import admin from "firebase-admin";

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Create Stripe checkout session for subscription
export async function createCheckoutSession(
  discordUserId,
  groupId,
  moderationPrompt,
  moderationServices = ["deletions"]
) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: "Group Wall Defender Subscription",
            description: "Includes 1-month free trial, then $10/month"
          },
          unit_amount: 1000, // $10.00 USD in cents
          recurring: {
            interval: "month",
            interval_count: 1,
          },
        },
        quantity: 1,
      },
    ],
    mode: "subscription",
    metadata: {
      discordUserId: discordUserId,
      groupId: groupId,
      moderationPrompt: moderationPrompt,
      moderationServices: JSON.stringify(moderationServices)
    },
    success_url: `https://discord.com/app`,
    cancel_url: `https://discord.com/app`,
    subscription_data: {
      trial_period_days: 30, // 1-month free trial for all subscriptions
    },
  });

  return session;
}

export async function cancelStripeSubscription(id) {
  try {
    const cancel = await stripe.subscriptions.cancel(id);
    return cancel;
  } catch (error) {
    console.log(error);
  }
}

// Create a billing portal session for customer to manage their subscription
export async function createBillingPortalSession(stripeCustomerId) {
  try {
    if (!stripeCustomerId) {
      throw new Error("Stripe customer ID is required");
    }
    
    try {
      // Try to create a billing portal session
      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: 'https://discord.com/app',
      });
      
      return session;
    } catch (portalError) {
      // If billing portal isn't configured, fall back to a checkout session with mode="setup"
      if (portalError.type === 'StripeInvalidRequestError' && 
          portalError.message.includes('configuration')) {
        console.log("Billing portal not configured, falling back to checkout session");
        
        // Create a session with setup mode instead
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'setup',
          customer: stripeCustomerId,
          success_url: 'https://discord.com/app',
          cancel_url: 'https://discord.com/app'
        });
        
        return { 
          url: session.url,
          fallback: true
        };
      }
      
      // Re-throw other errors
      throw portalError;
    }
  } catch (error) {
    console.error("Error creating billing portal session:", error);
    throw error;
  }
}

// Handle Stripe webhook
export async function handleWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    // Verify the webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error(`Webhook error: ${err.message}`);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  let action = null;

  switch (event.type) {
    case "checkout.session.completed":
      const session = event.data.object;
      const { discordUserId, groupId, moderationPrompt } = session.metadata;
      console.log(session);

      console.log(
        `Subscription completed for Discord user ${discordUserId} and group ${groupId}`
      );

      action = {
        type: "createChannel",
        discordUserId: discordUserId,
        groupId: groupId,
      };
      const user = await getDiscordUser(discordUserId);
      console.log(user);
      // Get the user's Roblox profile picture
      const pfp = await getPlayerThumbnail(user.robloxId);
      await createPrivateChannelAndSendDM(
        user,
        moderationPrompt,
        discordUserId,
        groupId,
        session.subscription
      );

      break;

    case "customer.subscription.deleted":
      const subscriptionDeleted = event.data.object;
      const stripeSubId = subscriptionDeleted.id;
      
      try {
        console.log(`Processing subscription deletion for stripe ID: ${stripeSubId}`);
        
        // Find the subscription by Stripe ID in Firestore
        const subSnapshot = await subscriptionsCollection
          .where("stripe", "==", stripeSubId)
          .limit(1)
          .get();
        
        if (subSnapshot.empty) {
          console.log(`No subscription found with Stripe ID: ${stripeSubId}`);
          break;
        }
        
        const subscription = subSnapshot.docs[0].data();
        const discordId = subscription.discordId;
        const groupId = subscription.groupId;
        const channelId = subscription.channelId;
        
        console.log(`Found subscription for Discord user ${discordId}, group ${groupId}`);
        
        // Cancel the subscription in Firestore
        await cancelSubscription(discordId, groupId);
        
        // Leave the Roblox group
        await leaveGroup(groupId);
        
        // Delete Discord channel if it exists
        if (channelId) {
          try {
            const client = (await import("../bot.js")).client;
            const channel = await client.channels.fetch(channelId);
            if (channel) {
              // Send message before deletion
              await channel.send("This channel is being deleted because your subscription has ended.");
              // Wait 5 seconds to allow users to see the message
              await new Promise(resolve => setTimeout(resolve, 5000));
              // Delete the channel
              await channel.delete("Subscription ended");
              console.log(`Deleted channel ${channelId} for ended subscription`);
            }
          } catch (channelError) {
            console.error(`Error deleting channel for ended subscription:`, channelError);
          }
        }
      } catch (error) {
        console.error("Error handling subscription deletion:", error);
      }

      break;
      
    // Handle invoice paid events for renewal notifications  
    case "invoice.paid":
      try {
        const invoice = event.data.object;
        // Only process subscription invoice payments
        if (invoice.subscription) {
          // Get the subscription details
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          
          // Only handle renewal invoices (not the first payment)
          if (subscription.metadata && 
              subscription.metadata.discordUserId && 
              subscription.metadata.groupId &&
              invoice.billing_reason === "subscription_cycle") {
            
            const { discordUserId: userId, groupId: subGroupId } = subscription.metadata;
            
            // Get the user's channel to notify them
            const userSubscription = await getSubscription(userId, subGroupId);
            
            if (userSubscription && userSubscription.channelId) {
              // Try to fetch the channel
              try {
                const client = (await import("../bot.js")).client;
                const channel = await client.channels.fetch(userSubscription.channelId);
                
                // Calculate next billing date
                const nextBillingDate = new Date(subscription.current_period_end * 1000);
                const formattedDate = nextBillingDate.toLocaleDateString('en-US', { 
                  year: 'numeric', 
                  month: 'long', 
                  day: 'numeric' 
                });
                
                // Create renewal notification
                const renewalEmbed = new EmbedBuilder()
                  .setColor(0x00ff00)
                  .setTitle("💳 Subscription Renewed")
                  .setDescription(`Your Group Wall Defender subscription has been automatically renewed.

**Payment details:**
• Amount: $${(invoice.amount_paid / 100).toFixed(2)} USD
• Next billing date: ${formattedDate}

Your subscription will continue to protect your Roblox group without interruption. Thank you for your continued business!

If you have any questions about your subscription, you can access your billing portal anytime using the \`/billing\` command.`)
                  .setTimestamp()
                  .setFooter({ text: "Group Wall Defender Billing" });
                  
                await channel.send({ embeds: [renewalEmbed] });
              } catch (error) {
                console.error("Error sending renewal notification:", error);
              }
            }
          }
        }
      } catch (error) {
        console.error("Error handling invoice.paid event:", error);
      }
      break;
      
    // Handle subscription updates  
    case "customer.subscription.updated":
      try {
        const updatedSubscription = event.data.object;
        
        // Skip if no metadata is available
        if (!updatedSubscription.metadata || 
            !updatedSubscription.metadata.discordUserId || 
            !updatedSubscription.metadata.groupId) {
          console.log("Subscription updated but no metadata available");
          break;
        }
        
        const { discordUserId: userId, groupId: subscriptionGroupId } = updatedSubscription.metadata;
        
        // Get the user's channel to notify them
        const subscription = await getSubscription(userId, subscriptionGroupId);
        
        if (subscription && subscription.channelId) {
          // Try to fetch the channel
          try {
            const client = (await import("../bot.js")).client;
            const channel = await client.channels.fetch(subscription.channelId);
            
            // Create appropriate message based on status changes
            let embed;
            
            // Handle payment method update
            if (event.data.previous_attributes.default_payment_method) {
              embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle("💳 Payment Method Updated")
                .setDescription("Your payment method has been successfully updated. Thank you for keeping your billing information current.")
                .setTimestamp()
                .setFooter({ text: "Stripe Billing Portal" });
                
              // Add extra details for users who had payment failures before
              if (updatedSubscription.status === "active" && event.data.previous_attributes.status === "past_due") {
                embed.setTitle("💳 Payment Method Updated and Payment Successful!")
                  .setDescription(`Your payment method has been successfully updated and your pending payment has been processed. Thank you!

**What this means:**
• Your account is now current and in good standing
• All subscription features are fully active
• Your payment information has been securely saved for future billing

Group Wall Defender will continue protecting your group without interruption.`);
              }
                
              await channel.send({ embeds: [embed] });
            }
            
            // Handle status change
            if (event.data.previous_attributes.status) {
              const oldStatus = event.data.previous_attributes.status;
              const newStatus = updatedSubscription.status;
              
              let color = 0x0000ff; // Default blue
              let title = `Subscription Status Changed: ${oldStatus} → ${newStatus}`;
              let description = `Your subscription status has changed from ${oldStatus} to ${newStatus}.`;
              
              // Customize message based on new status
              if (newStatus === "past_due") {
                const paymentIntent = updatedSubscription.latest_invoice ? 
                  await stripe.invoices.retrieve(updatedSubscription.latest_invoice) : null;
                const attemptCount = paymentIntent?.attempt_count || 1;
                
                // Different messaging based on attempt count
                if (attemptCount <= 1) {
                  color = 0xffaa00; // Orange for first attempt
                  title = "⚠️ Payment Failed";
                  description = `We were unable to process your payment for the Group Wall Defender subscription.

**What happened?**
Your latest payment attempt did not go through. This could be due to:
• Expired card
• Insufficient funds
• Bank decline
• Outdated billing information

**What to do next:**
1. Please update your payment method by running \`/billing\` in this channel
2. We'll automatically try to charge your card again in a few days
                  
**Important:** If your payment continues to fail, your subscription will be cancelled and your access to the service will end. Please update your payment method as soon as possible to avoid interruption.`;
                } else if (attemptCount <= 2) {
                  color = 0xff7700; // Darker orange for second attempt
                  title = "⚠️ Payment Failed - Second Attempt";
                  description = `We've made a second attempt to charge your payment method, but it was unsuccessful.

**Please take immediate action:**
Your subscription is at risk of being cancelled. To maintain your group moderation service:
1. Run \`/billing\` to update your payment details
2. Ensure your card has sufficient funds
3. Verify your billing address is correct

We'll make one final attempt to charge your card in the coming days. If this fails, your subscription will be cancelled and access to this service will end.`;
                } else {
                  color = 0xff0000; // Red for final attempt
                  title = "🚨 URGENT: Final Payment Notice";
                  description = `**Critical subscription notice - Immediate action required**

We've attempted to charge your payment method multiple times without success. Your subscription is now in critical status.

**Final notice:**
• This is the final payment attempt
• If payment fails again, your subscription will be cancelled automatically
• Your service will end and this channel will be deleted

Please run \`/billing\` immediately to update your payment information or your service will be terminated within 48 hours.`;
                  
                  // Schedule final cancellation after 48 hours if still past_due
                  setTimeout(async () => {
                    try {
                      // Re-check subscription status
                      const currentSub = await getSubscription(userId, subscriptionGroupId);
                      const stripeData = await stripe.subscriptions.retrieve(currentSub.stripe);
                      
                      if (stripeData.status === "past_due") {
                        // If still past due after 48 hours, cancel subscription
                        await stripe.subscriptions.cancel(currentSub.stripe);
                        
                        const finalEmbed = new EmbedBuilder()
                          .setColor(0xff0000)
                          .setTitle("❌ Subscription Cancelled - Payment Failure")
                          .setDescription(`Your subscription has been cancelled due to continued payment failures.

Your access to this service will end shortly, and this channel will be deleted. The bot will also leave your group.

If you wish to resubscribe in the future, you can use the subscription command in our main server.

Thank you for your time with Group Wall Defender.`)
                          .setTimestamp()
                          .setFooter({ text: "This channel will be deleted in 24 hours" });
                          
                        await channel.send({ embeds: [finalEmbed] });
                        
                        // Schedule channel deletion after 24 hours
                        setTimeout(async () => {
                          try {
                            // Last check before deletion
                            const finalSub = await getSubscription(userId, subscriptionGroupId);
                            if (finalSub) {
                              // Notify about imminent deletion
                              await channel.send("This channel is now being deleted due to payment failure.");
                              
                              // Remove subscription from database
                              await cancelSubscription(userId, subscriptionGroupId);
                              
                              // Leave Roblox group
                              await leaveGroup(subscriptionGroupId);
                              
                              // Delete the Discord channel
                              await new Promise(resolve => setTimeout(resolve, 5000));
                              await channel.delete("Subscription cancelled due to payment failure");
                            }
                          } catch (error) {
                            console.error("Error during final channel cleanup:", error);
                          }
                        }, 24 * 60 * 60 * 1000); // 24 hours
                      }
                    } catch (error) {
                      console.error("Error handling final payment notification:", error);
                    }
                  }, 48 * 60 * 60 * 1000); // 48 hours
                }
              } else if (newStatus === "active" && oldStatus === "past_due") {
                color = 0x00ff00; // Green
                title = "✅ Payment Successful!";
                description = `Great news! Your payment has been successfully processed and your subscription is now active again.

**What this means:**
• Your subscription is current and in good standing
• All Group Wall Defender services will continue uninterrupted
• Your group wall will remain protected

Thank you for your prompt attention to this matter. We appreciate your continued trust in our service.

If you have any questions about your subscription, you can access your billing portal anytime using the \`/billing\` command.`;
              } else if (newStatus === "canceled") {
                color = 0xff0000; // Red
                title = "❌ Subscription Canceled";
                
                // Get the current period end to tell user when channel will be deleted
                const periodEnd = new Date(updatedSubscription.current_period_end * 1000);
                const formattedDate = periodEnd.toLocaleDateString('en-US', { 
                  weekday: 'long', 
                  year: 'numeric', 
                  month: 'long', 
                  day: 'numeric' 
                });
                const formattedTime = periodEnd.toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZoneName: 'short'
                });
                
                // Discord timestamp for exact time
                const timestamp = Math.floor(periodEnd.getTime() / 1000);
                
                description = `Your subscription has been canceled. 

**You will retain access until the end of your current billing period:**
• Date: ${formattedDate}
• Time: ${formattedTime}
• Exact time: <t:${timestamp}:F>

At that time, your channel will be automatically deleted and the bot will be removed from your group.

We're sorry to see you go! If you change your mind before the subscription ends, you can reactivate it through the billing portal using \`/billing\`.

Thank you for being a valued customer. If you'd like to share feedback on how we can improve, please reach out to our staff.`;

                // Store the scheduled deletion time in Firebase
                await updateSubscriptionEndDate(userId, subscriptionGroupId, periodEnd);
                
                // Schedule the channel for deletion at end of billing period
                const deleteAt = periodEnd.getTime() - Date.now();
                if (deleteAt > 0) {
                  setTimeout(async () => {
                    try {
                      // Double-check subscription status before deletion
                      const currentSub = await getSubscription(userId, subscriptionGroupId);
                      if (currentSub && currentSub.cancelled) {
                        // Delete the channel
                        try {
                          const channelToDelete = await client.channels.fetch(subscription.channelId);
                          if (channelToDelete) {
                            await channelToDelete.send({
                              content: "This channel is now being deleted as your subscription period has ended."
                            });
                            await new Promise(resolve => setTimeout(resolve, 5000)); // Give them 5 seconds to read
                            await channelToDelete.delete("Subscription period ended");
                          }
                        } catch (channelError) {
                          console.error("Error deleting channel:", channelError);
                        }
                        
                        // Leave the group
                        await leaveGroup(subscriptionGroupId);
                        
                        // Remove the subscription from Firebase
                        await cancelSubscription(userId, subscriptionGroupId);
                        
                        // Stop monitoring the group
                        const { stopMonitoringGroup } = await import("./nobloxService.js");
                        stopMonitoringGroup(subscriptionGroupId);
                        
                        console.log(`Deleted channel and subscription for ${userId}, group ${subscriptionGroupId}`);
                      }
                    } catch (execError) {
                      console.error("Error executing scheduled deletion:", execError);
                    }
                  }, deleteAt);
                }
              } else if (newStatus === "active" && oldStatus === "canceled") {
                // Handle subscription renewal after cancellation
                color = 0x00ff00; // Green
                title = "🎉 Subscription Renewed!";
                description = `Great news! Your subscription has been successfully renewed.
                
**What this means:**
• Your subscription will continue without interruption
• Your channel will not be deleted
• The bot will continue to monitor and protect your group
• All Group Wall Defender services remain fully active

Thank you for choosing to continue with us. We appreciate your business and will continue 
providing excellent service for your Roblox group.

We've removed the scheduled cancellation from your account, and you'll continue to be billed 
on your regular billing cycle.`;
                
                // Update Firebase to remove cancellation status
                try {
                  const subscriptionsSnapshot = await subscriptionsCollection
                    .where("discordId", "==", userId)
                    .where("groupId", "==", subscriptionGroupId)
                    .get();
                  
                  if (!subscriptionsSnapshot.empty) {
                    const updatePromises = subscriptionsSnapshot.docs.map((doc) =>
                      doc.ref.update({
                        cancelled: false,
                        endDate: null // Clear the end date since it's now active again
                      })
                    );
                    
                    await Promise.all(updatePromises);
                    console.log(`Subscription renewed for discord ID ${userId} and group ${subscriptionGroupId}`);
                  }
                } catch (renewalError) {
                  console.error("Error updating renewal status:", renewalError);
                }
              }
              
              embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(title)
                .setDescription(description)
                .setTimestamp()
                .setFooter({ text: "Stripe Billing Portal" });
                
              await channel.send({ embeds: [embed] });
            }
          } catch (error) {
            console.error("Error sending subscription update notification:", error);
          }
        }
      } catch (error) {
        console.error("Error handling subscription update webhook:", error);
      }
      break;

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });

  return action; // Returning the action object based on event type
}

export default { createCheckoutSession, handleWebhook };
