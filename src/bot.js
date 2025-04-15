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
} from "discord.js";
import { config } from "dotenv";
import {
  addSubscription,
  cancelSubscription,
  getSubscribedGroups,
  getLogs,
  updateSubscriptionGroup,
  updateModerationCriteria,
  getModerationCriteria,
  getSubscription,
  getAllSubscriptions,
} from "./services/firebaseService.js";
import stripeService, {
  cancelStripeSubscription,
  createCheckoutSession,
} from "./services/stripeService.js";
import { getRobloxId } from "./services/bloxlinkService.js";
import {
  getIdFromUsername,
  getUsername,
  getGroupInfo,
  getOwnedGroups,
  initializeNoblox,
  monitorGroupWall,
} from "./services/nobloxService.js";
import express from "express";
import bodyParser from "body-parser";
import noblox from "noblox.js";
import { checkMessage } from "./services/geminiService.js";
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

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.customId === "subscribe") {
      await handleSubscribe(interaction);
    } else if (interaction.customId === "unsubscribe") {
      await handleUnsubscribe(interaction);
    } else if (interaction.customId === "group_select") {
      await handleGroupSelect(interaction);
    } else if (interaction.customId === "skip_prompt") {
      await handleModerationPrompt(
        interaction,
        "Delete messages that break community guidelines."
      );
    } else if (interaction.customId === "submit_prompt") {
      await promptForCustomInput(interaction);
    } else if (interaction.customId === "cancel_subscription_flow") {
      await handleCancelSubscriptionFlow(interaction);
    }

    // Add this new condition to handle modal submissions
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
          });
        }

        await handleModerationPrompt(
          interaction,
          interaction.user.id,
          userData.selectedGroupId,
          moderationPrompt
        );

        // Clean up stored data
      }
    }

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
          const embeds = await Promise.all(
            logs.map(async (log) => {
              const botUsername = await getUsername(log.botId);
              const groupInfo = await getGroupInfo(log.groupId);
              const robloxUsername = await getUsername(log.robloxId);

              return new EmbedBuilder()
                .setColor(0xff0000)
                .setTitle("Moderation Log")
                .setThumbnail(userThumbnail)
                .addFields(
                  { name: "Roblox Username", value: robloxUsername },
                  { name: "Group", value: groupInfo.name },
                  { name: "Type", value: log.type },
                  {
                    name: "Message",
                    value: log.message || "No message provided",
                  },
                  { name: "Reason", value: log.reason },
                  { name: "Moderation Bot", value: botUsername },
                  {
                    name: "Issued Date",
                    value: log.issuedDate.toDate().toLocaleString(),
                  }
                );
            })
          );

          await interaction.editReply({ embeds: embeds });
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

    if (interaction.commandName === "unsubscribe") {
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

        // Get the group ID and name from the channel name
        const channelNameParts = channel.name.split("-");
        const groupId = channelNameParts[channelNameParts.length - 1];
        const groupInfo = await getGroupInfo(groupId);

        // Create confirmation embed
        const confirmEmbed = new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle("⚠️ End Subscription")
          .setDescription(
            `Are you sure you want to end your subscription for **${groupInfo.name}**?\n\nThis will:\n• Cancel your subscription\n• Delete this channel\n• Remove all associated permissions`
          )
          .setFooter({ text: "This action cannot be undone!" });

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
          cancelButton
        );

        // Send the confirmation message
        await interaction.reply({
          embeds: [confirmEmbed],
          components: [row],
        });
      } catch (error) {
        console.error("Error handling unsubscribe command:", error);
        return interaction.reply({
          content: "❌ An error occurred while processing your request.",
          ephemeral: true,
        });
      }
    } else if (interaction.commandName === "give-access") {
      const user = interaction.options.getUser("user");
      const modPrompt = interaction.options.getString("moderation_prompt");
      const groupId = interaction.options.getNumber("group");
      const groupData = await getGroupInfo(groupId);
      const groupName = groupData.name;
      interaction.client.tempData = {
        ...interaction.client.tempData,
        [interaction.user.id]: {
          groupId,
          groupName,
        },
      };
      await createPrivateChannelAndSendDM(
        user,
        modPrompt,
        user.id,
        groupId,
        333
      );
    } else if (interaction.commandName === "remove-access") {
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

        // Get the group ID and name from the channel name
        const channelNameParts = channel.name.split("-");
        const groupId = channelNameParts[channelNameParts.length - 1];
        const groupInfo = await getGroupInfo(groupId);

        // Create confirmation embed
        const confirmEmbed = new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle("⚠️ End Subscription")
          .setDescription(
            `Are you sure you want to end your subscription for **${groupInfo.name}**?\n\nThis will:\n• Cancel your subscription\n• Delete this channel\n• Remove all associated permissions`
          )
          .setFooter({ text: "This action cannot be undone!" });

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
          cancelButton
        );

        // Send the confirmation message
        await interaction.reply({
          embeds: [confirmEmbed],
          components: [row],
        });
      } catch (error) {
        console.error("Error handling unsubscribe command:", error);
        return interaction.reply({
          content: "❌ An error occurred while processing your request.",
          ephemeral: true,
        });
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
          "The subscription process has been canceled due to inactivity. Feel free to try again!"
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
        "⚠️ You are already in the middle of a subscription process. Please complete or cancel it first."
      );
    }

    // Try to send a DM to the user
    const robloxId = await getRobloxId(
      interaction.guild.id,
      interaction.user.id
    );

    // Check if user is verified
    if (!robloxId) {
      return interaction.editReply(
        "❌ You have not verified your Roblox account. Please do so by running `/verify` in #verify."
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
      (group) => !subscribedGroupIds.includes(group.id.toString())
    );

    // Check if there are any available groups to subscribe
    if (availableGroups.length === 0) {
      return interaction.editReply(
        "❌ All of your owned groups are already subscribed to Group Wall Defender. If you'd like to manage your existing subscriptions, please use the unsubscribe button."
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
          `Our payments are processed **securely through Stripe**. If you have any concerns regarding payment or the service in general, **please do not hesitate to reach out to staff.**`
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
          "• Customizable actions (delete, rank changes, bans)",
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
        "Please choose the group you want to subscribe with from the dropdown below."
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
      "✅ Check your DMs to continue the subscription process!"
    );
  } catch (error) {
    console.error("Error in subscription flow:", error);
    activeSubscriptions.delete(interaction.user.id);
    await interaction.editReply(
      "❌ An error occurred while processing your subscription."
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
        "The subscription process has been successfully canceled. If you wish to try again later, feel free to reach out to us!"
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
  await interaction.deferReply({ ephemeral: true });

  const userSubscription = await getUserSubscription(interaction.user.id);
  if (!userSubscription) {
    return interaction.editReply("❌ You are not subscribed.");
  }

  await removeSubscription(interaction.user.id);
  await interaction.editReply("✅ You have successfully unsubscribed.");
}

async function handleGroupSelect(interaction) {
  try {
    const selectedGroupId = interaction.values[0];
    const selectedGroup = interaction.component.options.find(
      (option) => option.value === selectedGroupId
    );
    const selectedGroupName = selectedGroup
      ? selectedGroup.label
      : "Unknown Group";

    // Create and show modal directly without updating the message first
    const modal = new ModalBuilder()
      .setCustomId("moderationPromptModal")
      .setTitle("Set Moderation Prompt");

    const promptInput = new TextInputBuilder()
      .setCustomId("moderationPrompt")
      .setLabel("Enter your moderation prompt:")
      .setStyle(TextInputStyle.Paragraph)
      .setValue("Delete messages that break community guidelines."); // Default value

    const actionRow = new ActionRowBuilder().addComponents(promptInput);
    modal.addComponents(actionRow);

    // Store the selected group ID in a way we can access it later
    interaction.client.tempData = {
      ...interaction.client.tempData,
      [interaction.user.id]: {
        selectedGroupId,
        selectedGroupName,
      },
    };

    await interaction.showModal(modal);
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
        .setStyle(TextInputStyle.Paragraph)
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
        moderationPrompt
      );
    }
  });
}

