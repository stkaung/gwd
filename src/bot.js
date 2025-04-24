import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  ApplicationCommandOptionType,
} from "discord.js";
import { config } from "dotenv";
import {
  addSubscription,
  cancelSubscription,
  getSubscribedGroups,
  getLogs,
  updateSubscriptionGroup,
  updateModerationCriteria,
  updateModerationServices,
  getModerationCriteria,
  getSubscription,
  getAllSubscriptions,
  updateSubscriptionEndDate,
  getSubscriptionByGroup,
} from "./services/firebaseService.js";
import stripeService, {
  cancelStripeSubscription,
  createCheckoutSession,
  createBillingPortalSession,
} from "./services/stripeService.js";
import { getRobloxId } from "./services/bloxlinkService.js";
import {
  getIdFromUsername,
  getUsername,
  getGroupInfo,
  getOwnedGroups,
  initializeNoblox,
  monitorGroupWall,
  monitorMultipleGroupWalls,
  getPlayerThumbnail,
  activeMonitors,
  stopMonitoringGroup,
  leaveGroup
} from "./services/nobloxService.js";
import serverConfig from "./serverConfig.js";

config();

// Discord bot setup
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
});
client.tempData = {};
// Initialize the joinRequests Map to prevent undefined errors
client.joinRequests = new Map();

