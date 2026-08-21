require("dotenv").config();
const { WebSocketServer } = require("ws");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");

const SECRET           = process.env.WS_SECRET || "changeme";
const BOT_TOKEN        = process.env.DISCORD_TOKEN;
const LOG_CHANNEL      = process.env.LOG_CHANNEL_ID;
const BRAINROT_CHANNEL = process.env.BRAINROT_CHANNEL_ID;
const REBIRTH_CHANNEL  = process.env.REBIRTH_CHANNEL_ID;
const PORT             = process.env.PORT || 3000;

console.log("[CONFIG] LOG_CHANNEL      =", LOG_CHANNEL      || "❌ NICHT GESETZT");
console.log("[CONFIG] BRAINROT_CHANNEL =", BRAINROT_CHANNEL || "❌ NICHT GESETZT");
console.log("[CONFIG] REBIRTH_CHANNEL  =", REBIRTH_CHANNEL  || "❌ NICHT GESETZT");
console.log("[CONFIG] SECRET set       =", !!SECRET);
console.log("[CONFIG] BOT_TOKEN set    =", !!BOT_TOKEN);

// ── Server Queue (Fetcher → Railway → Lua) ────────────────────
const serverQueue = [];          // {id, ping, fps, playing, maxPlayers, ts}
const QUEUE_MAX   = 2500;
const QUEUE_TTL   = 30_000;     // 30 s – alte Einträge raus

function queuePrune() {
    const cutoff = Date.now() - QUEUE_TTL;
    let i = 0;
    while (i < serverQueue.length && serverQueue[i].ts < cutoff) i++;
    if (i > 0) serverQueue.splice(0, i);
}

// ── Discord ────────────────────────────────────────────────────
const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

let discordReady = false;
discord.once("ready", async () => {
    discordReady = true;
    console.log(`[DISCORD] ✅ Bot eingeloggt als ${discord.user.tag}`);

    // Startup-Test: alle Channels direkt prüfen
    for (const [label, id] of [
        ["LOG_CHANNEL",      LOG_CHANNEL],
        ["BRAINROT_CHANNEL", BRAINROT_CHANNEL],
        ["REBIRTH_CHANNEL",  REBIRTH_CHANNEL],
    ]) {
        if (!id) { console.error(`[DISCORD] ❌ ${label} nicht gesetzt`); continue; }
        try {
            const ch = await discord.channels.fetch(id);
            if (ch) console.log(`[DISCORD] ✅ ${label} gefunden: #${ch.name}`);
            else     console.error(`[DISCORD] ❌ ${label} = null`);
        } catch (e) {
            console.error(`[DISCORD] ❌ ${label} (${id}) FEHLER: ${e.message}`);
        }
    }
});

discord.login(BOT_TOKEN).catch(e => console.error("[DISCORD] Login fehlgeschlagen:", e.message));

function fmtValue(v) {
    if (!v && v !== 0) return "?";
    if (v >= 1e15) return `${(v/1e15).toFixed(2)}Q`;
    if (v >= 1e12) return `${(v/1e12).toFixed(2)}T`;
    if (v >= 1e9)  return `${(v/1e9).toFixed(2)}B`;
    if (v >= 1e6)  return `${(v/1e6).toFixed(2)}M`;
    if (v >= 1e3)  return `${(v/1e3).toFixed(1)}K`;
    return String(v);
}

async function postEmbed(channelId, embed) {
    if (!channelId) {
        console.error("[DISCORD] postEmbed: channelId nicht gesetzt — ENV fehlt?");
        return;
    }
    // Warte bis Bot ready ist (max 10s)
    if (!discordReady) {
        console.log("[DISCORD] Bot noch nicht ready — warte...");
        const t0 = Date.now();
        await new Promise(r => {
            const iv = setInterval(() => {
                if (discordReady || Date.now()-t0 > 10000) { clearInterval(iv); r(); }
            }, 200);
        });
        if (!discordReady) {
            console.error("[DISCORD] Bot immer noch nicht ready — abbruch");
            return;
        }
    }
    try {
        console.log(`[DISCORD] Sende in Channel ${channelId}...`);
        const ch = await discord.channels.fetch(channelId);
        if (!ch) { console.error(`[DISCORD] Channel ${channelId} = null`); return; }
        await ch.send({ embeds: [embed] });
        console.log(`[DISCORD] ✅ Gesendet in #${ch.name} (${channelId})`);
    } catch (e) {
        console.error(`[DISCORD ERROR] Channel=${channelId} — ${e.message}`);
        console.error(e.stack);
    }
}