async function handleModerationPrompt(
  interaction,
  userId,
  groupId,
  moderationPrompt
) {
  try {
    // Defer the reply immediately to prevent the interaction from timing out
    await interaction.deferReply({ ephemeral: true });

    // Save the subscription with just the essential data

    // Fetch the user object and guild member
    const user = await interaction.client.users.fetch(userId);
    const guild = await interaction.client.guilds.fetch(serverConfig.serverId);
    const member = await guild.members.fetch(userId);
    const session = await createCheckoutSession(
      userId,
      groupId,
      moderationPrompt
    );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(session.url)
        .setLabel("Pay Now")
    );

    // Check if user has subscriber role, if not add it
    if (!member.roles.cache.has(serverConfig.subscriberRoleId)) {
      await member.roles.add(serverConfig.subscriberRoleId);
    }

    // Call the function to create the private channel and send a DM

    await interaction.editReply({
      content: `Click the button below to purchase the subscription.`,
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
  subscription
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
      userData.selectedGroupId || userData.groupId
    );

    // Send a success message in the user's DM
    const dmChannel = await user.createDM();
    const successEmbed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle("🎉 Subscription Successful! 🎉")
      .setDescription(
        `Congratulations, ${user.username}! Your subscription to Group Wall Defender for **${groupInfo.name}** is now active.\n\nYour custom moderation prompt has been successfully set as:\n\n**"${moderationPrompt}"**`
      )
      .setFooter({ text: "Thank you for subscribing to Group Wall Defender!" });

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

    await addSubscription(
      discordUserId,
      groupId.toString(),
      moderationPrompt,
      subscription,
      channel.id
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

        **Commands you can use:**
        - \`/set-group\`: Set your Roblox group.\n
        - \`/logs <roblox_username>\`: Get detailed logs for a specific Roblox user.\n
        - \`/unsubscribe\`: End your subscription and delete this channel.\n
        - \`/set-criteria\`: Change your moderation criteria.\n
        - \`/show-criteria\`: View your current moderation criteria.

        **How to end your subscription:**
        To end your subscription, simply run \`/unsubscribe\` and confirm the action.

        If you have any questions, please do not hesitate to reach out to the staff team.

        Enjoy your experience with Group Wall Defender! 😊
      `
      )
      .setFooter({ text: "This channel is exclusive to your subscription." });

    // Send and pin the welcome message
    const welcomeMessage = await channel.send({ embeds: [welcomeEmbed] });
    await welcomeMessage.pin();

    const embed = new EmbedBuilder()
      .setTitle("Group Join Request")
      .setDescription(
        `${robloxUsername} has requested for a manual join for ${groupInfo.id}`
      );
    const request = await channel.guild.channels.fetch(
      serverConfig.joinRequestChannel
    );
    await request.send({ embeds: [embed] });

    console.log(
      `Private channel "${channelName}" created successfully for ${robloxUsername}`
    );

    // Clear the active subscription once the user has completed the process
    activeSubscriptions.delete(user.id);

    // Clear the stored message IDs
    subscriptionFlowMessages = [];
    delete client.tempData[user.id];
  } catch (error) {
    console.error("Error while creating private channel or sending DM:", error);
  }
}