client.on("interactionCreate", async (interaction) => {
  try {
    // Handle button interactions
    if (interaction.isButton()) {
      if (interaction.customId === "subscribe") {
        await handleSubscribe(interaction);
      } else if (interaction.customId === "unsubscribe") {
        await handleUnsubscribe(interaction);
      } else if (interaction.customId === "service_continue") {
        await handleServiceContinue(interaction);
      } else if (interaction.customId.startsWith("service_")) {
        if (interaction.customId.startsWith("service_update_")) {
          // Handle service update buttons
          await handleServiceUpdateButtons(interaction);
        } else {
          await toggleServiceButton(interaction);
        }
      } else if (interaction.customId === "cancel_subscription_flow") {
        await handleCancelSubscriptionFlow(interaction);
      } else if (interaction.customId === "prev_log" || interaction.customId === "next_log") {
        // Handle log pagination
        const userId = interaction.user.id;
        const paginationData = interaction.client.logPagination?.[userId];
        
        if (!paginationData) {
          return interaction.reply({
            content: "❌ Pagination data not found. Please run the command again.",
            ephemeral: true
          });
        }
        
        // Update the current page
        if (interaction.customId === "next_log") {
          paginationData.currentPage++;
        } else {
          paginationData.currentPage--;
        }
        
        // Ensure page is within bounds
        if (paginationData.currentPage < 0) {
          paginationData.currentPage = 0;
        } else if (paginationData.currentPage >= paginationData.embeds.length) {
          paginationData.currentPage = paginationData.embeds.length - 1;
        }
        
        // Get current embed and update footer
        const currentEmbed = paginationData.embeds[paginationData.currentPage];
        currentEmbed.setFooter({
          text: `Log ${paginationData.currentPage + 1} of ${paginationData.embeds.length} for ${paginationData.username}`
        });
        
        // Update button states
        const paginationRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('prev_log')
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(paginationData.currentPage === 0), // Disable if on first page
          
          new ButtonBuilder()
            .setCustomId('next_log')
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(paginationData.currentPage === paginationData.embeds.length - 1) // Disable if on last page
        );
        
        // Update the message
        await interaction.update({
          embeds: [currentEmbed],
          components: [paginationRow]
        });
      }
      return; // Exit after handling button interactions
    }
    
    // Handle selection menu interactions
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "group_select") {
        await handleGroupSelect(interaction);
      }
      return; // Exit after handling select menu interactions
    }

    // Handle modal submissions
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "moderationPromptModal") {
        const moderationPrompt =
          interaction.fields.getTextInputValue("moderationPrompt");
        const userData = interaction.client.tempData?.[interaction.user.id];

        if (!userData) {
          return interaction.reply({
            content:
              "❌ Something went wrong. Please try the subscription process again.",
            ephemeral: true,
          }).catch(error => {
            console.error("Failed to reply to modal submission:", error);
          });
        }

        await handleModerationPrompt(
          interaction,
          interaction.user.id,
          userData.selectedGroupId,
          moderationPrompt,
        );
      }
      return; // Exit after handling modal submissions
    }
    
    // Only proceed to command handling if it's a command interaction
    if (!interaction.isCommand()) return;

    if (interaction.commandName === "logs") {
      try {
        // Check if command is used in a subscription channel
        const channel = interaction.channel;
        if (!channel.parent || channel.parent.id !== serverConfig.categoryId) {
          return interaction.reply({
            content:
              "❌ This command can only be used in subscription channels.",
            ephemeral: true,
          });
        }

        await interaction.deferReply();

        // Get the Roblox username from the command
        const robloxUsername = interaction.options.getString("username");

        try {
          // Convert username to ID using nobloxService
          const robloxId = await getIdFromUsername(robloxUsername);
          if (!robloxId) {
            return interaction.editReply({
              content: "❌ Could not find a Roblox user with that username.",
            });
          }

          // Get the group ID from the channel name
          const channelNameParts = channel.name.split("-");
          const groupId = channelNameParts[channelNameParts.length - 1];

          // Get logs using firebaseService
          const logs = await getLogs(groupId, robloxId.toString());

          if (logs.length === 0) {
            return interaction.editReply({
              content: `No moderation logs found for user **${robloxUsername}**.`,
            });
          }

          // Get the user's avatar
          const userThumbnail = await getPlayerThumbnail(robloxId);

          // Create embeds for each log
          const allEmbeds = await Promise.all(
            logs.map(async (log) => {
              const botUsername = await getUsername(log.botId);
              const groupInfo = await getGroupInfo(log.groupId);
              const robloxUsername = await getUsername(log.robloxId);
              
              // Set color based on log type
              let color;
              switch (log.type) {
                case "deletion":
                  color = 0xff6b6b; // Red for deletions
                  break;
                case "exile":
                  color = 0xe67e22; // Orange for exiles
                  break;
                case "demotion":
                  color = 0x3498db; // Blue for demotions
                  break;
                default:
                  color = 0x95a5a6; // Gray for unknown types
              }
              
              // Get a title that matches the action
              let actionTitle;
              switch (log.type) {
                case "deletion":
                  actionTitle = "Post Deletion";
                  break;
                case "exile":
                  actionTitle = "User Exile (Kick)";
                  break;
                case "demotion":
                  actionTitle = "Rank Demotion";
                  break;
                default:
                  actionTitle = "Moderation Action";
              }

              return new EmbedBuilder()
                .setColor(color)
                .setTitle(actionTitle)
                .setThumbnail(userThumbnail)
                .addFields(
                  { name: "Roblox Username", value: robloxUsername },
                  { name: "Group", value: groupInfo.name },
                  { name: "Type", value: log.type.charAt(0).toUpperCase() + log.type.slice(1) },
                  {
                    name: "Details",
                    value: log.message || "No details provided",
                  },
                  { name: "Reason", value: log.reason },
                  { name: "Moderation Bot", value: botUsername },
                  {
                    name: "Issued Date",
                    value: log.issuedDate.toDate().toLocaleString(),
                  },
                );
            }),
          );

          // Set up pagination if there are more than 1 log
          if (allEmbeds.length > 1) {
            // Store pagination data in client for this user
            interaction.client.logPagination = interaction.client.logPagination || {};
            interaction.client.logPagination[interaction.user.id] = {
              embeds: allEmbeds,
              currentPage: 0,
              username: robloxUsername
            };
            
            // Create pagination buttons
            const paginationRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('prev_log')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true), // Disabled on first page
              
              new ButtonBuilder()
                .setCustomId('next_log')
                .setLabel('Next')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(allEmbeds.length <= 1), // Disabled if only one page
            );
            
            // Add page indicator to first embed
            const firstEmbed = allEmbeds[0];
            firstEmbed.setFooter({
              text: `Log 1 of ${allEmbeds.length} for ${robloxUsername}`
            });
            
            await interaction.editReply({
              embeds: [firstEmbed],
              components: [paginationRow]
            });
          } else {
            // Only one log, no pagination needed
            await interaction.editReply({ embeds: allEmbeds });
          }
        } catch (error) {
          console.error("Error fetching Roblox user:", error);
          return interaction.editReply({
            content:
              "❌ An error occurred while fetching the user information.",
          });
        }
      } catch (error) {
        console.error("Error handling logs command:", error);
        return interaction.editReply({
          content: "❌ An error occurred while fetching the logs.",
        });
      }
    }
    
    else if (interaction.commandName === "unsubscribe") {
      try {
        await handleUnsubscribe(interaction);
      } catch (error) {
        console.error("Error handling unsubscribe command:", error);
        return interaction.editReply({
          content: "❌ An error occurred while processing your request.",
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "give-access") {
      // Check if the user has the developer role
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!member.roles.cache.has(serverConfig.developerRoleId)) {
        return interaction.reply({
          content: "❌ You don't have permission to use this command. Only developers can grant free access.",
          ephemeral: true
        });
      }
      
      const user = interaction.options.getUser("user");
      const modPrompt = interaction.options.getString("moderation_prompt");
      const groupId = interaction.options.getNumber("group");
      
      // Get moderation service options
      const enableDeletions = interaction.options.getBoolean("deletions") !== false; // Default true if not specified
      const enableExiles = interaction.options.getBoolean("exiles") === true; // Default false
      const enableDemotions = interaction.options.getBoolean("demotions") === true; // Default false
      
      // Build services array
      const services = [];
      if (enableDeletions) services.push("deletions");
      if (enableExiles) services.push("exiles");
      if (enableDemotions) services.push("demotions");
      
      // Ensure deletions is always included as a minimum
      if (services.length === 0) services.push("deletions");
      
      const groupData = await getGroupInfo(groupId);
      const groupName = groupData.name;
      
      // Store data in tempData for both the admin and the target user
      interaction.client.tempData = {
        ...interaction.client.tempData,
        [interaction.user.id]: {
          groupId,
          groupName,
        },
        [user.id]: {
          groupId,
          groupName,
          services, // Use the selected services
        }
      };
      
      await interaction.deferReply({ ephemeral: true });
      
      try {
        await createPrivateChannelAndSendDM(
          user,
          modPrompt,
          user.id,
          groupId,
          "free_access" // Special identifier for free access
        );
        
        // Include services in the success message
        const servicesText = [
          `Deletions: ${services.includes("deletions") ? "✅" : "❌"}`,
          `Exiles: ${services.includes("exiles") ? "✅" : "❌"}`,
          `Demotions: ${services.includes("demotions") ? "✅" : "❌"}`
        ].join(", ");
        
        await interaction.editReply({
          content: `✅ Access granted to ${user.tag} for group ${groupName}\nEnabled services: ${servicesText}`,
          ephemeral: true
        });
      } catch (error) {
        console.error("Error giving access:", error);
        await interaction.editReply({
          content: `❌ Error granting access: ${error.message}`,
          ephemeral: true
        });
      }
    }
    
    else if (interaction.commandName === "remove-access") {
      try {
        // Check if the user has the developer role
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(serverConfig.developerRoleId)) {
          return interaction.reply({
            content: "❌ You don't have permission to use this command. Only developers can remove access.",
            ephemeral: true
          });
        }
        
        // Check if command is used in a subscription channel
        const channel = interaction.channel;
        if (!channel.parent || channel.parent.id !== serverConfig.categoryId) {
          return interaction.reply({
            content:
              "❌ This command can only be used in subscription channels.",
            ephemeral: true,
          });
        }

        // Get the group ID and name from the channel name
        const channelNameParts = channel.name.split("-");
        const groupId = channelNameParts[channelNameParts.length - 1];
        const groupInfo = await getGroupInfo(groupId);
        
        // Get channel owner information from channel name and permissions
        const channelOwnerUsername = channelNameParts[0]; // First part of channel name should be username
        
        // Find the Discord user with permission to the channel (excluding the bot and admin)
        const permissionOverwrites = channel.permissionOverwrites.cache;
        let channelOwnerId = null;
        
        for (const [id, overwrite] of permissionOverwrites) {
          // Skip the bot and the everyone role
          if (id === client.user.id || id === channel.guild.id) continue;
          
          // Check if this user has view channel permission
          if (overwrite.allow.has("ViewChannel")) {
            channelOwnerId = id;
            break;
          }
        }
        
        if (!channelOwnerId) {
          return interaction.reply({
            content: "❌ Could not identify the channel owner. Please contact a developer.",
            ephemeral: true
          });
        }
        
        // Store the channel owner's ID in tempData for the unsubscribe handler
        interaction.client.tempData = {
          ...interaction.client.tempData,
          channelOwnerId,
          isAdminRemoval: true // Flag to indicate this is an admin removing access
        };

        // Create confirmation embed
        const confirmEmbed = new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle("⚠️ Remove Access")
          .setDescription(
            `Are you sure you want to remove access for **${channelOwnerUsername}** to group **${groupInfo.name}**?\n\nThis will:\n• Cancel their subscription\n• Delete this channel\n• Remove all associated data\n• Stop bot monitoring if no other users have this group`,
          )
          .setFooter({ text: "This action cannot be undone!" });

        // Create confirm and cancel buttons
        const confirmButton = new ButtonBuilder()
          .setCustomId("confirm_unsubscribe")
          .setLabel("Remove Access")
          .setStyle(ButtonStyle.Danger);

        const cancelButton = new ButtonBuilder()
          .setCustomId("cancel_unsubscribe")
          .setLabel("Keep Access")
          .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(
          confirmButton,
          cancelButton,
        );

        // Send the confirmation message
        await interaction.reply({
          embeds: [confirmEmbed],
          components: [row],
        });
      } catch (error) {
        console.error("Error handling remove access command:", error);
        return interaction.reply({
          content: "❌ An error occurred while processing your request.",
          ephemeral: true,
        });
      }
    }

    // Handle billing portal command
    if (interaction.commandName === "billing") {
      try {
        // Check if command is used in a subscription channel
        const channel = interaction.channel;
        if (!channel.parent || channel.parent.id !== serverConfig.categoryId) {
          return interaction.reply({
            content: "❌ This command can only be used in subscription channels.",
            ephemeral: true,
          });
        }

        await interaction.deferReply({ ephemeral: true });

        // Get the group ID from the channel name
        const channelNameParts = channel.name.split("-");
        const groupId = channelNameParts[channelNameParts.length - 1];

        // Get the subscription from Firebase
        const subscription = await getSubscription(interaction.user.id, groupId);
        
        if (!subscription || !subscription.stripe) {
          return interaction.editReply({
            content: "❌ Could not find an active subscription for this channel.",
          });
        }

        try {
          // Import Stripe directly in this handler to access Stripe object
          const Stripe = (await import('stripe')).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          
          // Get customer ID from Stripe subscription
          const stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripe);
          const customerId = stripeSubscription.customer;
          
          // Create billing portal session
          const portalSession = await createBillingPortalSession(customerId);
          
          // Different messaging based on whether we're using the full portal or fallback
          const isFallback = portalSession.fallback === true;
          
          // Check if subscription is past_due to modify messaging
          const isPastDue = stripeSubscription.status === "past_due";
          
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setURL(portalSession.url)
              .setLabel(isPastDue ? "Update Payment Method Now" : (isFallback ? "Update Payment Method" : "Manage Billing"))
          );

          // Create a response embed
          const billingEmbed = new EmbedBuilder()
            .setColor(isPastDue ? 0xff0000 : 0x4287f5)
            .setTitle(isPastDue ? "🚨 Payment Update Required" : (isFallback ? "💳 Update Payment Method" : "💳 Manage Your Subscription"))
            .setDescription(
              isPastDue ? 
              `**Your payment has failed and your subscription is at risk.**
              
              Please click the button below to update your payment method immediately. If your payment isn't updated soon, your subscription will be cancelled and you'll lose access to Group Wall Defender.
              
              After updating your payment method, we'll attempt to process your payment again.` :
              (isFallback ? 
              `Click the button below to update your payment method.
              
              Note: For full subscription management (viewing invoices, cancellation, etc.), please contact our support team.` :
              `Click the button below to manage your subscription details, including:
              
              • Update payment methods
              • View payment history
              • Change billing information
              • Cancel subscription
              
              Your session will expire after 30 minutes.`)
            )
            .setFooter({ text: "Powered by Stripe" });

          await interaction.editReply({
            embeds: [billingEmbed],
            components: [row],
          });
        } catch (error) {
          console.error("Error creating billing portal session:", error);
          await interaction.editReply({
            content:
              "❌ An error occurred while generating your billing portal link. Please try again later or contact support.",
          });
        }
      } catch (error) {
        console.error("Error creating billing portal session:", error);
        await interaction.editReply({
          content:
            "❌ An error occurred while generating your billing portal link. Please try again later or contact support.",
        });
      }
    }

    // Add the services command handler
    if (interaction.commandName === "services") {
      try {
        // Check if command is used in a subscription channel
        const channel = interaction.channel;
        if (!channel.parent || channel.parent.id !== serverConfig.categoryId) {
          return interaction.reply({
            content: "❌ This command can only be used in subscription channels.",
            ephemeral: true,
          });
        }

        // Get the group ID from the channel name
        const channelNameParts = channel.name.split("-");
        const groupId = channelNameParts[channelNameParts.length - 1];

        // Get subscription details
        const subscription = await getSubscription(interaction.user.id, groupId);
        
        if (!subscription) {
          return interaction.reply({
            content: "❌ Could not find subscription information for this channel.",
            ephemeral: true,
          });
        }

        // Get group info
        const groupInfo = await getGroupInfo(groupId);
        
        // Initialize services if not present
        const currentServices = subscription.moderationServices || ["deletions"];
        
        // Create service selection buttons
        const deletionsButton = new ButtonBuilder()
          .setCustomId("service_update_deletions")
          .setLabel("Post Deletions")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji(currentServices.includes("deletions") ? "☑️" : "⬜");
        
        const exilesButton = new ButtonBuilder()
          .setCustomId("service_update_exiles")
          .setLabel("Exiles (Kicks)")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji(currentServices.includes("exiles") ? "☑️" : "⬜");
        
        const demotionsButton = new ButtonBuilder()
          .setCustomId("service_update_demotions")
          .setLabel("Rank Demotions")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji(currentServices.includes("demotions") ? "☑️" : "⬜");
        
        const saveButton = new ButtonBuilder()
          .setCustomId("service_update_save")
          .setLabel("Save Changes")
          .setStyle(ButtonStyle.Success);
        
        const row1 = new ActionRowBuilder().addComponents(
          deletionsButton, exilesButton, demotionsButton
        );
        
        const row2 = new ActionRowBuilder().addComponents(saveButton);
        
        // Create the embed for service selection
        const servicesEmbed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle("🔧 Moderation Services Configuration")
          .setDescription(
            `Configure the moderation services for **${groupInfo.name}**.
            
            **Currently enabled services:**
            ${currentServices.includes("deletions") ? "✅" : "❌"} Post Deletions
            ${currentServices.includes("exiles") ? "✅" : "❌"} Exiles (Kicks)
            ${currentServices.includes("demotions") ? "✅" : "❌"} Rank Demotions
            
            Click on the buttons below to toggle services. When you're done, click "Save Changes".
            
            **Note:** Post Deletions is always enabled and cannot be disabled.`
          )
          .setFooter({ text: "Group Wall Defender" });
        
        // Store information about this update session
        interaction.client.tempData = interaction.client.tempData || {};
        interaction.client.tempData[interaction.user.id] = {
          groupId: groupId,
          groupName: groupInfo.name,
          services: [...currentServices], // Clone the array
          isServiceUpdate: true
        };
        
        await interaction.reply({
          embeds: [servicesEmbed],
          components: [row1, row2],
          ephemeral: true
        });
      } catch (error) {
        console.error("Error handling services command:", error);
        await interaction.reply({
          content: "❌ An error occurred while fetching your services configuration. Please try again.",
          ephemeral: true
        });
      }
    }

    if (interaction.customId === "confirm_unsubscribe") {
      try {
        await interaction.deferUpdate();
        
        // Get channel information
        const channel = interaction.channel;
        if (!channel || !channel.parent || channel.parent.id !== serverConfig.categoryId) {
          return interaction.followUp({
            content: "❌ This operation can only be performed in subscription channels.",
            ephemeral: true
          });
        }
        
        // Get the group ID from the channel name
        const channelNameParts = channel.name.split("-");
        const groupId = channelNameParts[channelNameParts.length - 1];
        
        // Check if this is an admin removing access for another user
        const isAdminRemoval = interaction.client.tempData?.isAdminRemoval === true;
        const userId = isAdminRemoval 
          ? interaction.client.tempData?.channelOwnerId 
          : interaction.user.id;
          
        if (!userId) {
          return interaction.followUp({
            content: "❌ Could not identify the user. Please try again.",
            ephemeral: true
          });
        }
        
        // Get the subscription from Firebase
        const subscription = await getSubscription(userId, groupId);
        
        if (!subscription) {
          return interaction.followUp({
            content: "❌ Could not find an active subscription for this channel.",
            ephemeral: true
          });
        }
        
        // If there's a Stripe subscription ID and it's not a free access subscription
        if (subscription.stripe && subscription.stripe !== "free_access") {
          // Cancel the Stripe subscription
          await cancelStripeSubscription(subscription.stripe);
        }
        
        // Cancel the subscription in Firebase
        await cancelSubscription(userId, groupId);
        
        // Remove monitoring for this group if no other users are subscribed
        try {
          const otherSubscriptionsForGroup = await getSubscriptionByGroup(groupId);
          if (otherSubscriptionsForGroup.length === 0) {
            // No other users have this group, stop monitoring
            await stopMonitoringGroup(groupId);
            await leaveGroup(groupId);
          }
        } catch (error) {
          console.error("Error checking other subscriptions:", error);
        }
        
        // Create a success embed
        const successEmbed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle("✅ Subscription Ended")
          .setDescription(isAdminRemoval 
            ? "Access has been successfully removed. This channel will be deleted in 10 seconds."
            : "Your subscription has been successfully ended. This channel will be deleted in 10 seconds."
          )
          .setFooter({ text: "Thank you for using Group Wall Defender" });
        
        await interaction.editReply({
          embeds: [successEmbed],
          components: []
        });
        
        // Wait 10 seconds and then delete the channel
        setTimeout(async () => {
          try {
            await channel.delete("Subscription ended");
          } catch (error) {
            console.error("Error deleting channel:", error);
          }
        }, 10000);
        
        // Clean up tempData
        if (isAdminRemoval) {
          delete interaction.client.tempData.channelOwnerId;
          delete interaction.client.tempData.isAdminRemoval;
        }
        
      } catch (error) {
        console.error("Error canceling subscription:", error);
        await interaction.followUp({
          content: "❌ An error occurred while canceling your subscription.",
          ephemeral: true
        });
      }
    } else if (interaction.customId === "cancel_unsubscribe") {
      // User decided to keep the subscription
      const cancelEmbed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("Subscription Maintained")
        .setDescription("You've chosen to keep your subscription. No changes have been made.");
      
      await interaction.update({
        embeds: [cancelEmbed],
        components: []
      });
      
      // Clean up tempData if this was an admin cancellation
      if (interaction.client.tempData?.isAdminRemoval) {
        delete interaction.client.tempData.channelOwnerId;
        delete interaction.client.tempData.isAdminRemoval;
      }
    }
  } catch (error) {
    console.error(`Error handling interaction: ${error.message}`, error);
    if (interaction.replied) {
      await interaction.followUp({
        content:
          "❌ An error occurred while processing your request. Please try again later.",
        ephemeral: true,
      });
    } else {
      await interaction.editReply({
        content:
          "❌ An error occurred while processing your request. Please try again later.",
        ephemeral: true,
      });
    }
  }
});

