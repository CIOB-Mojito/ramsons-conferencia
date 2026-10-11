const path = require("path");
const os = require("os");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");

const APP = "RAMSONS Conferência";
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const STARTED_AT = Date.now();

const store = require("./rconf-local-store");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.disable("x-powered-by");
app.use(express.json());

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        out.push({ iface: name, address: net.address });
      }
    }
  }
  return out;
}

function clientsCount() {
  let n = 0;
  wss.clients.forEach((c) => { if (c.readyState === 1) n++; });
  return n;
}

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    app: APP,
    server: "local",
    port: PORT,
    clients: clientsCount(),
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    network: lanAddresses(),
    websocket: { path: "/ws", connected: clientsCount() },
    time: new Date().toISOString()
  });
});

app.get("/api/ping", (req, res) => {
  res.json({ ok: true, message: "Comunicação com o servidor OK", app: APP });
});

/* =====================================================================
   API LOCAL MULTIUSUÁRIO
   A autorização vem SEMPRE da sessão (cookie HttpOnly ou Bearer token).
   O "user" enviado pelo cliente é IGNORADO. Cada requisição só enxerga
   a pasta do usuário autenticado.
   ===================================================================== */
const COOKIE = "rconf_sid";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 dias

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch (e) {}
    if (k) out[k] = v;
  });
  return out;
}

function tokenOf(req) {
  const c = parseCookies(req);
  if (c[COOKIE]) return c[COOKIE];
  const a = req.headers.authorization || "";
  if (a.indexOf("Bearer ") === 0) return a.slice(7).trim();
  return null;
}

function currentUser(req) {
  return store.userForToken(tokenOf(req));
}

function requireUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.rconfUser = u;
  req.rconfRole = store.roleOf(u);
  next();
}

function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.rconfUser = u;
  req.rconfRole = store.roleOf(u);
  if (req.rconfRole !== "ADM") {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  next();
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie",
    COOKIE + "=" + encodeURIComponent(token) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + COOKIE_MAX_AGE);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

app.post("/api/login", (req, res) => {
  const b = req.body || {};
  const user = String(b.usuario != null ? b.usuario : (b.user != null ? b.user : ""));
  const pin = String(b.pin != null ? b.pin : "");
  if (!store.auth(user, pin)) {
    return res.status(401).json({ ok: false, error: "invalid_credentials" });
  }
  const s = store.createSession(user);
  const acc = store.accountOf(user) || {};
  setSessionCookie(res, s.token);
  res.json({ ok: true, user: user, role: acc.role || null, id: acc.id || null, token: s.token, expiresAt: s.expiresAt });
});

app.post("/api/logout", (req, res) => {
  const t = tokenOf(req);
  if (t) store.destroySession(t);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", requireUser, (req, res) => {
  const a = store.accountOf(req.rconfUser);
  res.json({ ok: true, user: req.rconfUser, role: req.rconfRole, id: a ? a.id : null });
});

/* ---------- administração de usuários (só ADM) ----------
   A validação é feita NO SERVIDOR; esconder botões no cliente é apenas UI.
   O PIN nunca sai do servidor e nunca é retornado. */
app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json({ ok: true, usuarios: store.listAccounts() });
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const b = req.body || {};
  const usuario = b.usuario != null ? b.usuario : b.user;
  const pin = String(b.pin != null ? b.pin : "");
  const pinConfirm = String(b.pinConfirm != null ? b.pinConfirm : b.confirmarPin);
  if (pin !== pinConfirm) {
    return res.status(400).json({ ok: false, error: "pin_mismatch", message: "Os PINs não conferem" });
  }
  const r = store.createAccount({ user: usuario, pin: pin, role: b.tipo != null ? b.tipo : b.role });
  if (!r || r.ok !== true) {
    const status = r && r.code === "duplicate" ? 409 : 400;
    return res.status(status).json({ ok: false, error: r ? r.code : "invalid", message: r ? r.message : "Dados inválidos" });
  }
  res.status(201).json({ ok: true, usuario: r.usuario });
});

