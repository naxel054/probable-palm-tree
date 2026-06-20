const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const cors    = require('cors');
const path    = require('path');
const multer  = require('multer');

const app  = express();
const PORT = process.env.PORT || 3000;
const SECRET       = 'mcpanel_jwt_secret_2024';
const AGENT_SECRET = process.env.AGENT_SECRET || 'bigchillSMP_secret_2024';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Données ───────────────────────────────────────────────────
const users = [];
let serverLogs    = {};
let serverPlayers = {};
let fileRequests  = [];
let fileResponses = {};
let consoleQueue  = [];
let cmdResults    = {};

const SERVERS = [
  { id: 'bigchillSMP', name: 'BigChillSMP', description: 'Serveur SMP principal', icon: '⛏️', port: 50000 },
  { id: 'bigchilltest', name: 'BigChillTest', description: 'Serveur Test',            icon: '🎯', port: 50001 },
];

const serverStates = {};
SERVERS.forEach(s => {
  serverStates[s.id]  = { status: 'stopped', requested_by: null, updated_at: new Date().toISOString() };
  serverLogs[s.id]    = [];
  serverPlayers[s.id] = [];
});

const userServerAccess = {};

const envUser = process.env.ADMIN_USER;
const envPass = process.env.ADMIN_PASS;
if (envUser && envPass) {
  users.push({ id: 1, username: envUser, password: bcrypt.hashSync(envPass, 10), is_admin: 1, permissions: {} });
  console.log(`✅ Admin "${envUser}" créé !`);
}

// ── Auth ──────────────────────────────────────────────────────
function auth(req, res, next) {
  try {
    req.user = jwt.verify((req.headers.authorization || '').split(' ')[1], SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token invalide' }); }
}

function adminOnly(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  next();
}

function hasServerAccess(userId, serverId) {
  const user = users.find(u => u.id === userId);
  if (!user) return false;
  if (user.is_admin) return true;
  return (userServerAccess[userId] || []).includes(serverId);
}

function hasPerm(userId, perm) {
  const user = users.find(u => u.id === userId);
  if (!user) return false;
  if (user.is_admin) return true;
  return !!(user.permissions || {})[perm];
}

// ── Login ─────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Identifiants incorrects' });
  const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, SECRET, { expiresIn: '24h' });
  res.json({ token, username: user.username, is_admin: user.is_admin });
});

// ── Serveurs ──────────────────────────────────────────────────
app.get('/api/servers', auth, (req, res) => {
  const accessible = SERVERS.filter(s => hasServerAccess(req.user.id, s.id));
  res.json(accessible.map(s => ({ ...s, state: serverStates[s.id] })));
});

app.get('/api/servers/:id/status', auth, (req, res) => {
  const { id } = req.params;
  if (!hasServerAccess(req.user.id, id)) return res.status(403).json({ error: 'Accès refusé' });
  const server = SERVERS.find(s => s.id === id);
  if (!server) return res.status(404).json({ error: 'Introuvable' });
  const user = users.find(u => u.id === req.user.id);
  const logs = (serverLogs[id] || []).slice(-80);
  const players = serverPlayers[id] || [];
  res.json({ ...serverStates[id], logs, players, server, permissions: user?.permissions || {} });
});

function serverAction(action) {
  return (req, res) => {
    const { id } = req.params;
    if (!hasServerAccess(req.user.id, id)) return res.status(403).json({ error: 'Accès refusé' });
    const state = serverStates[id];
    if (!state) return res.status(404).json({ error: 'Introuvable' });
    const permMap = { start: 'can_start', stop: 'can_stop', restart: 'can_restart', fix: 'can_fix' };
    if (!req.user.is_admin && !hasPerm(req.user.id, permMap[action]))
      return res.status(403).json({ error: 'Permission refusée' });
    if (action === 'start' && !['stopped','unknown'].includes(state.status))
      return res.status(409).json({ error: `Déjà : ${state.status}` });
    if (action === 'restart' && !['running'].includes(state.status))
      return res.status(409).json({ error: 'Pas en ligne' });
    serverStates[id] = {
      status: action === 'fix' ? 'fixing' : action === 'stop' ? 'stopping' : action === 'start' ? 'starting' : action === 'restart' ? 'restarting' : 'fixing',
      requested_by: req.user.username,
      updated_at: new Date().toISOString()
    };
    res.json({ success: true, message: `Action ${action} envoyée !` });
  };
}

app.post('/api/servers/:id/start',   auth, serverAction('start'));
app.post('/api/servers/:id/stop',    auth, serverAction('stop'));
app.post('/api/servers/:id/restart', auth, serverAction('restart'));
app.post('/api/servers/:id/fix',     auth, serverAction('fix'));