// Add this function to handle modal timeouts
client.on("modalTimeout", async (interaction) => {
  try {
    const userData = interaction.client.tempData?.[interaction.user.id];
    if (userData) {
      // Clean up stored data
      delete interaction.client.tempData[interaction.user.id];

      // Remove user from active subscriptions
      activeSubscriptions.delete(interaction.user.id);

      // Send cancellation message
      const dmChannel = await interaction.user.createDM();
      const cancelEmbed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle("Subscription Canceled")
        .setDescription(
          "The subscription process has been canceled due to inactivity. Feel free to try again!",
        )
        .setFooter({
          text: "Thank you for your time. We hope to see you soon!",
        });

      await dmChannel.send({ embeds: [cancelEmbed] });
    }
  } catch (error) {
    console.error("Error handling modal timeout:", error);
  }
});

const activeSubscriptions = new Set(); // Track users currently in the subscription flow
let subscriptionFlowMessages = []; // To store the message IDs for cancellation

async function handleSubscribe(interaction) {
  try {
    // Defer reply so user knows we are processing
    await interaction.deferReply({ ephemeral: true });

    // Check if the user is already in a subscription flow
    if (activeSubscriptions.has(interaction.user.id)) {
      return interaction.editReply(
        "⚠️ You are already in the middle of a subscription process. Please complete or cancel it first.",
      );
    }

    // Try to send a DM to the user
    const robloxId = await getRobloxId(
      interaction.guild.id,
      interaction.user.id,
    );

    // Check if user is verified
    if (!robloxId) {
      return interaction.editReply(
        "❌ You have not verified your Roblox account. Please do so by running `/verify` in #verify.",
      );
    }

    const robloxUsername = await getUsername(robloxId);

    // Get the user's groups and subscribed groups
    const ownedGroups = await getOwnedGroups(robloxId);
    const subscribedGroups = await getSubscribedGroups(interaction.user.id);

    // Convert group IDs to strings for comparison
    const ownedGroupIds = ownedGroups.map((group) => group.id.toString());
    const subscribedGroupIds = subscribedGroups.map((id) => id.toString());

    // Filter out the groups the user is already subscribed to
    const availableGroups = ownedGroups.filter(
      (group) => !subscribedGroupIds.includes(group.id.toString()),
    );

    // Check if there are any available groups to subscribe
    if (availableGroups.length === 0) {
      return interaction.editReply(
        "❌ All of your owned groups are already subscribed to Group Wall Defender. If you'd like to manage your existing subscriptions, please use the unsubscribe button.",
      );
    }

    // Mark the user as active in the subscription flow
    activeSubscriptions.add(interaction.user.id);

    // Create DM channel first
    const dmChannel = await interaction.user.createDM();

    // Create the welcome message with a cancel button
    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle("Subscription In Progress")
      .setDescription(
        `Hey there, ${robloxUsername}! **Thank you for considering subscribing to Group Wall Defender!** Let's get you started.\n\n` +
          `Our payments are processed **securely through Stripe**. If you have any concerns regarding payment or the service in general, **please do not hesitate to reach out to staff.**`,
      )
      .addFields({
        name: "Features Included:",
        value:
          "• Automated 24/7 group wall moderation\n" +
          "• AI-powered message analysis\n" +
          "• Custom moderation criteria\n" +
          "• Detailed moderation logs\n" +
          "• Private logging channel\n" +
          "• Rank management integration\n" +
          "• User history tracking\n" +
          "• Customizable actions (delete, rank changes, exiles)",
      })
      .setFooter({ text: "Brought to you by Group Wall Defender." });

    const cancelButton = new ButtonBuilder()
      .setCustomId("cancel_subscription_flow")
      .setLabel("Cancel Subscription")
      .setStyle(ButtonStyle.Danger);

    const cancelActionRow = new ActionRowBuilder().addComponents(cancelButton);

    const welcomeMessage = await dmChannel.send({
      embeds: [welcomeEmbed],
      components: [cancelActionRow],
    });

    subscriptionFlowMessages.push(welcomeMessage.id);

    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Create dropdown options for available groups
    const options = availableGroups.map((group) => ({
      label: group.name,
      value: group.id.toString(),
      description: `Group ID: ${group.id}`,
    }));

    const selectionEmbed = new EmbedBuilder()
      .setColor(0x0000ff)
      .setTitle("Select a Group")
      .setDescription(
        "Please choose the group you want to subscribe with from the dropdown below.",
      )
      .setFooter({ text: "Brought to you by Group Wall Defender." });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("group_select")
      .setPlaceholder("Select a group")
      .addOptions(options);

    const selectionRow = new ActionRowBuilder().addComponents(selectMenu);

    const selectionMessage = await dmChannel.send({
      embeds: [selectionEmbed],
      components: [selectionRow],
    });

    subscriptionFlowMessages.push(selectionMessage.id);

    // Clear the deferred reply with a success message
    await interaction.editReply(
      "✅ Check your DMs to continue the subscription process!",
    );
  } catch (error) {
    console.error("Error in subscription flow:", error);
    activeSubscriptions.delete(interaction.user.id);
    await interaction.editReply(
      "❌ An error occurred while processing your subscription.",
    );
  }
}