/* ---------- administração avançada (detalhes / rename / PIN / tipo) ----------
   Todas protegidas por requireAdmin (403 para usuários normais).
   O PIN nunca sai do servidor (reset fixo em 1355, sem retorno em claro). */
app.get("/api/admin/users/:id", requireAdmin, (req, res) => {
  const a = store.accountOf(req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: "not_found", message: "Usuário não encontrado" });
  res.json({ ok: true, usuario: { id: a.id, user: a.user, role: a.role, createdAt: a.createdAt } });
});

app.post("/api/admin/users/:id/rename", requireAdmin, (req, res) => {
  const r = store.renameAccount(req.params.id, req.body && req.body.nome);
  if (!r || r.ok !== true) {
    const status = r && r.code === "duplicate" ? 409 : r && r.code === "not_found" ? 404 : 400;
    return res.status(status).json({ ok: false, error: r ? r.code : "invalid", message: r ? r.message : "Dados inválidos" });
  }
  res.json({ ok: true, usuario: r.usuario });
});

app.post("/api/admin/users/:id/reset-pin", requireAdmin, (req, res) => {
  const r = store.setPin(req.params.id, "1355");
  if (!r || r.ok !== true) {
    const status = r && r.code === "not_found" ? 404 : 400;
    return res.status(status).json({ ok: false, error: r ? r.code : "invalid", message: r ? r.message : "Dados inválidos" });
  }
  res.json({ ok: true, message: "PIN redefinido com sucesso", usuario: r.usuario });
});

app.post("/api/admin/users/:id/role", requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = store.setRole(req.params.id, b.tipo != null ? b.tipo : b.role);
  if (!r || r.ok !== true) {
    const status = r && r.code === "not_found" ? 404 : 400;
    return res.status(status).json({ ok: false, error: r ? r.code : "invalid", message: r ? r.message : "Dados inválidos" });
  }
  res.json({ ok: true, usuario: r.usuario });
});

/* ---------- carga de conferência para um usuário (só ADM) ----------
   Cria uma NOVA conferência aberta para o usuário destinatário, identificado
   pelo ID interno (server resolve sempre pelo ID; nunca por um nome arbitrário
   dado pelo cliente). Não sobrescreve nem finaliza conferências abertas do
   destinatário e não toca conferências/histórico do administrador. O id da
   conferência é gerado pelo servidor (o cliente não pode forçá-lo). */
app.post("/api/admin/users/:id/conferencia", requireAdmin, (req, res) => {
  const me = store.accountOf(req.rconfUser);
  const target = store.accountOf(req.params.id);
  if (!target) {
    return res.status(404).json({ ok: false, error: "not_found", message: "Usuário não encontrado" });
  }
  if (me && target.id === me.id) {
    return res.status(400).json({ ok: false, error: "self_assign", message: "Não é possível carregar conferência para a própria conta" });
  }
  const b = req.body || {};
  const r = store.newConferenciaFor(target.id, { arquivo: b.arquivo, produtos: b.produtos });
  if (!r || r.ok !== true) {
    const status = r && r.code === "not_found" ? 404 : 400;
    return res.status(status).json({ ok: false, error: r ? r.code : "invalid", message: r ? r.message : "Dados inválidos" });
  }
  res.status(201).json({
    ok: true,
    message: "Conferência carregada para " + r.usuario.user,
    usuario: r.usuario,
    conferencia: { id: r.conferencia.id, arquivo: r.conferencia.arquivo, produtos: r.conferencia.produtos.length }
  });
});

/* ---------- exclusão de usuário ----------
   Toda a proteção é validada NO SERVIDOR (esconder o botão é só UI):
     - só ADM (403 para usuários normais);
     - a conta-alvo deve existir (404 se resolve por id/nome);
     - um administrador não pode excluir a própria conta;
     - o último ADM nunca pode ser excluído;
     - a exclusão remove conta + sessões + pastas de dados de forma coerente
       (o store aborta ou restaura se algo falhar). */
