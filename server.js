require("dotenv").config();
const { WebSocketServer } = require("ws");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");

const SECRET         = process.env.WS_SECRET || "changeme";
const BOT_TOKEN      = process.env.DISCORD_TOKEN;
const LOG_CHANNEL    = process.env.LOG_CHANNEL_ID;
const BRAINROT_CHANNEL = process.env.BRAINROT_CHANNEL_ID;
const PORT           = process.env.PORT || 3000;

// ── Discord ────────────────────────────────────────────────────
const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
discord.login(BOT_TOKEN).then(() => console.log("[DISCORD] Bot logged in"));

async function postEmbed(channelId, embed) {
    if (!channelId) return;
    try {
        const ch = await discord.channels.fetch(channelId);
        await ch.send({ embeds: [embed] });
    } catch (e) {
        console.error("[DISCORD ERROR]", e.message);
    }
}

// ── Express (Railway health check) ────────────────────────────
const app = express();
app.get("/", (_, res) => res.send("Orbit WS Server running"));
const server = app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));

// ── WebSocket Server ───────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ingest" });
const clients = new Map();

wss.on("connection", (ws, req) => {
    console.log(`[WS] Connection from ${req.socket.remoteAddress}`);
    clients.set(ws, { authed: false, botName: "?", jobId: "?" });

    ws.on("close", () => {
        const s = clients.get(ws);
        console.log(`[WS] Disconnected: ${s?.botName}`);
        clients.delete(ws);
    });

    ws.on("message", async (raw) => {
        const state = clients.get(ws);
        if (!state) return;

        // ── Auth (erster Message = Secret) ──
        if (!state.authed) {
            if (raw.toString().trim() === SECRET) {
                state.authed = true;
                ws.send(JSON.stringify({ type: "auth_ok" }));
                console.log("[WS] Client authenticated");
            } else {
                console.log("[WS] Wrong secret — closing");
                ws.close();
            }
            return;
        }

        // ── JSON parse ──
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        const { type, botName, jobId } = data;
        if (botName) state.botName = botName;
        if (jobId)   state.jobId   = jobId;

        console.log(`[WS] ${type} | bot=${botName} | job=${String(jobId).slice(0,8)}`);

        // ── PING ──
        if (type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));

            const embed = new EmbedBuilder()
                .setTitle("🟢 Bot Online")
                .setColor(0x00ff88)
                .addFields(
                    { name: "Bot",    value: botName || "?", inline: true },
                    { name: "Job ID", value: `\`${String(jobId).slice(0,16)}...\``, inline: true },
                    { name: "Bots",   value: String(clients.size), inline: true }
                )
                .setFooter({ text: "Orbit WS" })
                .setTimestamp();
            postEmbed(LOG_CHANNEL, embed);
        }

        // ── HOP ──
        else if (type === "hop") {
            const embed = new EmbedBuilder()
                .setTitle("⚡ Bot hoppt Server")
                .setColor(0x5865F2)
                .addFields(
                    { name: "Bot",    value: botName || "?", inline: true },
                    { name: "Job ID", value: `\`${String(jobId).slice(0,16)}...\``, inline: true }
                )
                .setFooter({ text: "Orbit WS" })
                .setTimestamp();
            postEmbed(LOG_CHANNEL, embed);
        }

        // ── BRAINROT FOUND ──
        else if (type === "brainrot_found") {
            const { bestPet, bestValue, bestMut, owner, isBypass, isDuel, isCarpet, pets, players, maxPlayers } = data;

            const valueStr = bestValue >= 1e9  ? `${(bestValue/1e9).toFixed(2)}B`
                           : bestValue >= 1e6  ? `${(bestValue/1e6).toFixed(2)}M`
                           : bestValue >= 1e3  ? `${(bestValue/1e3).toFixed(1)}K`
                           : String(bestValue);

            let petList = "";
            if (Array.isArray(pets)) {
                pets.slice(0, 10).forEach((p, i) => {
                    const mut = p.mutation && p.mutation !== "None" ? `[${p.mutation}] ` : "";
                    const val = p.value >= 1e9  ? `${(p.value/1e9).toFixed(2)}B`
                              : p.value >= 1e6  ? `${(p.value/1e6).toFixed(2)}M`
                              : p.value >= 1e3  ? `${(p.value/1e3).toFixed(1)}K`
                              : String(p.value);
                    petList += `#${i+1} ${mut}${p.name} ($${val}/s)\n`;
                });
                if (pets.length > 10) petList += `... und ${pets.length - 10} mehr`;
            }

            const color = bestValue >= 500_000_000 ? 0xFFAA00
                        : isBypass ? 0xFF4444
                        : 0x00CCFF;

            const title = isBypass ? `⭐ BYPASS: ${bestPet}`
                        : bestValue >= 500_000_000 ? `🔥 GOOD PET: ${bestPet}`
                        : `🐾 Brainrot: ${bestPet}`;

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setColor(color)
                .addFields(
                    { name: "Wert",      value: `$${valueStr}/s`, inline: true },
                    { name: "Mutation",  value: bestMut || "None", inline: true },
                    { name: "Owner",     value: owner || "?", inline: true },
                    { name: "Duel",      value: isDuel ? "🔒 LOCKED" : "✅ FREE", inline: true },
                    { name: "Carpet",    value: isCarpet ? "✅ Ja" : "❌ Nein", inline: true },
                    { name: "Players",   value: `${players}/${maxPlayers}`, inline: true },
                    { name: "Bot",       value: botName || "?", inline: true },
                    { name: "Job ID",    value: `\`${String(jobId).slice(0,16)}...\``, inline: false },
                    { name: "Pets",      value: `\`\`\`\n${petList || "?"}\`\`\``, inline: false }
                )
                .setFooter({ text: "Orbit WS • Brainrot" })
                .setTimestamp();

            postEmbed(BRAINROT_CHANNEL, embed);
            postEmbed(LOG_CHANNEL, new EmbedBuilder()
                .setTitle(`🔔 Brainrot gefunden: ${bestPet}`)
                .setColor(color)
                .addFields({ name: "Bot", value: botName || "?", inline: true },
                            { name: "Owner", value: owner || "?", inline: true },
                            { name: "Wert", value: `$${valueStr}/s`, inline: true })
                .setTimestamp()
            );
        }
    });
});

// ── Active bots count log alle 60s ────────────────────────────
setInterval(() => {
    const authed = [...clients.values()].filter(c => c.authed).length;
    console.log(`[STATUS] ${authed} bot(s) connected`);
}, 60_000);
