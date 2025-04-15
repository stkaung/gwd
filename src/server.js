import express from "express";
import { handleWebhook } from "./services/stripeService.js";
import { client } from "./bot.js";
import dotenv from "dotenv";
dotenv.config();
const app = express();

app.use(express.text());

const PORT = 3000;

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    await handleWebhook(req, res)
})

app.get("/success", async (req, res) => {
  res.json({ recieved: true })
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  client.login(process.env.BOT_TOKEN);
});