async function handleCancelSubscriptionFlow(interaction) {
  try {
    // Defer reply so user knows we are processing
    await interaction.deferReply({ ephemeral: true });

    // Send the cancellation message
    const dmChannel = await interaction.user.createDM();

    // Clear and delete any previous messages in the subscription flow
    for (const messageId of subscriptionFlowMessages) {
      try {
        const message = await dmChannel.messages.fetch(messageId);
        if (message) {
          await message.delete();
        }
      } catch (error) {
        console.error(`Failed to delete message with ID ${messageId}:`, error);
      }
    }

    // Clear the stored message IDs after deletion
    subscriptionFlowMessages = [];

    const cancelEmbed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("Subscription Canceled")
      .setDescription(
        "The subscription process has been successfully canceled. If you wish to try again later, feel free to reach out to us!",
      )
      .setFooter({
        text: "Thank you for your time. We hope to see you soon!",
      });

    await dmChannel.send({ embeds: [cancelEmbed] });

    activeSubscriptions.delete(interaction.user.id); // Remove the user from the active subscription flow
  } catch (error) {
    console.error("Error handling cancel subscription:", error);
    await interaction.followUp({
      content: "❌ An error occurred while canceling the subscription.",
      ephemeral: true,
    });
  }
}

async function handleUnsubscribe(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    // Check if command is used in a subscription channel
    const channel = interaction.channel;
    if (!channel.parent || channel.parent.id !== serverConfig.categoryId) {
      return interaction.editReply({
        content: "❌ This command can only be used in subscription channels.",
        ephemeral: true,
      });
    }

    // Get the group ID from the channel name
    const channelNameParts = channel.name.split("-");
    const groupId = channelNameParts[channelNameParts.length - 1];

    // Get subscription details
    const subscription = await getSubscription(interaction.user.id, groupId);
    
    if (!subscription || !subscription.stripe) {
      return interaction.editReply({
        content: "❌ Could not find an active subscription for this channel.",
      });
    }

    // Create confirmation embed
    const confirmEmbed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("⚠️ End Subscription")
      .setDescription(
        `Are you sure you want to end your subscription for **${channel.name}**?\n\nThis will:\n• Cancel your subscription at the end of the current billing period\n• Keep your channel active until then\n• Delete the channel when the period ends`,
      )
      .setFooter({ text: "You can reactivate your subscription using /billing before the period ends" });

    // Create confirm and cancel buttons
    const confirmButton = new ButtonBuilder()
      .setCustomId("confirm_unsubscribe")
      .setLabel("End Subscription")
      .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
      .setCustomId("cancel_unsubscribe")
      .setLabel("Keep Subscription")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(
      confirmButton,
      cancelButton,
    );

    // Send the confirmation message
    await interaction.editReply({
      embeds: [confirmEmbed],
      components: [row],
    });
  } catch (error) {
    console.error("Error handling unsubscribe command:", error);
    return interaction.editReply({
      content: "❌ An error occurred while processing your request.",
      ephemeral: true,
    });
  }
}