async function sendSubscriptionMessage(channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error("Channel not found!");

    const messages = await channel.messages.fetch({ limit: 1 });
    if (messages.size > 0) {
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle("Subscribe to Group Wall Defender!")
      .setDescription(
        `With a subscription to Group Wall Defender, you can protect your Roblox Group's community wall.  
            Each group costs **$10/month**.`
      )
      .addFields({
        name: "Features:",
        value:
          "- Automated moderation\n- LLM-powered deletion\n- Custom moderation prompts\n- 24/7 group wall monitoring\n- Detailed logs",
      })
      .setFooter({
        text: "Brought to you by Group Wall Defender.",
      });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("subscribe")
        .setLabel("Subscribe")
        .setStyle(ButtonStyle.Success)
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

  const commands = [
    new SlashCommandBuilder()
      .setName("logs")
      .setDescription("Get moderation logs for a Roblox user")
      .addStringOption((option) =>
        option
          .setName("username")
          .setDescription("The Roblox username to get logs for")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("unsubscribe")
      .setDescription("End your subscription and delete this channel"),
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
      .setName("give-access")
      .setDescription("Give access to a user without paying.")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("The user whose access should be given.")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("moderation_prompt")
          .setDescription("The prompt for the AI.")
          .setRequired(true)
      )
      .addNumberOption((option) =>
        option
          .setName("group")
          .setDescription("The groupID of the group.")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("remove-access")
      .setDescription("Remove access from the channel where it is ran."),
  ];

  await Promise.all(
    commands.map((command) => client.application.commands.create(command))
  );

  try {
    let subscriptions = await getAllSubscriptions();
    subscriptions.forEach((subscription) =>
      monitorGroupWall(subscription.groupId, subscription.moderationPrompt)
    );
    setInterval(async () => {
      subscriptions = await getAllSubscriptions();
    }, 600000);
  } catch (error) {
    console.error(`❌ Failed to initialize wall monitoring for group`, error);
  }
});

// Log in to Discord with the bot's token

// Update button interaction handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === "confirm_unsubscribe") {
    try {
      await interaction.deferUpdate();

      // Get the group ID from the channel name
      const channel = interaction.channel;
      const channelNameParts = channel.name.split("-");
      const groupId = channelNameParts[channelNameParts.length - 1];

      const sub = await getSubscription(interaction.user.id, groupId);
      const cancel = await cancelStripeSubscription(sub.stripe);
      console.log(cancel);

      // Cancel the subscription in Firebase and check if it was their last subscription
      const hasNoSubscriptions = await cancelSubscription(
        interaction.user.id,
        groupId
      );

      // If they have no more subscriptions, remove the subscriber role
      if (hasNoSubscriptions) {
        const member = await interaction.guild.members.fetch(
          interaction.user.id
        );
        if (member.roles.cache.has(subscriberRoleId)) {
          await member.roles.remove(subscriberRoleId);
        }
      }

      // Update the message to show it's being processed
      const processingEmbed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle("🗑️ Subscription Ended")
        .setDescription(
          "Your subscription has been cancelled. This channel will be deleted in 5 seconds..."
        );

      await interaction.editReply({
        embeds: [processingEmbed],
        components: [], // Remove the buttons
      });

      // Wait 5 seconds
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Delete the channel
      await channel.delete("Subscription ended by user");
    } catch (error) {
      console.error("Error processing subscription cancellation:", error);
      await interaction.editReply({
        content:
          "❌ An error occurred while cancelling your subscription. Please contact support if this persists.",
        components: [], // Remove the buttons
      });
    }
  }

  if (interaction.customId === "cancel_unsubscribe") {
    // Update the message to show cancellation
    const cancelledEmbed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle("✅ Action Cancelled")
      .setDescription("Your subscription will continue normally.");

    await interaction.update({
      embeds: [cancelledEmbed],
      components: [], // Remove the buttons
    });
  }
});