// ── Express (Railway health check + HTTP broker) ───────────────
const app = express();
app.use(express.json());
app.get("/", (_, res) => res.send("Orbit WS Server running"));

// POST /feed  — Python fetcher pushes server batches here
// Body: { secret: string, servers: [{id, ping, fps, playing, maxPlayers}] }
app.post("/feed", (req, res) => {
    const { secret, servers } = req.body || {};
    if (secret !== SECRET) return res.status(403).json({ error: "forbidden" });
    if (!Array.isArray(servers) || servers.length === 0)
        return res.status(400).json({ error: "no servers" });

    queuePrune();
    const now = Date.now();
    for (const s of servers) {
        if (serverQueue.length >= QUEUE_MAX) break;
        serverQueue.push({ id: s.id, ping: s.ping ?? 0, fps: s.fps ?? 60,
                           playing: s.playing ?? 0, maxPlayers: s.maxPlayers ?? 0, ts: now });
    }
    console.log(`[FEED] +${servers.length} servers | queue=${serverQueue.length}`);
    res.json({ ok: true, queued: serverQueue.length });
});

// POST /get_server  — Lua bot pops next server from queue
// Body: { secret: string }
app.post("/get_server", (req, res) => {
    const { secret } = req.body || {};
    if (secret !== SECRET) return res.status(403).json({ error: "forbidden" });

    queuePrune();
    if (serverQueue.length === 0)
        return res.json({ status: "empty" });

    const entry = serverQueue.shift();
    res.json({
        status:     "ok",
        job_id:     entry.id,
        ping:       entry.ping,
        fps:        entry.fps,
        playing:    entry.playing,
        maxPlayers: entry.maxPlayers,
    });
});
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

        // ── REBIRTH ──
        else if (type === "rebirth") {
            const { rebirth, elapsed } = data;
            const embed = new EmbedBuilder()
                .setTitle(`✅ Rebirth ${rebirth} abgeschlossen!`)
                .setColor(0x00FF88)
                .addFields(
                    { name: "Bot",     value: botName || "?",              inline: true },
                    { name: "Rebirth", value: String(rebirth ?? "?"),      inline: true },
                    { name: "Zeit",    value: elapsed || "?",              inline: true },
                    { name: "Job ID",  value: `\`${String(jobId).slice(0,16)}...\``, inline: false }
                )
                .setFooter({ text: "Orbit WS • Rebirth" })
                .setTimestamp();
            postEmbed(REBIRTH_CHANNEL, embed);
            postEmbed(LOG_CHANNEL, new EmbedBuilder()
                .setTitle(`⭐ Rebirth ${rebirth} – ${botName}`)
                .setColor(0x00FF88)
                .addFields(
                    { name: "Bot",  value: botName || "?", inline: true },
                    { name: "Zeit", value: elapsed || "?", inline: true }
                )
                .setTimestamp()
            );
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
            const { bestPet, bestValue, bestMut, owner, isBypass, isDuel, isCarpet, pets, players, maxPlayers, playerInfos } = data;
            console.log(`[BRAINROT] ⚡ Empfangen: ${bestPet} | $${fmtValue(bestValue)}/s | Owner=${owner} | Pets=${Array.isArray(pets)?pets.length:0} | Players=${players}`);

            const valueStr = fmtValue(bestValue);

            let petList = "";
            if (Array.isArray(pets)) {
                pets.slice(0, 10).forEach((p, i) => {
                    const mut = p.mutation && p.mutation !== "None" ? `[${p.mutation}] ` : "";
                    petList += `#${i+1} ${mut}${p.name} ($${fmtValue(p.value)}/s)\n`;
                });
                if (pets.length > 10) petList += `... und ${pets.length - 10} mehr`;
            }

            // Spielerliste mit Rebirths
            let playerList = "";
            if (Array.isArray(playerInfos) && playerInfos.length > 0) {
                playerInfos.slice(0, 15).forEach((p) => {
                    const rb = p.rebirths != null ? `${fmtValue(p.rebirths)} RB` : "? RB";
                    playerList += `${p.name} — ${rb}\n`;
                });
                if (playerInfos.length > 15) playerList += `... und ${playerInfos.length - 15} mehr`;
            } else {
                playerList = "?";
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
                    { name: "Pets",      value: `\`\`\`\n${petList || "?"}\`\`\``, inline: false },
                    { name: "Spieler + Rebirths", value: `\`\`\`\n${playerList}\`\`\``, inline: false }
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