async function handleGroupSelect(interaction) {
  try {
    const selectedGroupId = interaction.values[0];
    const selectedGroup = interaction.component.options.find(
      (option) => option.value === selectedGroupId,
    );
    const selectedGroupName = selectedGroup
      ? selectedGroup.label
      : "Unknown Group";
      
    // Store the selected group ID in a way we can access it later
    interaction.client.tempData = {
      ...interaction.client.tempData,
      [interaction.user.id]: {
        selectedGroupId,
        selectedGroupName,
      },
    };
    
    // Create a services selection embed with checkboxes
    const servicesEmbed = new EmbedBuilder()
      .setColor(0x4287f5)
      .setTitle("Select Moderation Services")
      .setDescription(`What moderation services would you like the bot to provide for **${selectedGroupName}**?\n\nPlease select all that apply:`);
    
    // Create checkbox-style buttons for each service option
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("service_deletions")
        .setLabel("Post Deletions")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("☑️"),
      new ButtonBuilder()
        .setCustomId("service_exiles")
        .setLabel("Exiles")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("⬜"),
        new ButtonBuilder()
        .setCustomId("service_demotions")
        .setLabel("Rank Demotions")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("⬜"),
    );
    
    
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("service_continue")
        .setLabel("Continue")
        .setStyle(ButtonStyle.Success),
    );
    
    // Send the services selection message
    const dmChannel = await interaction.user.createDM();
    const serviceMessage = await dmChannel.send({
      embeds: [servicesEmbed],
      components: [row1, row2],
    });
    
    subscriptionFlowMessages.push(serviceMessage.id);
    
    // Acknowledge the selection to avoid the "This interaction failed" message
    await interaction.deferUpdate();
  } catch (error) {
    console.error("Error handling group selection:", error);
    if (!interaction.replied) {
      await interaction.reply({
        content:
          "❌ Failed to process your group selection. Please try again later.",
        ephemeral: true,
      });
    }
  }
}

async function promptForCustomInput(interaction, userId, groupId) {
  const modal = new ModalBuilder()
    .setCustomId("moderationPromptModal")
    .setTitle("Set Moderation Prompt")
    .addComponents(
      new TextInputBuilder()
        .setCustomId("moderationPrompt")
        .setLabel("Enter your moderation prompt:")
        .setStyle(TextInputStyle.Paragraph),
    );

  await interaction.showModal(modal);
  interaction.client.once("modalSubmit", async (modalInteraction) => {
    if (modalInteraction.customId === "moderationPromptModal") {
      const moderationPrompt =
        modalInteraction.fields.getTextInputValue("moderationPrompt");
      await handleModerationPrompt(
        modalInteraction,
        userId,
        groupId,
        moderationPrompt,
      );
    }
  });
}

async function handleModerationPrompt(
  interaction,
  userId,
  groupId,
  moderationPrompt,
) {
  try {
    // Defer the reply immediately to prevent the interaction from timing out
    await interaction.deferReply({ ephemeral: true });

    // Fetch the user object and guild member
    const user = await interaction.client.users.fetch(userId);
    const guild = await interaction.client.guilds.fetch(serverConfig.serverId);
    const member = await guild.members.fetch(userId);
    
    // Get selected moderation services from tempData
    const userData = interaction.client.tempData?.[userId];
    const moderationServices = userData?.services || ["deletions"];
    
    // Create checkout session with free trial
    const session = await createCheckoutSession(
      userId,
      groupId,
      moderationPrompt,
      moderationServices
    );
    
    // Create button with text that highlights the free trial
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(session.url)
        .setLabel("Start Free Trial"),
    );

    // Check if user has subscriber role, if not add it
    if (!member.roles.cache.has(serverConfig.subscriberRoleId)) {
      await member.roles.add(serverConfig.subscriberRoleId);
    }

    // Send payment link with free trial messaging
    await interaction.editReply({
      content: `Click the button below to start your **1-month free trial**.\n\nYou'll need to enter payment details, but you won't be charged until after the trial period ends. You can cancel anytime during the trial.`,
      components: [row],
      ephemeral: true,
    });
  } catch (error) {
    console.error("Error saving moderation prompt:", error);
    if (!interaction.replied) {
      await interaction.reply({
        content:
          "❌ Failed to save your moderation prompt. Please try again later.",
        ephemeral: true,
      });
    } else {
      await interaction.editReply({
        content:
          "❌ Failed to save your moderation prompt. Please try again later.",
        ephemeral: true,
      });
    }
  }
}

export async function getDiscordUser(userId) {
  try {
    const user = await client.users.fetch(userId);
    return user;
  } catch (error) {
    return error;
  }
}

export async function createPrivateChannelAndSendDM(
  user,
  moderationPrompt,
  discordUserId,
  groupId,
  subscription,
) {
  try {
    // Get the user's data from tempData
    console.log(client.tempData);
    const userData = client.tempData[user.id];
    console.log(userData);
    if (!userData) {
      throw new Error("User data not found.");
    }

    // Get Roblox info
    const guild = await client.guilds.fetch(serverConfig.serverId);
    const robloxId = await getRobloxId(guild.id, user.id);
    console.log(robloxId);
    const robloxUsername = await getUsername(robloxId);
    const groupInfo = await getGroupInfo(
      userData.selectedGroupId || userData.groupId,
    );

    // Get the user's Roblox profile picture
    const pfp = await getPlayerThumbnail(robloxId);

    // Send a success message in the user's DM
    const dmChannel = await user.createDM();
    const successEmbed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle("🎉 Subscription Successful! 🎉")
      .setDescription(
        `Congratulations, ${user.username}! Your subscription to Group Wall Defender for **${groupInfo.name}** is now active.\n\n**🎁 Your 1-month free trial has started!**\n\nYour custom moderation prompt has been successfully set as:\n\n**"${moderationPrompt}"**`,
      )
      .setFooter({ text: "Thank you for choosing Group Wall Defender! You won't be charged until after your trial period ends." });

    await dmChannel.send({ embeds: [successEmbed] });

    // Create channel name (replace spaces with hyphens and remove special characters)
    const channelName = `${robloxUsername}-${groupInfo.name}-${groupInfo.id}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .replace(/\s+/g, "-");

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: serverConfig.categoryId,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: ["ViewChannel"],
        },
        {
          id: user.id,
          allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
        },
        {
          id: guild.members.me.id,
          allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
        },
      ],
    });
    
    // Get selected moderation services, default to deletions if not specified
    const moderationServices = userData.services || ["deletions"];

    await addSubscription(
      discordUserId,
      groupId.toString(),
      moderationPrompt,
      subscription,
      channel.id,
      moderationServices
    );

    // Send and pin the welcome message in the private channel
    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x1e90ff)
      .setTitle("Welcome to your private channel! 🎉")
      .setDescription(
        `
        Welcome, **${robloxUsername}**! 

        This is your private channel for **${groupInfo.name}**.

        Here you can get detailed logs from the bot about each deletion and moderation action.

        **🎁 Your 1-month free trial is now active!**
        After the trial period, your subscription will automatically continue at $10/month.
        
        **Commands you can use:**
        - \`/set-group\`: Set your Roblox group.\n
        - \`/logs <roblox_username>\`: Get detailed logs for a specific Roblox user.\n
        - \`/unsubscribe\`: Cancel your subscription at the end of the current billing period.\n
        - \`/set-criteria\`: Change your moderation criteria.\n
        - \`/show-criteria\`: View your current moderation criteria.\n
        - \`/billing\`: Access your billing portal to manage payment methods and subscription.

        **How to end your subscription:**
        To cancel your subscription, run \`/unsubscribe\`. Your subscription will remain active until the end of your current billing period.
        You can also manage your subscription through the Stripe billing portal using \`/billing\`.

        If you have any questions, please do not hesitate to reach out to the staff team.

        Enjoy your experience with Group Wall Defender! 😊
      `,
      )
      .setFooter({ text: "This channel is exclusive to your subscription." });

    // Send and pin the welcome message
    const welcomeMessage = await channel.send({ embeds: [welcomeEmbed] });
    await welcomeMessage.pin();
    
    // Send join request notification
    const groupLink = `https://www.roblox.com/communities/${groupInfo.id}`;
    const embed = new EmbedBuilder()
      .setTitle("🤖 Group Join Request")
      .setDescription(
        `${robloxUsername} has requested for the bot to join their group:
        
        **Group:** [${groupInfo.name}](${groupLink})
        **Group ID:** ${groupInfo.id}
        
        Selected moderation services:
        ${moderationServices.includes("deletions") ? "✅" : "❌"} Post Deletions
        ${moderationServices.includes("exiles") ? "✅" : "❌"} Exiles
        ${moderationServices.includes("demotions") ? "✅" : "❌"} Rank Demotions`
      )
      .setColor(0x4287f5)
      .setThumbnail(pfp) // Add user's Roblox profile picture
      .setURL(groupLink)
      .setFooter({ text: `Channel ID: ${channel.id}` });

    // Create a button for staff to confirm when they've added the bot to the group
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`join_confirm_${channel.id}`)
        .setLabel("Confirm Bot Joined")
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅")
    );

    const request = await channel.guild.channels.fetch(
      serverConfig.joinRequestChannelId,
    );
    const joinRequestMessage = await request.send({ 
      embeds: [embed],
      components: [confirmRow]
    });

    console.log(
      `Private channel "${channelName}" created successfully for ${robloxUsername}`,
    );

    // Clear the active subscription once the user has completed the process
    activeSubscriptions.delete(user.id);

    // Clear the stored message IDs
    subscriptionFlowMessages = [];
    delete client.tempData[user.id];
    monitorGroupWall(groupId);

    // Add a notification embed for user's channel
    const joinRequestEmbed = new EmbedBuilder()
      .setColor(0xf5a742)
      .setTitle("🤖 Bot Join Request")
      .setDescription(
        `A join request has been sent to our staff team for Group **${groupInfo.name}** (ID: ${groupInfo.id}).
        
        **Our bot will be added to your group as soon as possible (maximum 12 hours).**
        
        Selected moderation services:
        ${moderationServices.includes("deletions") ? "✅" : "❌"} Post Deletions
        ${moderationServices.includes("exiles") ? "✅" : "❌"} Exiles
        ${moderationServices.includes("demotions") ? "✅" : "❌"} Rank Demotions
        
        The bot will begin monitoring your group wall as soon as it is added to your group.`
      )
      .setFooter({ text: "Thank you for your patience!" });
   
    await dmChannel.send({ embeds: [joinRequestEmbed] });

    // Store reference to the join request message for handling later
    if (!client.joinRequests) {
      client.joinRequests = new Map();
    }
    client.joinRequests.set(channel.id, {
      messageId: joinRequestMessage.id,
      channelId: request.id,
      userChannelId: channel.id,
      discordId: user.id,
      groupId: groupInfo.id,
      groupName: groupInfo.name,
      moderationServices: moderationServices
    });
  } catch (error) {
    console.error("Error while creating private channel or sending DM:", error);
  }
}