// Add the set-group command handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === "set-group") {
    try {
      // Check if command is used in a subscription channel
      const channel = interaction.channel;
      if (!channel.parent || channel.parent.id !== categoryId) {
        return interaction.reply({
          content: "❌ This command can only be used in subscription channels.",
          ephemeral: true,
        });
      }

      await interaction.deferReply();

      // Get the user's Roblox info
      const robloxId = await getRobloxId(
        interaction.guild.id,
        interaction.user.id
      );
      const robloxUsername = await getUsername(robloxId);

      // Get the user's owned groups and current subscribed groups
      const ownedGroups = await getOwnedGroups(robloxId);
      const subscribedGroups = await getSubscribedGroups(interaction.user.id);

      // Filter out already subscribed groups
      const availableGroups = ownedGroups.filter(
        (group) => !subscribedGroups.includes(group.id)
      );

      if (availableGroups.length === 0) {
        return interaction.editReply({
          content:
            "❌ You don't have any available groups to switch to. You need to own the group to subscribe to it.",
          ephemeral: true,
        });
      }

      // Create dropdown for group selection
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("group_select_change")
        .setPlaceholder("Select a group")
        .addOptions(
          availableGroups.map((group) => ({
            label: group.name,
            value: group.id.toString(),
            description: `Group ID: ${group.id}`,
          }))
        );

      const row = new ActionRowBuilder().addComponents(selectMenu);

      const selectionEmbed = new EmbedBuilder()
        .setColor(0x0000ff)
        .setTitle("Select New Group")
        .setDescription(
          `Please select the group you want to switch this subscription to.\n\nCurrent groups available: ${availableGroups.length}`
        );

      await interaction.editReply({
        embeds: [selectionEmbed],
        components: [row],
      });
    } catch (error) {
      console.error("Error handling set-group command:", error);
      return interaction.editReply({
        content: "❌ An error occurred while processing your request.",
      });
    }
  }
});