app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const me = store.accountOf(req.rconfUser);
  if (!me) return res.status(401).json({ ok: false, error: "unauthorized" });
  const target = store.accountOf(req.params.id);
  if (!target) {
    return res.status(404).json({ ok: false, error: "not_found", message: "Usuário não encontrado" });
  }
  if (target.id === me.id) {
    return res.status(400).json({ ok: false, error: "self_delete", message: "Não é possível excluir a própria conta" });
  }
  const r = store.deleteAccount(target.id);
  if (!r || r.ok !== true) {
    const code = r ? r.code : "invalid";
    const status = code === "not_found" ? 404
      : code === "last_admin" ? 400
      : (code === "storage" || code === "delete_incomplete") ? 500
      : 400;
    return res.status(status).json({ ok: false, error: code, message: r ? r.message : "Não foi possível excluir o usuário" });
  }
  res.json({ ok: true, message: "Usuário excluído com sucesso", deleted: r.deleted });
});

/* ---------- troca do próprio PIN (sempre a CONTA AUTENTICADA) ---------- */
app.post("/api/me/pin", requireUser, (req, res) => {
  const b = req.body || {};
  const atual = String(b.pinAtual != null ? b.pinAtual : "");
  const novo = String(b.pinNovo != null ? b.pinNovo : "");
  const novoConfirm = String(b.pinNovoConfirm != null ? b.pinNovoConfirm : b.confirmarPin);
  if (!store.auth(req.rconfUser, atual)) {
    return res.status(400).json({ ok: false, error: "pin_invalid", message: "PIN atual incorreto" });
  }
  if (novo !== novoConfirm) {
    return res.status(400).json({ ok: false, error: "pin_mismatch", message: "Os novos PINs não conferem" });
  }
  const r = store.setPin(req.rconfUser, novo);
  if (!r || r.ok !== true) {
    return res.status(400).json({ ok: false, error: r ? r.code : "invalid", message: r ? r.message : "Dados inválidos" });
  }
  res.json({ ok: true, message: "PIN alterado com sucesso" });
});

app.get("/api/conferencia-atual", requireUser, (req, res) => {
  res.json({ ok: true, conferencia: store.getConf(req.rconfUser) });
});

app.get("/api/conferencias", requireUser, (req, res) => {
  res.json({ ok: true, conferencias: store.listOpenConfs(req.rconfUser) });
});

app.get("/api/conferencias/:id", requireUser, (req, res) => {
  const conf = store.getOpenConf(req.rconfUser, req.params.id);
  if (!conf) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, conferencia: conf });
});

app.post("/api/conferencia", requireUser, (req, res) => {
  const b = req.body || {};
  const conf = store.startConf(req.rconfUser, { id: b.id, arquivo: b.arquivo, produtos: b.produtos });
  res.json({ ok: true, conferencia: conf });
});

app.put("/api/conferencia/produto", requireUser, (req, res) => {
  const b = req.body || {};
  const val = b.conferido === null || b.conferido === undefined ? null : b.conferido;
  const conf = store.setProduto(req.rconfUser, b.codigo, val, b.id);
  if (!conf) return res.status(404).json({ ok: false, error: "no_conference" });
  res.json({ ok: true, conferencia: conf });
});

app.post("/api/conferencia/finalizar", requireUser, (req, res) => {
  const b = req.body || {};
  const conf = store.finishConf(req.rconfUser, b.id);
  if (!conf) return res.status(404).json({ ok: false, error: "no_conference" });
  res.json({ ok: true, conferencia: conf });
});

app.delete("/api/conferencias/:id", requireUser, (req, res) => {
  const r = store.deleteOpenConf(req.rconfUser, req.params.id);
  if (!r || r.ok !== true) {
    const status = r && r.code === "not_found" ? 404 : 400;
    return res.status(status).json({ ok: false, error: r ? r.code : "invalid", message: r ? r.message : "Não foi possível remover a conferência" });
  }
  res.json({ ok: true, message: "Conferência removida" });
});