async function sendSubscriptionMessage(channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    
    // Check if the channel has any messages
    const messages = await channel.messages.fetch({ limit: 1 });
    if (messages.size > 0) return; // Don't send if there are already messages
    
    const embed = new EmbedBuilder()
      .setColor(0x4287f5)
      .setTitle("🛡️ Group Wall Defender - Premium Group Protection")
      .setDescription(
        "**Protect your Roblox group with AI-powered moderation!**\n\n" +
        "🤖 **Powerful AI Moderation**: Automatically identifies rule violations\n" +
        "🔄 **Multiple Actions**: Delete posts, exile users, or modify ranks\n" +
        "✨ **Fully Customizable**: Create your own moderation rules\n" +
        "⚡ **Real-time protection**: 24/7 monitoring of your group wall\n\n" +
        "**🎁 Start with a 1-month FREE trial, then $10/month per group**\n" +
        "Click the button below to start your free trial today!"
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("subscribe")
        .setLabel("Start Free Trial")
        .setStyle(ButtonStyle.Success),
    );

    await channel.send({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error("Error sending subscription message:", error);
  }
}

client.once("ready", async () => {
  console.log("Bot is online.");
  await initializeNoblox();
  await sendSubscriptionMessage(serverConfig.subscriptionChannelId);

  // Register commands first
  const commands = [
    new SlashCommandBuilder()
      .setName("logs")
      .setDescription("Get moderation logs for a Roblox user")
      .addStringOption((option) =>
        option
          .setName("username")
          .setDescription("The Roblox username to get logs for")
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("unsubscribe")
      .setDescription("Cancel your subscription at the end of the current billing period"),
    new SlashCommandBuilder()
      .setName("set-group")
      .setDescription("Change the group for this subscription"),
    new SlashCommandBuilder()
      .setName("set-criteria")
      .setDescription("Update your moderation criteria and actions"),
    new SlashCommandBuilder()
      .setName("show-criteria")
      .setDescription("Display current moderation criteria"),
    new SlashCommandBuilder()
      .setName("services")
      .setDescription("Update the moderation services for your group"),
    new SlashCommandBuilder()
      .setName("give-access")
      .setDescription("Give access to a user without paying.")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("The user whose access should be given.")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("moderation_prompt")
          .setDescription("The prompt for the AI.")
          .setRequired(true),
      )
      .addNumberOption((option) =>
        option
          .setName("group")
          .setDescription("The groupID of the group.")
          .setRequired(true),
      )
      .addBooleanOption((option) =>
        option
          .setName("deletions")
          .setDescription("Enable post deletions (default: true)")
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName("exiles")
          .setDescription("Enable user exiles/kicks (default: false)")
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName("demotions")
          .setDescription("Enable rank demotions (default: false)")
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("remove-access")
      .setDescription("Remove access from the channel where it is ran."),
  ];

  await Promise.all(
    commands.map((command) => client.application.commands.create(command)),
  );

  // Initialize monitoring of all subscribed groups
  try {
    console.log("Initializing group wall monitoring...");
    const subscriptions = await getAllSubscriptions();
    console.log(`Found ${subscriptions.length} total subscriptions`);
    
    if (subscriptions.length > 0) {
      // Debug: log each subscription's group ID
      subscriptions.forEach(sub => {
        console.log(`Subscription: Group ID=${sub.groupId}, Discord ID=${sub.discordId}, Channel ID=${sub.channelId || 'N/A'}`);
      });
      
      // Extract unique group IDs as strings
      const groupIds = [...new Set(subscriptions.map(sub => sub.groupId.toString()))];
      console.log(`Found ${groupIds.length} unique groups to monitor: ${groupIds.join(', ')}`);
      
      // Start monitoring each group wall
      if (groupIds.length > 0) {
        await monitorMultipleGroupWalls(groupIds);
        
        // Double-check which groups are being monitored
        console.log(`After initialization: ${activeMonitors.size} groups being monitored`);
        Array.from(activeMonitors.keys()).forEach(groupId => {
          console.log(`- Group ${groupId} monitoring details:`, 
            activeMonitors.has(groupId) ? 'Active' : 'Not active');
        });
      } else {
        console.log("No valid groups found to monitor");
      }
    } else {
      console.log("No subscriptions found to monitor");
    }
    
    // Check for new subscriptions periodically
    setInterval(async () => {
      try {
        const latestSubscriptions = await getAllSubscriptions();
        
        // Get all current monitored group IDs as strings
        const currentGroupIds = new Set(Array.from(activeMonitors.keys()).map(id => id.toString()));
        console.log(`Currently monitoring ${currentGroupIds.size} groups: ${Array.from(currentGroupIds).join(', ')}`);
        
        // Find new subscriptions with group IDs not currently being monitored
        const newGroupIds = [...new Set(
          latestSubscriptions
            .filter(sub => !currentGroupIds.has(sub.groupId.toString()))
            .map(sub => sub.groupId.toString())
        )];
        
        if (newGroupIds.length > 0) {
          console.log(`Found ${newGroupIds.length} new groups to monitor: ${newGroupIds.join(', ')}`);
          await monitorMultipleGroupWalls(newGroupIds);
        } else {
          console.log("No new groups to monitor");
        }
      } catch (error) {
        console.error("Error updating subscription monitors:", error);
      }
    }, 600000); // Check every 10 minutes
  } catch (error) {
    console.error(`❌ Failed to initialize wall monitoring:`, error);
  }
});

// Log in to Discord with the bot's token
client.login(process.env.BOT_TOKEN);

// Update button interaction handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    // Service update buttons
    if (interaction.customId.startsWith("service_update_")) {
      await toggleServiceButton(interaction);
    }
    else if (interaction.customId === "service_update_save") {
      await handleServiceContinue(interaction);
    }
    // ... other button handlers ...
  } catch (error) {
    console.error("Error handling button interaction:", error);
    try {
      await interaction.reply({ 
        content: "❌ An error occurred. Please try again.", 
        ephemeral: true 
      });
    } catch (replyError) {
      console.error("Failed to send error response:", replyError);
    }
  }
});

