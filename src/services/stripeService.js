import { config } from "dotenv";
config();
import Stripe from "stripe";
import { addSubscription, cancelSubscription } from "./firebaseService.js";
import { createPrivateChannelAndSendDM, getDiscordUser } from "../bot.js";
import { leaveGroup } from "./nobloxService.js";

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Create Stripe checkout session for subscription
export async function createCheckoutSession(
  discordUserId,
  groupId,
  moderationPrompt
) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: "Group Wall Defender Subscription",
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
    },
    success_url: `http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `http://localhost:3000/cancel`,
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
      const { discordUserId: userIdToRemove, groupId: groupIdToRemove } =
        subscriptionDeleted.metadata;
      try {
        await removeSubscription(userIdToRemove, groupIdToRemove);
        await leaveGroup(groupId);
      } catch (error) {}

      console.log(
        `Subscription canceled for Discord user ${userIdToRemove} and group ${groupIdToRemove}`
      );

      action = {
        type: "deleteChannel",
        discordUserId: userIdToRemove,
      };

      break;

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });

  return action; // Returning the action object based on event type
}

export default { createCheckoutSession, handleWebhook };