app.delete("/api/historico/:id", requireUser, (req, res) => {
  const r = store.deleteHistConf(req.rconfUser, req.params.id);
  if (!r || r.ok !== true) {
    const status = r && r.code === "not_found" ? 404 : 400;
    return res.status(status).json({ ok: false, error: r ? r.code : "invalid", message: r ? r.message : "Não foi possível remover a conferência" });
  }
  res.json({ ok: true, message: "Conferência removida" });
});

app.get("/api/historico", requireUser, (req, res) => {
  res.json({ ok: true, historico: store.listHist(req.rconfUser) });
});

app.get("/api/historico/:id", requireUser, (req, res) => {
  const conf = store.getHist(req.rconfUser, req.params.id);
  if (!conf) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, conferencia: conf });
});

const publicDir = path.join(__dirname, "public");
const BLOCKED = ["server.js", "package.json", "package-lock.json", "node_modules", "data", "rconf-local-store.js"];

app.use((req, res, next) => {
  const rel = path.normalize(req.path).replace(/^(\.\.[/\\])+/, "");
  const first = rel.split(/[/\\]/).filter(Boolean)[0];
  if (first && BLOCKED.includes(first)) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }
  next();
});

app.use(express.static(__dirname, { index: "index.html", dotfiles: "deny" }));
app.use(express.static(publicDir, { index: "index.html" }));

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", path: req.originalUrl });
});

function log(...args) {
  console.log(...args);
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function broadcast(payload, except) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((c) => {
    if (c !== except && c.readyState === 1) c.send(data);
  });
}

wss.on("connection", (ws, req) => {
  const ip = (req.socket.remoteAddress || "?").replace("::ffff:", "");
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  log(`[ws] cliente conectado  ip=${ip}  total=${clientsCount()}`);

  send(ws, {
    type: "hello",
    app: APP,
    server: "local",
    port: PORT,
    clients: clientsCount(),
    time: new Date().toISOString()
  });

  broadcast({ type: "presence", event: "join", clients: clientsCount(), ip }, ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return send(ws, { type: "error", message: "invalid_json" });
    }

    log(`[ws] mensagem recebida  type=${msg.type}  ip=${ip}`);

    if (msg.type === "ping") {
      return send(ws, { type: "pong", time: new Date().toISOString(), clients: clientsCount() });
    }

    if (msg.type === "echo") {
      return send(ws, { type: "echo", echo: msg.payload ?? null, from: ip });
    }

    if (msg.type === "broadcast") {
      broadcast({
        type: "broadcast",
        from: ip,
        payload: msg.payload ?? null,
        time: new Date().toISOString()
      });
      return send(ws, { type: "broadcast_sent", clients: clientsCount() });
    }

    send(ws, { type: "error", message: "unknown_type", types: ["ping", "echo", "broadcast"] });
  });

  ws.on("close", () => {
    log(`[ws] cliente desconectado ip=${ip}  total=${clientsCount()}`);
    broadcast({ type: "presence", event: "leave", clients: clientsCount() });
  });

  ws.on("error", (err) => {
    log(`[ws] erro: ${err.message}`);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  const addrs = lanAddresses();

  console.log("");
  console.log("  RAMSONS Conferência — servidor local");
  console.log("  ------------------------------------");
  console.log(`  Local:     http://localhost:${PORT}`);
  if (addrs.length === 0) {
    console.log("  Rede:      nenhuma interface detectada");
  } else {
    addrs.forEach((a) => console.log(`  Rede (${a.iface}):  http://${a.address}:${PORT}`));
  }
  console.log(`  Status:    http://localhost:${PORT}/api/status`);
  console.log(`  WebSocket: ws://<ip>:${PORT}/ws`);
  console.log("");
});

process.on("SIGINT", () => {
  console.log("\n[server] encerrando...");
  clearInterval(heartbeat);
  wss.clients.forEach((c) => c.close());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
