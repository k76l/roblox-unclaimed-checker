const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// senin Discord webhook'un
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

function extractGroupId(text) {
  const match = text.match(/\d+/);
  return match ? match[0] : null;
}

app.post("/check", async (req, res) => {
  const input = req.body.input;
  if (!input) return res.json({ error: "input parametresi gerekli" });

  const groupId = extractGroupId(input);
  if (!groupId) return res.json({ error: "Geçersiz grup linki" });

  const apiUrl = `https://groups.roblox.com/v1/groups/${groupId}`;
  const r = await axios.get(apiUrl);
  const data = r.data;

  if (data.owner === null) {
    await axios.post(DISCORD_WEBHOOK, {
      content: `⚠️ **Unclaimed group found!**\nhttps://www.roblox.com/groups/${groupId}`
    });
    return res.json({ unclaimed: true, groupId });
  } else {
    return res.json({ unclaimed: false, owner: data.owner.name });
  }
});

app.listen(3000, () => console.log("Bot çalışıyor: http://localhost:3000"));