// ── Console commande ──────────────────────────────────────────
app.post('/api/servers/:id/console', auth, async (req, res) => {
  const { id } = req.params;
  if (!hasServerAccess(req.user.id, id))
    return res.status(403).json({ error: 'Accès refusé' });
  if (!req.user.is_admin && !hasPerm(req.user.id, 'can_console'))
    return res.status(403).json({ error: 'Permission refusée' });
  const { command } = req.body;
  if (!command || !command.trim())
    return res.status(400).json({ error: 'Commande vide' });

  const cmdId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  consoleQueue.push({ id: cmdId, serverId: id, command: command.trim(), by: req.user.username });

  const start = Date.now();
  while (Date.now() - start < 20000) {
    if (cmdResults[cmdId] !== undefined) {
      const r = cmdResults[cmdId];
      delete cmdResults[cmdId];
      return res.json({ success: r.ok, message: r.ok ? `Commande envoyée !` : 'Erreur envoi commande' });
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  res.status(504).json({ error: 'Agent timeout' });
});

// ── Explorateur de fichiers ───────────────────────────────────
function makeFileReq(action, filePath, serverId, data = null) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fileRequests.push({ id, action, path: filePath, serverId, data });
  return id;
}

async function waitForResponse(reqId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fileResponses[reqId] !== undefined) {
      const res = fileResponses[reqId];
      delete fileResponses[reqId];
      return res;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

app.get('/api/files/:id', auth, async (req, res) => {
  if (!hasPerm(req.user.id, 'can_view_files')) return res.status(403).json({ error: 'Permission refusée' });
  const reqId = makeFileReq('list', req.query.path || '', req.params.id || 'bigchillSMP');
  const result = await waitForResponse(reqId);
  if (!result) return res.status(504).json({ error: 'Agent timeout' });
  res.json(result);
});

app.get('/api/files/:id/download', auth, async (req, res) => {
  if (!hasPerm(req.user.id, 'can_view_files')) return res.status(403).json({ error: 'Permission refusée' });
  const reqId = makeFileReq('download', req.query.path || '', req.params.id || 'bigchillSMP');
  const result = await waitForResponse(reqId);
  if (!result || !result.data) return res.status(504).json({ error: 'Agent timeout' });
  const filename = path.basename(req.query.path);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(result.data, 'base64'));
});

app.post('/api/files/:id/upload', auth, upload.single('file'), async (req, res) => {
  if (!hasPerm(req.user.id, 'can_edit_files')) return res.status(403).json({ error: 'Permission refusée' });
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
  const filePath = req.body.path || req.file.originalname;
  const b64 = req.file.buffer.toString('base64');
  const reqId = makeFileReq('upload', filePath, req.params.id || 'bigchillSMP', b64);
  const result = await waitForResponse(reqId);
  if (!result) return res.status(504).json({ error: 'Agent timeout' });
  res.json({ success: result.ok, message: result.ok ? `"${req.file.originalname}" uploadé !` : 'Erreur upload' });
});

app.delete('/api/files/:id', auth, async (req, res) => {
  if (!hasPerm(req.user.id, 'can_edit_files')) return res.status(403).json({ error: 'Permission refusée' });
  const reqId = makeFileReq('delete', req.query.path || '', req.params.id || 'bigchillSMP');
  const result = await waitForResponse(reqId);
  if (!result) return res.status(504).json({ error: 'Agent timeout' });
  res.json({ success: result.ok });
});

// ── Agent endpoints ───────────────────────────────────────────
app.get('/api/agent/poll', (req, res) => {
  if (req.query.secret !== AGENT_SECRET) return res.status(403).json({ error: 'Accès refusé' });
  const pending = [...fileRequests];
  const cmds    = [...consoleQueue];
  fileRequests  = [];
  consoleQueue  = [];
  res.json({ servers: serverStates, file_requests: pending, console_commands: cmds });
});

app.post('/api/agent/sync', (req, res) => {
  if (req.query.secret !== AGENT_SECRET) return res.status(403).json({ error: 'Accès refusé' });
  const { statuses } = req.body;
  Object.entries(statuses || {}).forEach(([sid, status]) => {
    if (serverStates[sid] && serverStates[sid].status === 'stopped') {
      serverStates[sid].status = status;
      serverStates[sid].updated_at = new Date().toISOString();
    }
  });
  res.json({ success: true });
});

app.post('/api/agent/confirm', (req, res) => {
  if (req.query.secret !== AGENT_SECRET) return res.status(403).json({ error: 'Accès refusé' });
  const { serverId, status } = req.body;
  if (serverStates[serverId]) {
    serverStates[serverId].status = status;
    serverStates[serverId].updated_at = new Date().toISOString();
  }
  res.json({ success: true });
});

app.post('/api/agent/logs', (req, res) => {
  if (req.query.secret !== AGENT_SECRET) return res.status(403).json({ error: 'Accès refusé' });
  const { logs, serverId, players } = req.body;
  if (serverId && Array.isArray(logs)) {
    serverLogs[serverId] = logs;
  } else if (Array.isArray(logs)) {
    serverLogs['bigchillSMP'] = logs;
  }
  if (serverId && Array.isArray(players)) {
    serverPlayers[serverId] = players;
  }
  res.json({ success: true });
});

app.post('/api/agent/cmd-done', (req, res) => {
  if (req.query.secret !== AGENT_SECRET) return res.status(403).json({ error: 'Accès refusé' });
  const { id, ok } = req.body;
  if (id) cmdResults[id] = { ok: !!ok };
  res.json({ success: true });
});

app.post('/api/agent/file-response', (req, res) => {
  if (req.query.secret !== AGENT_SECRET) return res.status(403).json({ error: 'Accès refusé' });
  const { results } = req.body;
  (results || []).forEach(r => { fileResponses[r.id] = r; });
  res.json({ success: true });
});

// ── Admin users ───────────────────────────────────────────────
app.post('/api/admin/create-user', auth, adminOnly, (req, res) => {
  const { username, password, is_admin = 0, permissions = {}, serverAccess = [] } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Nom déjà pris' });
  const id = users.length + 1;
  users.push({ id, username, password: bcrypt.hashSync(password, 10), is_admin: is_admin ? 1 : 0, permissions });
  userServerAccess[id] = serverAccess;
  res.json({ success: true, message: `Compte "${username}" créé !` });
});

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  res.json(users.map(u => ({
    id: u.id,
    username: u.username,
    is_admin: u.is_admin,
    permissions: u.permissions,
    serverAccess: userServerAccess[u.id] || []
  })));
});

