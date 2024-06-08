import dotenv from "dotenv";
dotenv.config();

const _oldconsolelog = console.log;
console.log = function () {
    _oldconsolelog(new Date().toISOString(), ...arguments);
};

import { Client, Collection, Events, GatewayIntentBits, Partials, PermissionsBitField } from "discord.js";
import fetch from "node-fetch";
import express from "express";

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;

const REPORT_ENDPOINT = process.env.REPORT_ENDPOINT;

const MESSAGE_VERIFICATION_ENDPOINT = process.env.MESSAGE_VERIFICATION_ENDPOINT;
const MESSAGE_VERIFICATION_ENDPOINT_AUTH = process.env.MESSAGE_VERIFICATION_ENDPOINT_AUTH;

const IMAGES_ENDPOINT = process.env.IMAGES_ENDPOINT;

// === BASE FUNCTIONS ===

async function validateMessage(contextObj, messageObj) {
    const contextStr = contextObj.map((c) => `${c.user}: ${c.content}`).join("\n");
    const message = messageObj.user + ": " + messageObj.content;
    const res = await fetch(MESSAGE_VERIFICATION_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "authorization": "Bearer " + MESSAGE_VERIFICATION_ENDPOINT_AUTH
        },
        body: JSON.stringify({
            messages: [
                {
                    role: "system",
                    content: "You are an AI tasked to detect scam, self promotion or nsfw messages on Discord, " + 
                    "an online chatting application. You will be provided context to a message, and a message to " + 
                    "check. If this message potentially falls under one of those categories, reply with \"TRUE\" " + 
                    "with a reason. otherwise, reply with \"FALSE\". Don't assume anything. If the message " + 
                    "doesn't explicitly mention something, don't assume it. For example, " + 
                    "internet slang like 'ur', asking for usernames, and pinging users are not scams."
                },
                {
                    role: "user",
                    content: "Context:\n" + 
                        "user1: hey i need your bank card\n" + 
                        "user2: sure why?\n" + 
                        "user1: i need it to pay my hospital bills\n" + 
                        "user2:okay...\n" + 
                        "\n" + 
                        "Message:\n" + 
                        "user1: please?",
                },
                {
                    role: "assistant",
                    content: "TRUE | Bank Card Fraud.",
                },
                {
                    role: "user",
                    content: "Context:\n" +
                        contextStr +
                        "\n" +
                        "Message:\n" +
                        message,
                }
            ],
            maxTokens: 512,
            model: "@cf/meta/llama-3-8b-instruct",
        }),
    })

    const data = await res.json();

    console.log(data);

    if (data.response.includes("TRUE")) {
        return {
            value: true,
            reason: data.response.split("|")[1].trim()
        };
    } else {
        return {
            value: false
        };
    }
}

async function validateImage(urls) {
    const res = await fetch(IMAGES_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            files: urls
        }),
    });

    const data = await res.json();

    const results = [];

    for (const result in data.results) {
        results.push(result);
    }

    console.log(results);
    return results;
}

// === BOT CODE ===
const client = new Client({
    intents: Object.values(GatewayIntentBits),
    partials: Object.values(Partials),
});