async function toggleServiceButton(interaction) {
  try {
    const userId = interaction.user.id;
    const userData = interaction.client.tempData?.[userId];
    
    if (!userData || !userData.isServiceUpdate) {
      return interaction.reply({
        content: "❌ Something went wrong. Please run the /services command again.",
        ephemeral: true
      });
    }
    
    // Get the service name from the button ID
    const buttonId = interaction.customId;
    const serviceName = buttonId.replace("service_update_", "");
    
    // Skip if the service is deletions (can't be toggled)
    if (serviceName === "deletions") {
      return interaction.deferUpdate();
    }
    
    // Toggle the service in the user's data
    const services = userData.services || ["deletions"];
    const serviceIndex = services.indexOf(serviceName);
    
    if (serviceIndex === -1) {
      // If service isn't enabled, add it
      services.push(serviceName);
    } else {
      // If service is enabled, remove it
      services.splice(serviceIndex, 1);
    }
    
    // Update the button state
    const components = interaction.message.components;
    
    // Find the correct button and update its emoji
    for (const row of components) {
      for (const component of row.components) {
        if (component.customId === buttonId) {
          // Update emoji based on whether the service is now enabled
          const emoji = services.includes(serviceName) ? "☑️" : "⬜";
          component.emoji = { name: emoji };
        }
      }
    }
    
    // Update the message
    await interaction.update({
      components: components
    });
    
    // Save the updated services
    userData.services = services;
    interaction.client.tempData[userId] = userData;
    
    console.log(`Updated services for user ${userId}:`, services);
  } catch (error) {
    console.error(`Error toggling service button:`, error);
    
    // Try to update the message with the original components if possible
    try {
      await interaction.update({
        components: interaction.message.components
      });
    } catch (updateError) {
      console.error("Failed to update message after error:", updateError);
    }
  }
}

async function handleServiceContinue(interaction) {
  try {
    const userId = interaction.user.id;
    const userData = interaction.client.tempData?.[userId];
    
    if (!userData || !userData.isServiceUpdate) {
      return interaction.reply({
        content: "❌ Something went wrong. Please run the /services command again.",
        ephemeral: true
      });
    }
    
    // Make sure the services array has at least "deletions"
    if (!userData.services.includes("deletions")) {
      userData.services.push("deletions");
    }
    
    // Update the services in the database
    await updateModerationServices(userId, userData.groupId, userData.services);
    
    // Create permissions embed using the common function
    const permissionsEmbed = createPermissionsEmbed(
      userData.groupId,
      userData.groupName,
      userData.services,
      false // isDM = false (this is shown in channel)
    );
    
    // Send success message and permissions instructions
    const successEmbed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle("✅ Moderation Services Updated")
      .setDescription(
        `Your moderation services for **${userData.groupName}** have been updated successfully.
        
        **Enabled services:**
        ${userData.services.includes("deletions") ? "✅" : "❌"} Post Deletions
        ${userData.services.includes("exiles") ? "✅" : "❌"} Exiles (Kicks)
        ${userData.services.includes("demotions") ? "✅" : "❌"} Rank Demotions
        
        These changes are now in effect. The bot will now enforce these moderation services.`
      );
    
    // Clean up the data
    delete interaction.client.tempData[userId];
    
    // Update with both embeds
    await interaction.update({
      embeds: [successEmbed, permissionsEmbed],
      components: [] // Remove all buttons
    });
  } catch (error) {
    console.error("Error handling service update:", error);
    await interaction.reply({
      content: "❌ Something went wrong while updating your services. Please try again.",
      ephemeral: true
    });
  }
}

// Add join confirm button handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  
  // Handle confirmation that bot has joined the group
  if (interaction.customId.startsWith("join_confirm_")) {
    try {
      await interaction.deferUpdate();
      
      // Extract the channel ID from the custom ID
      const userChannelId = interaction.customId.replace("join_confirm_", "");
      
      // Get the stored request data
      if (!client.joinRequests) {
        console.error("joinRequests Map is undefined");
        client.joinRequests = new Map(); // Create it if it doesn't exist
        return interaction.followUp({
          content: "❌ Could not find the associated join request data. The request data storage was not properly initialized.",
          ephemeral: true
        });
      }
      
      const requestData = client.joinRequests.get(userChannelId);
      
      if (!requestData) {
        console.error(`No join request data found for channel ID: ${userChannelId}`);
        return interaction.followUp({
          content: "❌ Could not find the associated join request data. The request may have expired or been processed already.",
          ephemeral: true
        });
      }
      
      // Delete the join request message
      try {
        const requestChannel = await interaction.client.channels.fetch(requestData.channelId);
        const requestMessage = await requestChannel.messages.fetch(requestData.messageId);
        await requestMessage.delete();
      } catch (error) {
        console.error("Error deleting join request message:", error);
        // Continue even if deletion fails
      }
      
      // Get the user's channel
      const userChannel = await interaction.client.channels.fetch(userChannelId);
      
      // Send brief confirmation to the user's channel
      const confirmationEmbed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("🎉 Bot Added Successfully!")
        .setDescription(`Our bot has been added to your group **${requestData.groupName}**! Check your DMs for setup instructions.`);
      
      await userChannel.send({ embeds: [confirmationEmbed] });
      
      // Send confirmation to the user via DM
      const user = await interaction.client.users.fetch(requestData.discordId);
      const dmChannel = await user.createDM();
      
      // Create confirmation and permissions embeds
      const dmConfirmationEmbed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("🎉 Bot Added Successfully!")
        .setDescription(`Our bot has been added to your group **${requestData.groupName}**!`)
        .addFields({ 
          name: "Group Information", 
          value: `[${requestData.groupName}](https://www.roblox.com/groups/${requestData.groupId})` 
        })
        .setTimestamp();
      
      // Create permissions embed for DM
      const permissionsEmbed = createPermissionsEmbed(
        requestData.groupId,
        requestData.groupName,
        requestData.moderationServices,
        true // isDM = true
      );
      
      // Send both embeds to user DM
      await dmChannel.send({ embeds: [dmConfirmationEmbed, permissionsEmbed] });
      
      // Send confirmation to the staff member
      await interaction.followUp({
        content: `✅ Confirmation sent to user's channel and DM for Group ${requestData.groupName} (${requestData.groupId})`,
        ephemeral: true
      });
      
      // Clear the stored request data
      client.joinRequests.delete(userChannelId);
      
    } catch (error) {
      console.error("Error handling join confirmation:", error);
      await interaction.followUp({
        content: "❌ An error occurred while processing the confirmation.",
        ephemeral: true
      });
    }
  }
});

// Handle unsubscribe command
async function handleUnsubscribeCommand(interaction) {
  try {
    const groupId = interaction.options.getString('group_id');
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    
    // Check if user is subscribed to this group
    const userDoc = await db.collection('users').doc(discordId).get();
    
    if (!userDoc.exists) {
      await interaction.editReply({ content: 'You don\'t have any active subscriptions.' });
      return;
    }
    
    const userData = userDoc.data();
    const subscriptions = userData.subscriptionIds || [];
    let groupSubscription = null;
    
    if (subscriptions.length > 0) {
      const subscribedGroups = await getSubscribedGroups(discordId);
      
      if (subscribedGroups.includes(groupId)) {
        // Cancel the subscription at the end of the billing period
        await cancelSubscription(discordId, groupId);
        
        await interaction.editReply({ 
          content: 'Your subscription has been set to cancel at the end of your current billing period. You\'ll still have access to the service until then. If you want to restart your subscription before it ends, you can use the Stripe portal link sent to you previously.' 
        });
      } else {
        await interaction.editReply({ content: `You are not subscribed to the group with ID: ${groupId}` });
      }
    } else {
      await interaction.editReply({ content: 'You don\'t have any active subscriptions.' });
    }
  } catch (error) {
    console.error('Error handling unsubscribe command:', error);
    try {
      await interaction.editReply({ content: 'An error occurred while processing your request. Please try again later.' });
    } catch (replyError) {
      console.error('Error sending error reply:', replyError);
    }
  }
}

