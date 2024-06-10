import dotenv from "dotenv";
dotenv.config();

const _oldconsolelog = console.log;
console.log = function () {
    _oldconsolelog(new Date().toISOString(), ...arguments);
};

import fs from "fs";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Collection, Events, GatewayIntentBits, Partials, PermissionsBitField } from "discord.js";
import fetch from "node-fetch";
import express from "express";
import path from "path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;

const REPORT_ENDPOINT = process.env.REPORT_ENDPOINT;

const MESSAGE_VERIFICATION_ENDPOINT = process.env.MESSAGE_VERIFICATION_ENDPOINT;
const MESSAGE_VERIFICATION_ENDPOINT_AUTH = process.env.MESSAGE_VERIFICATION_ENDPOINT_AUTH;

const IMAGES_ENDPOINT = process.env.IMAGES_ENDPOINT;

// === BASE FUNCTIONS ===

async function report(message, attachments, reason) {
    console.log(`Reporting message from ${message.author.tag} in guild ${message.guild.name}`);

    const res = await fetch(REPORT_ENDPOINT + "/report", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            user: {
                id: message.author.id,
                name: message.author.tag
            },
            guild: message.guild.id,
            channel: {
                id: message.channel.id,
                name: message.channel.name
            },
            message: {
                id: message.id,
                content: message.content,
                attachments: attachments
            },
            reason: reason,
            time: new Date().toISOString()
        }),
    });
    
    if (res.ok) { 
        console.log(`Reported message from ${message.author.tag} in guild ${message.guild.name}`);
        try {
            await message.member.timeout(1000 * 65, "CAPTCHA WAIT FOR SOLVE");
        } catch {
            console.error(`Failed to timeout user ${message.author.tag} in guild ${message.guild.name}`);
        }

        const value = await res.json();

        const id = value.id;

        const linkButton = new ButtonBuilder()
            .setLabel("Solve CAPTCHA")
            .setURL(value.url)
            .setStyle(ButtonStyle.Link)

        const row = new ActionRowBuilder()
            .addComponents(linkButton);

        const watchMsg = await message.author.send({
            content: 
                `# MESSAGE FLAGGED\n` +
                `Your message \"${message.content}\" has been flagged ` +
                `for the following reason: ${reason}\n` +
                `Please solve the CAPTCHA in your direct messages to continue chatting.\n` +
                `An elevated punishment will be issued <t:${Math.floor(Date.now() / 1000) + 60}:R>.`,
            components: [row]
        });

        const timeout = setTimeout(async () => {
            try {
                clearInterval(checkLoop);
            } catch {
                // its fine if this fails
            }

            try {
                await watchMsg.edit({
                    content: `Session timed out. Your message has been reported to the server moderators.`,
                    components: []
                })
            } catch {
                console.error(`Failed to delete watch message..?`);
            }

            try {
                await message.delete();
            } catch {
                console.error(`Failed to delete message from ${message.author.tag} in guild ${message.guild.name}`);
            }

            try {
                // timeout
                await message.member.timeout(1000 * 60 * 60, "CAPTCHA TIMEOUT");
            } catch {
                console.error(`Failed to timeout user ${message.author.tag} in guild ${message.guild.name}`);
            }
        }, 1000 * 60)

        const checkLoop = setInterval(async () => {
            try {
                const res = await fetch(REPORT_ENDPOINT + "/getTurnstileStatus/" + id);

                if (res.ok) {
                    const value = await res.json();

                    if (value.completed) {
                        clearInterval(checkLoop);
                        clearTimeout(timeout);

                        try {
                            await watchMsg.edit({
                                content: `CAPTCHA solved. You may continue chatting.`,
                                components: []
                            })
                        } catch {
                            console.error(`Failed to delete watch message..?`);
                        }

                        try {
                            await message.member.timeout(null, "CAPTCHA SOLVED");
                        } catch {
                            console.error(`Failed to untimeout user ${message.author.tag} in guild ${message.guild.name}`);
                        }
                    }
                }
            } catch {
                console.error(`Failed to check CAPTCHA status for ${message.author.tag} in guild ${message.guild.name}`);
            }
        }, 1000)
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
            content: fs.readFileSync(path.join(__dirname, "prompts", 'system.txt'), "utf-8")
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
        content: "[[[CONTEXT]]]\n" +
            contextStr +
            "[[[CONTEXT]]]\n" +
            "[[[MESSAGE]]]\n" +
            message + "\n" + 
            "[[[MESSAGE]]]",
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
        const value = data.response.split("|")[1]

        let report;
        if (!value) {
            report = "No reason provided";
        } else {
            report = value.trim();
        }

        return {
            value: true,
            reason: report
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

function validateURLs(urls) {
    return urls.map((url) => {
        return false // placeholder
    })
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

    const attachmentURLs = message.content.match(/(https?:\/\/[^\s]+)/g) || [];
    
    // add any attachments to the list of URLs if they dont already exist
    for (const attachment of message.attachments.values()) {
        if (!attachmentURLs.includes(attachment.url)) {
            attachmentURLs.push(attachment.url);
        }
    }

    if (attachmentURLs.length > 0) {
        console.log(`Received message with attachments: ${attachmentURLs.join(", ")}`);
        
        // validate the image
        const responses = await validateImages(attachmentURLs);

        const urlsToScan = [];
        for (const response of responses.results) {
            if (response != null) {
                if (response) {
                    report(message, attachmentURLs, 'Images');
                    return;
                }
            } else {
                urlsToScan.push(responses.urls[responses.results.indexOf(response)]);
            }
        }

        if (urlsToScan.length > 0) {
            const urlResponses = await validateURLs(urlsToScan);

            for (const response of urlResponses) {
                if (response) {
                    report(message, attachmentURLs, 'URLs');
                    return;
                }
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
        report(message, attachmentURLs, flagged.reason);
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

apiRouter.get("/checkmessage/:guild/:channel/:message", async (req, res) => {
    const { guild, channel, message } = req.params;

    console.log(`Checking message ${message} in channel ${channel}`);

    if (!message || !channel) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // get the guild
    let guildObj;
    try {
        guildObj = await client.guilds.fetch(guild);
    } catch {
        return res.status(404).json({ error: "Guild not found" });
    }

    // get the channel
    let channelObj;
    try {
        channelObj = await guildObj.channels.fetch(channel);
    } catch {
        return res.status(404).json({ error: "Channel not found" });
    }

    // get the message
    let messageObj;
    try {
        messageObj = await channelObj.messages.fetch(message);
    } catch {
        return res.status(404).json({ error: "Message not found" });
    }

    return res.json({ message: messageObj });
});

const actionsRouter = express.Router();

actionsRouter.post("/delete", async (req, res) => {
    const { message, channel, guild } = req.body;

    console.log(`Deleting message ${message} in channel ${channel} in guild ${guild}`);

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
        messageObj = await (await guildObj.channels.fetch(channel)).messages.fetch(message);
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

actionsRouter.post("/untimeout", async (req, res) => {
    const { user, guild } = req.body;

    console.log(`Untiming out user ${user} in guild ${guild}`);

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

    // untimeout the user
    try {
        await member.timeout(null, "API UNTIMEOUT REQUEST");
    } catch {
        return res.status(500).json({ error: "Failed to untimeout user" });
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