client.once(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user.tag}`);
});

const context = new Collection();

client.on(Events.MessageCreate, async (message) => {
    if (message.author.id == client.user.id) return; // dont reply to yourself
    // if (message.guild.ownerId == message.author.id) return; // dont reply to guild owner

    // check if there is context for the channel    
    if (!context.has(message.channel.id)) {
        context.set(message.channel.id, []);
    }

    const contextObj = context.get(message.channel.id).slice(-3);

    const attachmentURLs = message.attachments.map((attachment) => attachment.url);
    if (attachmentURLs.length > 0) {
        console.log(`Received message with attachments: ${attachmentURLs.join(", ")}`);
        
        // validate the image
        const responses = await validateImage(attachmentURLs);

        for (const response of responses) {
            if (response) {
                message.reply('nsfw or something');
                return;
            }
        }
    }

    // validate the message
    const flagged = await validateMessage(contextObj, {
        user: message.author.tag,
        content: message.content
    });

    if (flagged.value) {
        console.log(`Message from ${message.author.tag} was flagged as scam`);
        message.reply(flagged.reason);
        return;
    }

    // add the message to the context
    context.set(message.channel.id, [...contextObj, {
        user: message.author.tag,
        content: message.content
    }]);
});

client.login(BOT_TOKEN);

// === API CODE ===
const app = express();

app.use(express.json());

const apiRouter = express.Router();

apiRouter.post("/user", async (req, res) => {
    const { id, guild } = req.body;

    console.log(`Checking if user ${id} has permission to manage messages in guild ${guild}`);

    if (!id || !guild) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // get the guild
    let guildObj;
    try {
        guildObj = await client.guilds.fetch(guild);
    } catch {
        return res.status(404).json({ error: "Guild not found" });
    }

    // get the user
    let member;
    try {
        member = await guildObj.members.fetch(id);
    } catch {
        return res.status(404).json({ error: "User not found" });
    }

    // check if member has manage_messages permission
    if (!member.permissions || !member.permissions.has(PermissionsBitField.Flags.ManageMessages, true)) {
        return res.json({ hasPermission: false });
    }

    return res.json({ hasPermission: true });
});

const actionsRouter = express.Router();

actionsRouter.post("/delete", async (req, res) => {
    const { message, guild } = req.body;

    console.log(`Deleting message ${message} in guild ${guild}`);

    if (!message || !guild) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // get the guild
    let guildObj;
    try {
        guildObj = await client.guilds.fetch(guild);
    } catch {
        return res.status(404).json({ error: "Guild not found" });
    }

    // get the message
    let messageObj;
    try {
        messageObj = await (await guildObj.channels.fetch(message)).messages.fetch(message);
    } catch {
        return res.status(404).json({ error: "Message not found" });
    }

    // delete the message
    try {
        await messageObj.delete();
    } catch {
        return res.status(500).json({ error: "Failed to delete message" });
    }

    return res.json({ success: true });
})

actionsRouter.post("/timeout", async (req, res) => {
    const { user, guild, time } = req.body;

    console.log(`Timing out user ${user} in guild ${guild} for ${time} milliseconds`);

    if (!user || !guild) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // get the guild
    let guildObj;
    try {
        guildObj = await client.guilds.fetch(guild);
    } catch {
        return res.status(404).json({ error: "Guild not found" });
    }

    // get the user
    let member;
    try {
        member = await guildObj.members.fetch(user);
    } catch {
        return res.status(404).json({ error: "User not found" });
    }

    // timeout the user
    try {
        await member.timeout(time || (1000 * 60 * 60), "API TIMEOUT REQUEST");
    } catch {
        return res.status(500).json({ error: "Failed to timeout user" });
    }

    return res.json({ success: true });
})

actionsRouter.post("/ban", async (req, res) => {
    const { user, guild } = req.body;

    console.log(`Banning user ${user} in guild ${guild}`);

    if (!user || !guild) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // get the guild
    let guildObj;
    try {
        guildObj = await client.guilds.fetch(guild);
    } catch {
        return res.status(404).json({ error: "Guild not found" });
    }

    // get the user
    let member;
    try {
        member = await guildObj.members.fetch(user);
    } catch {
        return res.status(404).json({ error: "User not found" });
    }

    // ban the user
    try {
        await member.ban({
            reason: "API BAN REQUEST"
        });
    } catch {
        return res.status(500).json({ error: "Failed to ban user" });
    }

    return res.json({ success: true });
})

apiRouter.use("/actions", actionsRouter);
app.use("/api", apiRouter);

app.listen(PORT, () => {
    console.log(`API Server running on port ${PORT}`);
});