// Add handler for the group selection menu
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;

  if (interaction.customId === "group_select_change") {
    try {
      await interaction.deferUpdate();

      const selectedGroupId = interaction.values[0];
      const channelNameParts = interaction.channel.name.split("-");
      const oldGroupId = channelNameParts[channelNameParts.length - 1];

      // Update the subscription in Firebase
      await updateSubscriptionGroup(
        interaction.user.id,
        oldGroupId,
        selectedGroupId
      );

      // Get new group info for channel rename
      const robloxId = await getRobloxId(
        interaction.guild.id,
        interaction.user.id
      );
      const robloxUsername = await getUsername(robloxId);
      const groupInfo = await getGroupInfo(selectedGroupId);

      // Create new channel name
      const newChannelName =
        `${robloxUsername}-${groupInfo.name}-${groupInfo.id}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "")
          .replace(/\s+/g, "-");

      // Update channel name
      await interaction.channel.setName(newChannelName);

      const successEmbed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("✅ Group Updated")
        .setDescription(
          `Successfully changed the group to **${groupInfo.name}**.\nThe channel name has been updated to reflect this change.`
        );

      await interaction.editReply({
        embeds: [successEmbed],
        components: [], // Remove the select menu
      });
    } catch (error) {
      console.error("Error handling group selection:", error);
      await interaction.editReply({
        content:
          "❌ An error occurred while updating the group. Please try again or contact support.",
        components: [], // Remove the select menu
      });
    }
  }
});

// Add the set-criteria command handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === "set-criteria") {
    try {
      // Check if command is used in a subscription channel
      const channel = interaction.channel;
      if (!channel.parent || channel.parent.id !== categoryId) {
        return interaction.reply({
          content: "❌ This command can only be used in subscription channels.",
          ephemeral: true,
        });
      }

      // Get the current group ID from the channel name
      const channelNameParts = channel.name.split("-");
      const groupId = channelNameParts[channelNameParts.length - 1];

      // Create the modal
      const modal = new ModalBuilder()
        .setCustomId("changeCriteriaModal")
        .setTitle("Update Moderation Criteria");

      const criteriaInput = new TextInputBuilder()
        .setCustomId("moderationCriteria")
        .setLabel("Enter your new moderation criteria:")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder(
          "Example: Delete posts asking for Robux or move users who spam to Visitor rank"
        )
        .setMinLength(10)
        .setMaxLength(1000)
        .setRequired(true);

      const actionRow = new ActionRowBuilder().addComponents(criteriaInput);
      modal.addComponents(actionRow);

      // Store the group ID for use in the modal submit handler
      interaction.client.tempData = {
        ...interaction.client.tempData,
        [interaction.user.id]: {
          groupId,
        },
      };

      await interaction.showModal(modal);
    } catch (error) {
      console.error("Error showing criteria modal:", error);
      return interaction.reply({
        content: "❌ An error occurred while processing your request.",
        ephemeral: true,
      });
    }
  }
});

// Add modal submit handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;

  if (interaction.customId === "changeCriteriaModal") {
    try {
      await interaction.deferReply();

      const newCriteria =
        interaction.fields.getTextInputValue("moderationCriteria");
      const userData = interaction.client.tempData?.[interaction.user.id];

      if (!userData?.groupId) {
        return interaction.editReply({
          content: "❌ Something went wrong. Please try again.",
        });
      }

      // Update the criteria in Firebase
      await updateModerationCriteria(
        interaction.user.id,
        userData.groupId,
        newCriteria
      );

      // Get group info for the response
      const groupInfo = await getGroupInfo(userData.groupId);

      // Create a response that feels more conversational
      const responseEmbed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("✅ Moderation Criteria Updated")
        .setDescription(
          `I've updated the moderation criteria for **${groupInfo.name}**. Here's the moderation criteria I'm following:

${newCriteria}

I'll start applying these new criteria right away. You can update them again anytime using \`/set-criteria\`.`
        )
        .setFooter({ text: "Your moderation settings have been saved." });

      await interaction.editReply({
        embeds: [responseEmbed],
      });

      // Clean up stored data
      delete interaction.client.tempData[interaction.user.id];
    } catch (error) {
      console.error("Error updating moderation criteria:", error);
      await interaction.editReply({
        content:
          "❌ An error occurred while updating your moderation criteria. Please try again.",
      });
    }
  }
});

// Add the show-criteria command handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === "show-criteria") {
    try {
      // Check if command is used in a subscription channel
      const channel = interaction.channel;
      if (!channel.parent || channel.parent.id !== categoryId) {
        return interaction.reply({
          content: "❌ This command can only be used in subscription channels.",
          ephemeral: true,
        });
      }

      await interaction.deferReply();

      // Get the group ID from the channel name
      const channelNameParts = channel.name.split("-");
      const groupId = channelNameParts[channelNameParts.length - 1];

      // Get the current criteria from Firebase
      const criteria = await getModerationCriteria(
        interaction.user.id,
        groupId
      );

      if (!criteria) {
        return interaction.editReply({
          content:
            "❌ Could not find moderation criteria. Try setting it with `/set-criteria`.",
        });
      }

      // Get group info for the response
      const groupInfo = await getGroupInfo(groupId);

      // Create a response embed
      const criteriaEmbed = new EmbedBuilder()
        .setColor(0x1e90ff)
        .setTitle("📋 Current Moderation Criteria")
        .setDescription(
          `Here's the moderation criteria I'm following while moderating **${groupInfo.name}**:

${criteria}

You can update these criteria anytime using \`/set-criteria\`.`
        )
        .setFooter({ text: "Group Wall Defender" })
        .setTimestamp();

      await interaction.editReply({
        embeds: [criteriaEmbed],
      });
    } catch (error) {
      console.error("Error showing moderation criteria:", error);
      await interaction.editReply({
        content:
          "❌ An error occurred while fetching the moderation criteria. Please try again.",
      });
    }
  }
});