app.patch('/api/admin/users/:id/permissions', auth, adminOnly, (req, res) => {
  const user = users.find(u => u.id == req.params.id);
  if (!user) return res.status(404).json({ error: 'Introuvable' });
  user.permissions = req.body.permissions || {};
  if (req.body.is_admin !== undefined) user.is_admin = req.body.is_admin ? 1 : 0;
  userServerAccess[user.id] = req.body.serverAccess || [];
  res.json({ success: true, message: 'Permissions sauvegardées !' });
});

app.delete('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const idx = users.findIndex(u => u.id == req.params.id);
  if (idx !== -1) users.splice(idx, 1);
  res.json({ success: true });
});

app.get('/api/admin/servers', auth, adminOnly, (req, res) => res.json(SERVERS));

// ── IA Chat ───────────────────────────────────────────────────
app.post('/api/ia', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'Messages manquants' });

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        messages: [
          {
            role: 'system',
            content: `Tu es l'assistant IA intégré au panel de gestion des serveurs Minecraft de Naxel. Tu connais parfaitement ce panel et tu aides les utilisateurs à comprendre comment il fonctionne.

Voici comment fonctionne ce panel :

**Le panel gère 2 serveurs Minecraft :**
- BigChillSMP (port 50000) : le serveur SMP principal
- BigChillTest (port 50001) : le serveur de test

**Fonctionnalités du panel :**
- Démarrer / Arrêter / Redémarrer / Fix un serveur via des boutons
- Voir les logs en temps réel de chaque serveur
- Voir les joueurs connectés
- Envoyer des commandes dans la console du serveur
- Explorateur de fichiers (voir, télécharger, uploader, supprimer des fichiers)
- Gestion des utilisateurs avec permissions granulaires (admin peut créer des comptes avec accès limité)

**Permissions disponibles pour les utilisateurs non-admin :**
- can_start : démarrer le serveur
- can_stop : arrêter le serveur
- can_restart : redémarrer le serveur
- can_fix : fix le serveur
- can_console : envoyer des commandes console
- can_view_files : voir les fichiers
- can_edit_files : modifier/uploader/supprimer des fichiers

**Comment fonctionne le système :**
- Un agent Python tourne sur la machine qui héberge les serveurs Minecraft
- L'agent poll le panel toutes les secondes pour récupérer les actions à effectuer
- L'agent envoie les logs et le statut des serveurs au panel en temps réel

Tu réponds en français, de façon claire et concise. Tu peux aussi répondre à des questions générales sur Minecraft et la gestion de serveurs.`
          },
          ...messages
        ]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ reply: data.choices[0].message.content });

  } catch (err) {
    console.error('Erreur IA:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur lancé sur le port ${PORT}`));