// Add this function alongside other handler functions
async function handleServiceUpdateButtons(interaction) {
  try {
    const userId = interaction.user.id;
    const userData = interaction.client.tempData?.[userId];
    
    if (!userData || !userData.isServiceUpdate) {
      return interaction.reply({
        content: "❌ Something went wrong. Please run the /services command again.",
        ephemeral: true
      });
    }
    
    // Handle save button
    if (interaction.customId === "service_update_save") {
      await interaction.deferUpdate();
      
      // Make sure the services array has at least "deletions"
      if (!userData.services.includes("deletions")) {
        userData.services.push("deletions");
      }
      
      // Update the services in the database
      await updateModerationServices(userId, userData.groupId, userData.services);
      
      // Create permissions embed using the common function
      const permissionsEmbed = createPermissionsEmbed(
        userData.groupId,
        userData.groupName,
        userData.services,
        false // isDM = false (this is shown in channel)
      );
      
      // Send success message and permissions instructions
      const successEmbed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("✅ Moderation Services Updated")
        .setDescription(
          `Your moderation services for **${userData.groupName}** have been updated successfully.
          
          **Enabled services:**
          ${userData.services.includes("deletions") ? "✅" : "❌"} Post Deletions
          ${userData.services.includes("exiles") ? "✅" : "❌"} Exiles (Kicks)
          ${userData.services.includes("demotions") ? "✅" : "❌"} Rank Demotions
          
          These changes are now in effect. The bot will now enforce these moderation services.`
        );
      
      // Clean up the data
      delete interaction.client.tempData[userId];
      
      // Update the original message
      await interaction.editReply({
        embeds: [successEmbed, permissionsEmbed],
        components: [] // Remove buttons
      });
      
      return;
    }
    
    // Handle individual service toggle buttons
    const serviceType = interaction.customId.replace("service_update_", "");
    
    // Get the current state of this service
    const isCurrentlyEnabled = userData.services.includes(serviceType);
    
    // Toggle the service (with special handling for deletions)
    if (serviceType === "deletions") {
      // Force deletions to always be enabled
      if (!userData.services.includes("deletions")) {
        userData.services.push("deletions");
      }
    } else {
      // Toggle other services normally
      if (isCurrentlyEnabled) {
        userData.services = userData.services.filter(s => s !== serviceType);
      } else {
        userData.services.push(serviceType);
      }
    }
    
    // Update the buttons
    const deletionsButton = new ButtonBuilder()
      .setCustomId("service_update_deletions")
      .setLabel("Post Deletions")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(userData.services.includes("deletions") ? "☑️" : "⬜")
      .setDisabled(true); // Always disabled since it's required
    
    const exilesButton = new ButtonBuilder()
      .setCustomId("service_update_exiles")
      .setLabel("Exiles (Kicks)")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(userData.services.includes("exiles") ? "☑️" : "⬜");
    
    const demotionsButton = new ButtonBuilder()
      .setCustomId("service_update_demotions")
      .setLabel("Rank Demotions")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(userData.services.includes("demotions") ? "☑️" : "⬜");
    
    const saveButton = new ButtonBuilder()
      .setCustomId("service_update_save")
      .setLabel("Save Changes")
      .setStyle(ButtonStyle.Success);
    
    const row1 = new ActionRowBuilder().addComponents(
      deletionsButton, exilesButton, demotionsButton
    );
    
    const row2 = new ActionRowBuilder().addComponents(saveButton);
    
    // Update the embed description
    const servicesEmbed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle("🔧 Moderation Services Configuration")
      .setDescription(
        `Configure the moderation services for **${userData.groupName}**.
        
        **Currently enabled services:**
        ${userData.services.includes("deletions") ? "✅" : "❌"} Post Deletions
        ${userData.services.includes("exiles") ? "✅" : "❌"} Exiles (Kicks)
        ${userData.services.includes("demotions") ? "✅" : "❌"} Rank Demotions
        
        Click on the buttons below to toggle services. When you're done, click "Save Changes".
        
        **Note:** Post Deletions is always enabled and cannot be disabled.`
      )
      .setFooter({ text: "Group Wall Defender" });
    
    // Update the message
    await interaction.update({
      embeds: [servicesEmbed],
      components: [row1, row2]
    });
  } catch (error) {
    console.error("Error handling service update button:", error);
    try {
      await interaction.reply({
        content: "❌ An error occurred while updating services. Please try again.",
        ephemeral: true
      });
    } catch (replyError) {
      console.error("Failed to send error reply:", replyError);
    }
  }
}

/**
 * Sends a DM notification to a user in a standardized format
 * @param {string} userId Discord user ID to send the DM to
 * @param {Object} options Notification options
 * @param {string} options.title Title of the notification
 * @param {string} options.description Description content
 * @param {number} options.color Embed color (hex)
 * @param {string} options.groupName Name of the group (if applicable)
 * @param {string} options.groupId ID of the group (if applicable)
 * @param {Object} options.footer Footer options (if applicable)
 * @returns {Promise<boolean>} Success status
 */
async function sendUserDMNotification(userId, options) {
  try {
    // Fetch the user
    const user = await client.users.fetch(userId);
    if (!user) {
      console.error(`Could not find user with ID: ${userId}`);
      return false;
    }
    
    // Create the notification embed
    const embed = new EmbedBuilder()
      .setColor(options.color || 0x4287f5)
      .setTitle(options.title)
      .setDescription(options.description);
    
    // Add group info if provided
    if (options.groupName && options.groupId) {
      embed.addFields({ 
        name: "Group Information", 
        value: `[${options.groupName}](https://www.roblox.com/groups/${options.groupId})` 
      });
    }
    
    // Add footer if provided
    if (options.footer) {
      embed.setFooter(options.footer);
    }
    
    // Add timestamp
    embed.setTimestamp();
    
    // Send the DM
    await user.send({ embeds: [embed] });
    return true;
  } catch (error) {
    console.error(`Error sending DM notification to user ${userId}:`, error);
    return false;
  }
}

// Add this new utility function for creating consistent permission embeds
/**
 * Creates a standardized permissions instruction embed
 * @param {string} groupId - The Roblox group ID
 * @param {string} groupName - The Roblox group name
 * @param {Array<string>} services - Array of enabled services
 * @param {boolean} isDM - Whether this embed is being sent in a DM (affects some wording)
 * @returns {EmbedBuilder} The configured embed
 */
function createPermissionsEmbed(groupId, groupName, services, isDM = false) {
  // Create a formatted permissions guide based on the selected services
  const deletionsEnabled = services.includes("deletions");
  const exilesEnabled = services.includes("exiles");
  const demotionsEnabled = services.includes("demotions");
  
  let requiredPermissions = [];
  
  // Add required permissions based on enabled services
  requiredPermissions.push("✅ **Delete Group Wall Posts** - For deleting inappropriate posts");
  
  if (exilesEnabled) {
    requiredPermissions.push("✅ **Kick Members** - For removing users who violate rules");
  }
  
  if (demotionsEnabled) {
    requiredPermissions.push("✅ **Change Rank** - For demoting users or changing their rank");
  }
  
  // Create the embed
  const embed = new EmbedBuilder()
    .setColor(0x00aaff)
    .setTitle("🔧 Required Permissions")
    .setDescription(
      `Please ensure the bot has these permissions in your group:
      
      ${requiredPermissions.join("\n")}
      
      Without these permissions, the bot won't be able to perform the moderation actions you've selected.`
    )
    .addFields(
      { name: "Group Link", value: `[${groupName}](https://www.roblox.com/groups/${groupId})` }
    );
  
  // Add extra help text for DM embeds
  if (isDM) {
    embed.setFooter({ 
      text: "If you need help setting up permissions, join our support server for assistance." 
    });
  }
  
  return embed;
}
