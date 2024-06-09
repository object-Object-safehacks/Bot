import dotenv from "dotenv";
dotenv.config();

const _oldconsolelog = console.log;
console.log = function () {
    _oldconsolelog(new Date().toISOString(), ...arguments);
};

import fs from "fs";
import { Client, Collection, Events, GatewayIntentBits, Partials, PermissionsBitField } from "discord.js";
import fetch from "node-fetch";
import express from "express";
import path from "path";

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;

const REPORT_ENDPOINT = process.env.REPORT_ENDPOINT;

const MESSAGE_VERIFICATION_ENDPOINT = process.env.MESSAGE_VERIFICATION_ENDPOINT;
const MESSAGE_VERIFICATION_ENDPOINT_AUTH = process.env.MESSAGE_VERIFICATION_ENDPOINT_AUTH;

const IMAGES_ENDPOINT = process.env.IMAGES_ENDPOINT;

// === BASE FUNCTIONS ===

async function report(message, attachments, reason) {
    const res = await fetch(REPORT_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            user: message.author.id,
            guild: message.guild.id,
            channel: message.channel.id,
            message: message.id,
            content: message.content,
            attachments: attachments,
            reason: reason,
            time: new Date().toISOString()
        }),
    });
    
    if (res.ok) { 
        console.log(`Reported message from ${message.author.tag} in guild ${message.guild.name}`);

        const data = await res.json();
        return data.captcha;
    } else {
        console.error(`Failed to report message from ${message.author.tag} in guild ${message.guild.name}`);
    }
}

async function validateMessage(contextObj, messageObj) {
    const contextStr = contextObj.map((c) => `${c.user}: ${c.content}`).join("\n");
    const message = messageObj.user + ": " + messageObj.content;

    const samplesDirectory = path.join(__dirname, "prompts", "samples");

    const messages = [
        {
            role: "system",
            content: fs.readFileSync(path.join(__dirname, prompts, 'system.txt'), "utf-8")
        }
    ]

    // for every sample directory in the samples directory, read the user.txt and assistant.txt files
    for (const sample of fs.readdirSync(samplesDirectory)) {
        const userPath = path.join(samplesDirectory, sample, "user.txt");
        const assistantPath = path.join(samplesDirectory, sample, "assistant.txt");

        if (fs.existsSync(userPath) && fs.existsSync(assistantPath)) {
            messages.push({
                role: "user",
                content: fs.readFileSync(userPath, "utf-8")
            });

            messages.push({
                role: "assistant",
                content: fs.readFileSync(assistantPath, "utf-8")
            });
        }
    }

    messages.push({
        role: "user",
        content: "Context:\n" +
            contextStr +
            "\n" +
            "Message:\n" +
            message,
    });

    const res = await fetch(MESSAGE_VERIFICATION_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "authorization": "Bearer " + MESSAGE_VERIFICATION_ENDPOINT_AUTH
        },
        body: JSON.stringify({
            messages,
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

async function validateImages(urls) {
    console.log(urls);

    const res = await fetch(IMAGES_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            files: urls
        }),
    });

    if (res.ok) {
        return await res.json();
    } 

    console.error("Image Validation Service returned non-ok status code.\nContent:\n\n" + await res.text());
    return { results: [] };
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

    // check if there is context for the channel    
    if (!context.has(message.channel.id)) {
        context.set(message.channel.id, []);
    }

    const contextObj = context.get(message.channel.id).slice(-3);

    const attachmentURLs = message.attachments.map((attachment) => attachment.url);
    if (attachmentURLs.length > 0) {
        console.log(`Received message with attachments: ${attachmentURLs.join(", ")}`);
        
        // validate the image
        const responses = await validateImages(attachmentURLs);

        for (const response of responses.results) {
            if (response) {
                const baseDomain = new URL(IMAGES_ENDPOINT).hostname;
                message.reply('Bad image detected. Please do not send inappropriate images.\n' +
                    "https://" + baseDomain + responses.urls[responses.results.indexOf(response)]);

                report(message, 'Images');
                return;
            }
        }

        if (message.content.length < 1) return; // no need to validate the message if there is no content
    }

    // validate the message
    const flagged = await validateMessage(contextObj, {
        user: message.author.tag,
        content: message.content
    });

    if (flagged.value) {
        console.log(`Message from ${message.author.tag} was flagged`);
        message.reply(flagged.reason);

        report(message, flagged.reason);
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
