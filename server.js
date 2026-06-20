const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(__dirname));

// Route qui appelle l'API Anthropic (la clé reste cachée côté serveur)
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages manquants' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: `Tu es CraftBot, un assistant IA expert des serveurs Minecraft. Tu réponds UNIQUEMENT aux questions liées à Minecraft et aux serveurs Minecraft (plugins, configuration, commandes, performances, mods, Spigot, Paper, Bukkit, Forge, Fabric, WorldGuard, EssentialsX, etc.).

Si la question n'est pas liée à Minecraft ou aux serveurs Minecraft, réponds gentiment que tu es spécialisé uniquement dans Minecraft et redirige l'utilisateur vers une question sur son serveur.

Règles de réponse :
- Réponds en français
- Sois précis, pratique et concis
- Utilise des exemples de commandes quand c'est pertinent (avec des blocs de code)
- Utilise des emojis Minecraft de temps en temps (⛏️🎮🗡️🛡️📦)
- Si tu donnes des commandes, mets-les dans des blocs de code
- Structure tes réponses avec des points si nécessaire`,
        messages: messages
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    res.json({ reply: data.content[0].text });

  } catch (err) {
    console.error('Erreur API:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.listen(PORT, () => {
  console.log(`CraftBot lancé sur le port ${PORT}`);
});
