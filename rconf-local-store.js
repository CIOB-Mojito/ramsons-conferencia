/* =====================================================================
   rconf-local-store.js — camada de dados LOCAL por usuário (servidor)

   O servidor é a fonte principal de verdade. Cada usuário tem a SUA pasta:

data/
     .sessions.json          -> tokens de sessão (nunca guarda PIN)
     accounts.json           -> contas com ID PERMANENTE (fonte de verdade v2)
     users.json              -> registros LEGADOS v1 (preservados, ignorados)
     <id-da-conta>/          -> pasta de dados por ID (independe do nome)
       conferenciaAtual.json -> conferência em andamento (ou null)
       historico.json        -> lista de conferências finalizadas
       opcoes.json           -> preferências do usuário

   Regras:
     - a identidade da conta é um ID interno permanente; o nome visível pode
       mudar sem trocar de pasta nem derrubar sessões/conferências/histórico;
     - só contas conhecidas têm pasta; nunca se aceita caminho do cliente;
     - escritas atômicas (tmp + rename);
     - o PIN nunca é persistido em claro (sempre scrypt + salt);
     - nenhuma chamada de rede/Internet.
   ===================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ADM = "ADM";
const USR = "USUARIO";

const USERS = [
  { user: "Ismael", pin: "1234", role: ADM },
  { user: "Anderson", pin: "1234", role: USR }
];

const DATA_DIR = process.env.RCONF_DATA_DIR
  ? path.resolve(process.env.RCONF_DATA_DIR)
  : path.join(__dirname, "data");

const SESS_FILE = path.join(DATA_DIR, ".sessions.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json"); // v2: ID permanente (fonte de verdade)
const LEGACY_USERS_FILE = path.join(DATA_DIR, "users.json"); // v1 legado (preservado, nunca apagado)
const TOMBSTONES_FILE = path.join(DATA_DIR, ".tombstones.json"); // exclusões permanentes (anti-ressurreição)
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

/* ---------- identidade permanente das contas (v2) ----------
   Cada conta tem um ID interno (id) único e permanente, independente do nome
   visível. A fonte de verdade é data/accounts.json (v2):

     { version: 2, updatedAt, accounts: [ { id, name, role, salt, hash, createdAt, source } ] }

   Os PINs sempre como scrypt+salt, nunca em claro. Os seeds (Ismael/Anderson)
   são migrados UMA única vez para accounts.json com o hash dos seus PINs.

   Migração segura (v1 -> v2):
     - preserva users.json (legado) e .sessions.json (com backup .bak-<ts>);
     - nunca apaga nem sobrescreve dados;
     - a pasta de dados passa a ser data/<id>; se alguma pasta não puder ser
       movida, o acesso volta ao caminho legado gravado na conta (sem perda);
     - se falhar ao gravar accounts.json, a migração é interrompida sem
       alterar nada (último recurso: contas em memória). */
function saltHex() { return crypto.randomBytes(16).toString("hex"); }
function pinHash(pin, salt) {
  return crypto.scryptSync(String(pin), String(salt), 32).toString("hex");
}

function seedId(name) {
  return "usr_seed_" + String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
}
function newAccountId() {
  return "usr_" + crypto.randomBytes(8).toString("hex");
}

/* ---------- tombstones de exclusão (anti-ressurreição) ----------
   Quando uma conta é excluída, guardamos { id, name, at, seed } em
   .tombstones.json (arquivo SEPARADO do registro). Assim, se accounts.json
   for perdido/reconstruído (migração legada), uma conta excluída — inclusive
   uma conta inicial como Anderson — NÃO pode reaparecer com um novo ID. */
function loadTombstones() {
  const t = readJSON(TOMBSTONES_FILE, null);
  const list = t && Array.isArray(t.deleted) ? t.deleted : [];
  return list.filter((x) => x && (typeof x.id === "string" || typeof x.name === "string"));
}
function saveTombstones(list) {
  return writeJSON(TOMBSTONES_FILE, { version: 1, updatedAt: Date.now(), deleted: list });
}
function isDeleted(idOrName) {
  if (typeof idOrName !== "string" || !idOrName) return false;
  const low = idOrName.toLowerCase();
  return loadTombstones().some((t) =>
    (typeof t.id === "string" && t.id === idOrName) ||
    (typeof t.name === "string" && t.name.toLowerCase() === low));
}
function rollbackTombstone(id) {
  if (!id) return;
  const l = loadTombstones().filter((t) => !(t && typeof t.id === "string" && t.id === id));
  saveTombstones(l);
}

let registry = null; // cache por processo das contas (accounts.json)

function saveRegistry(accs) {
  return writeJSON(ACCOUNTS_FILE, { version: 2, updatedAt: Date.now(), accounts: accs });
}

function migrateFolders(accs) {
  // Cosmético: move data/<nome> -> data/<id>. Se falhar, o acesso continua
  // garantido pelo caminho legado gravado na conta (userDir).
  for (const a of accs) {
    if (!a.name || a.name === a.id) continue;
    const src = path.join(DATA_DIR, a.name);
    const dst = path.join(DATA_DIR, a.id);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try { fs.renameSync(src, dst); } catch (e) { /* fallback em userDir cobre */ }
  }
}

function buildRegistryFromLegacy() {
  const accs = [];
  for (const s of USERS) {
    if (isDeleted(s.user)) continue;          // conta inicial excluída: não ressuscitar
    const salt = saltHex();
    const rec = { id: seedId(s.user), name: s.user, role: s.role || USR, salt, hash: pinHash(s.pin, salt), createdAt: 0, source: "seed" };
    if (fs.existsSync(path.join(DATA_DIR, rec.name))) rec.legacy = rec.name;
    accs.push(rec);
  }
  const legacy = readJSON(LEGACY_USERS_FILE, []);
  if (Array.isArray(legacy)) {
    for (const a of legacy) {
      if (!a || typeof a.user !== "string" || !a.user.trim()) continue;
      if (isDeleted(a.id) || isDeleted(a.user.trim())) continue;  // excluída: não reaparecer
      const salt = a.salt || saltHex();
      const rec = {
        id: typeof a.id === "string" && a.id ? a.id : newAccountId(),
        name: a.user.trim(),
        role: a.role === ADM ? ADM : USR,
        salt: salt,
        hash: a.hash || pinHash("", salt),
        createdAt: a.createdAt || 0,
        source: "created"
      };
      if (fs.existsSync(path.join(DATA_DIR, rec.name))) rec.legacy = rec.name;
      accs.push(rec);
    }
  }
  // backup dos arquivos legados ANTES de qualquer mudança (não apaga nada)
  const ts = Date.now();
  for (const f of [LEGACY_USERS_FILE, SESS_FILE]) {
    try { if (fs.existsSync(f)) fs.copyFileSync(f, f + ".bak-" + ts); } catch (e) {}
  }
  if (!saveRegistry(accs)) {
    throw new Error("[migração] não foi possível gravar accounts.json — interrompida sem alterar nada");
  }
  return accs;
}

function registryFromMemory() {
  // Último recurso: se a gravação da migração falhar, tudo segue em memória.
  const accs = [];
  for (const s of USERS) {
    if (isDeleted(s.user)) continue;          // conta inicial excluída: não ressuscitar
    const salt = saltHex();
    accs.push({ id: seedId(s.user), name: s.user, role: s.role || USR, salt, hash: pinHash(s.pin, salt), createdAt: 0, source: "seed" });
  }
  const legacy = readJSON(LEGACY_USERS_FILE, []);
  if (Array.isArray(legacy)) {
    for (const a of legacy) {
      if (!a || typeof a.user !== "string") continue;
      if (isDeleted(a.id) || isDeleted(a.user.trim())) continue;  // excluída: não reaparecer
      const salt = a.salt || saltHex();
      accs.push({ id: a.id || newAccountId(), name: a.user, role: a.role === ADM ? ADM : USR, salt, hash: a.hash || pinHash("", salt), createdAt: a.createdAt || 0, source: "created" });
    }
  }
  return accs;
}

function loadRegistry() {
  if (registry) return registry;
  const raw = readJSON(ACCOUNTS_FILE, null);
  if (raw && Array.isArray(raw.accounts)) { registry = raw.accounts; return registry; }
  try {
    registry = buildRegistryFromLegacy();
    migrateFolders(registry);
  } catch (e) {
    console.error("[contas] erro na migração:", e.message);
    registry = registryFromMemory();
  }
  return registry;
}

function resolveAccount(idOrName) {
  if (typeof idOrName !== "string" || !idOrName) return null;
  const name = idOrName.toLowerCase();
  const accs = loadRegistry();
  for (let i = 0; i < accs.length; i++) {
    const a = accs[i];
    if (a.id === idOrName || (typeof a.name === "string" && a.name.toLowerCase() === name)) return a;
  }
  return null;
}

function accountOf(user) {
  const a = resolveAccount(user);
  if (!a) return null;
  return { id: a.id, user: a.name, role: a.role || USR, createdAt: a.createdAt || 0, source: a.source };
}

function roleOf(user) {
  const a = accountOf(user);
  return a ? a.role : null;
}

function isKnown(user) {
  return accountOf(user) !== null;
}

function accountExists(name) {
  const n = String(name || "").toLowerCase();
  return loadRegistry().some((a) => typeof a.name === "string" && a.name.toLowerCase() === n);
}

function listAccounts() {
  return loadRegistry().map((a) => ({ id: a.id, user: a.name, role: a.role || USR, createdAt: a.createdAt || 0 }));
}

function createAccount(info) {
  info = info || {};
  const name = String(info.user == null ? "" : info.user).trim();
  const pin = String(info.pin == null ? "" : info.pin);
  const role = info.role === ADM ? ADM : info.role === USR ? USR : null;

  if (!name) return { ok: false, code: "name_required", message: "Informe o nome do usuário" };
  if (name.length > 24 || !/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(name)) {
    return { ok: false, code: "name_invalid", message: "Nome inválido (3 a 24 caracteres, sem símbolos)" };
  }
  if (name.length < 3) {
    return { ok: false, code: "name_invalid", message: "Nome muito curto (mínimo 3 caracteres)" };
  }
  if (!/^\d{4,12}$/.test(pin)) {
    return { ok: false, code: "pin_invalid", message: "O PIN deve ter de 4 a 12 dígitos" };
  }
  if (!role) return { ok: false, code: "role_invalid", message: "Tipo de conta inválido" };
  if (accountExists(name)) return { ok: false, code: "duplicate", message: "Já existe um usuário com esse nome" };

  const accs = loadRegistry();
  const salt = saltHex();
  const rec = { id: newAccountId(), name, role, salt, hash: pinHash(pin, salt), createdAt: Date.now(), source: "created" };
  accs.push(rec);
  if (!saveRegistry(accs)) {
    return { ok: false, code: "storage", message: "Não foi possível salvar o usuário" };
  }
  return { ok: true, usuario: { id: rec.id, user: rec.name, role: rec.role, createdAt: rec.createdAt } };
}

/* ---------- administração de contas (rename / PIN / tipo) ---------- */
function renameAccount(idOrName, newName) {
  const accs = loadRegistry();
  const a = resolveAccount(idOrName);
  if (!a) return { ok: false, code: "not_found", message: "Conta não encontrada" };
  const name = String(newName == null ? "" : newName).trim();
  if (name.length < 3 || name.length > 24 || !/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(name)) {
    return { ok: false, code: "name_invalid", message: "Nome inválido (3 a 24 caracteres, sem símbolos)" };
  }
  const dup = accs.find((x) => x.id !== a.id && typeof x.name === "string" && x.name.toLowerCase() === name.toLowerCase());
  if (dup) return { ok: false, code: "duplicate", message: "Já existe um usuário com esse nome" };

  const oldName = a.name;
  if (oldName === name) {
    return { ok: true, noop: true, usuario: { id: a.id, user: a.name, role: a.role, createdAt: a.createdAt } };
  }
  a.name = name;
  if (!saveRegistry(accs)) { a.name = oldName; return { ok: false, code: "storage", message: "Não foi possível salvar" }; }

  // o ID e a pasta de dados NÃO mudam; só se sincronizam as sessões que ainda
  // referenciavam o nome antigo (as que guardam uid já são resilientes).
  const sessions = loadSessions();
  let changed = false;
  for (const k in sessions) {
    const s = sessions[k];
    if (s && (s.uid === a.id || s.user === oldName)) {
      s.user = name; s.uid = a.id; changed = true;
    }
  }
  if (changed) saveSessions(sessions);
  return { ok: true, usuario: { id: a.id, user: a.name, role: a.role, createdAt: a.createdAt } };
}

function setPin(idOrName, newPin) {
  const accs = loadRegistry();
  const a = resolveAccount(idOrName);
  if (!a) return { ok: false, code: "not_found", message: "Conta não encontrada" };
  const pin = String(newPin == null ? "" : newPin);
  if (!/^\d{4,12}$/.test(pin)) {
    return { ok: false, code: "pin_invalid", message: "O PIN deve ter de 4 a 12 dígitos" };
  }
  a.salt = saltHex();
  a.hash = pinHash(pin, a.salt);
  if (!saveRegistry(accs)) return { ok: false, code: "storage", message: "Não foi possível salvar" };
  return { ok: true, usuario: { id: a.id, user: a.name, role: a.role, createdAt: a.createdAt } };
}

function setRole(idOrName, role) {
  const accs = loadRegistry();
  const a = resolveAccount(idOrName);
  if (!a) return { ok: false, code: "not_found", message: "Conta não encontrada" };
  const novo = role === ADM ? ADM : role === USR ? USR : null;
  if (!novo) return { ok: false, code: "role_invalid", message: "Tipo de conta inválido" };
  if (novo === USR && a.role === ADM) {
    const admins = accs.filter((x) => x.role === ADM);
    if (admins.length <= 1) {
      return { ok: false, code: "last_admin", message: "Não é possível rebaixar o último administrador" };
    }
  }
  const oldRole = a.role;
  a.role = novo;
  if (!saveRegistry(accs)) { a.role = oldRole; return { ok: false, code: "storage", message: "Não foi possível salvar" }; }
  return { ok: true, usuario: { id: a.id, user: a.name, role: a.role, createdAt: a.createdAt } };
}

/* ---------- exclusão de usuário ----------
   Remove a conta de forma COERENTE:
     1. valida (existe / não é o último ADM);
     2. persiste um TOMBSTONE em .tombstones.json (anti-ressurreição: a conta
        não pode reaparecer se accounts.json for reconstruído) — se falhar,
        nada é tocado e a conta segue íntegra;
     3. remove do registro (accounts.json) de forma atômica — se falhar,
        o tombstone é desfeito e nada é apagado;
     4. encerra todas as sessões da conta (por ID permanente ou nome);
     5. apaga as pastas atribuídas a ela: data/<id> e, se vier da migração v1,
        a pasta legada gravada na conta. Se alguma pasta não puder ser
        removida, a conta é RESTAURADA no registro, o tombstone é desfeito e o
        erro é reportado — nunca se anuncia sucesso com dados pendentes.
   O parâmetro é sempre um id nome ATUAL ou ID permanente; os caminhos vêm do
   registro e nunca da requisição. Toda remoção é validada para permanecer
   dentro de DATA_DIR. */
function deleteAccount(idOrName) {
  const accs = loadRegistry();
  const a = resolveAccount(idOrName);
  if (!a) return { ok: false, code: "not_found", message: "Conta não encontrada" };

  // Nunca remover o último ADM (proteção também para chamadas diretas ao store).
  if (a.role === ADM) {
    const admins = accs.filter((x) => x.role === ADM);
    if (admins.length <= 1) {
      return { ok: false, code: "last_admin", message: "Não é possível excluir o último administrador" };
    }
  }

  // Pastas de dados APENAS desta conta: pelo ID permanente e, se houver, a
  // pasta legada da migração v1 -> v2 (evita dados abandonados). Validado.
  const dirs = [];
  const addDir = (base, name) => {
    if (!name || typeof name !== "string" || !name) return;
    const root = path.resolve(DATA_DIR);
    const rp = path.resolve(base, name);
    if (rp === root || rp.indexOf(root + path.sep) !== 0) return; // nunca fora do diretório de dados
    if (path.relative(root, rp).split(path.sep).indexOf("..") !== -1) return;
    if (dirs.indexOf(rp) === -1) dirs.push(rp);
  };
  addDir(DATA_DIR, a.id);
  if (a.legacy) addDir(DATA_DIR, a.legacy);

  // 1) tombstone persistente ANTES de qualquer mudança no registro.
  const tbase = loadTombstones();
  const tadded = { id: a.id, name: a.name, at: Date.now(), seed: a.source === "seed" };
  tbase.push(tadded);
  if (!saveTombstones(tbase)) {
    return { ok: false, code: "storage", message: "Não foi possível registrar a exclusão" };
  }

  // 2) remove do registro (fonte de verdade) de forma atômica.
  const idx = accs.indexOf(a);
  if (idx === -1) {
    rollbackTombstone(a.id);
    return { ok: false, code: "not_found", message: "Conta não encontrada" };
  }
  accs.splice(idx, 1);
  if (!saveRegistry(accs)) {
    accs.splice(idx, 0, a); // rollback em memória: nenhum dado foi tocado
    rollbackTombstone(a.id); // desfaz o tombstone persistido (a conta segue íntegra)
    return { ok: false, code: "storage", message: "Não foi possível salvar a exclusão" };
  }

  // 3) encerra todas as sessões desta conta (por ID permanente ou nome).
  const all = loadSessions();
  let changed = false, sessDel = 0;
  for (const k in all) {
    const s = all[k];
    if (s && (s.uid === a.id || (typeof s.user === "string" && s.user.toLowerCase() === a.name.toLowerCase()))) {
      delete all[k]; changed = true; sessDel++;
    }
  }
  if (changed) saveSessions(all);

  // 4) apaga as pastas atribuídas; em caso de falha, restaura a conta.
  const deletedDirs = [], failDirs = [];
  for (const d of dirs) {
    const r = removeDataDir(d);
    if (r.ok) deletedDirs.push(d); else failDirs.push({ dir: d, error: r.error });
  }
  if (failDirs.length) {
    accs.push(a);
    saveRegistry(accs);
    rollbackTombstone(a.id); // a exclusão não foi concluída; a conta segue viva
    return {
      ok: false,
      code: "delete_incomplete",
      message: "A exclusão não foi concluída; os dados restantes foram preservados. Tente novamente.",
      deletedDirs: deletedDirs,
      failDirs: failDirs
    };
  }

  return { ok: true, deleted: { id: a.id, user: a.name, dirs: deletedDirs.length, sessions: sessDel } };
}

function removeDataDir(p) {
  try {
    const rp = path.resolve(p);
    const root = path.resolve(DATA_DIR);
    if (rp === root || rp.indexOf(root + path.sep) !== 0) {
      return { ok: false, error: "fora do diretório autorizado" };
    }
    if (!fs.existsSync(rp)) return { ok: true };
    try {
      fs.rmSync(rp, { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      // fallback manual (apenas dentro do diretório já validado)
      const stack = [rp];
      const todos = [];
      let erro = null;
      while (stack.length) {
        const cur = stack.pop();
        todos.push(cur);
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
        catch (e2) { erro = e2; continue; }
        for (const en of entries) {
          const fp = path.join(cur, en.name);
          if (en.isDirectory()) stack.push(fp); else todos.push(fp);
        }
      }
      for (let i = todos.length - 1; i >= 0; i--) {
        try {
          const st = fs.lstatSync(todos[i]);
          if (st.isDirectory()) fs.rmdirSync(todos[i]); else fs.unlinkSync(todos[i]);
        } catch (e3) { erro = e3; }
      }
      if (erro) return { ok: false, error: String((erro && erro.message) || erro) };
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- básicos ---------- */
function auth(user, pin) {
  const a = resolveAccount(user);
  if (!a) return false;
  if (a.salt && a.hash) return pinHash(String(pin == null ? "" : pin), a.salt) === a.hash;
  return false;
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}

function userDir(user) {
  const a = resolveAccount(user);
  if (!a) return null;                     // nunca caminho arbitrário
  const byId = path.join(DATA_DIR, a.id);
  if (fs.existsSync(byId)) { ensureDir(byId); return byId; }
  const legacy = a.legacy && path.join(DATA_DIR, a.legacy);
  if (legacy && fs.existsSync(legacy)) { ensureDir(legacy); return legacy; }
  ensureDir(byId);
  return byId;
}

function fileFor(user, name) {
  const dir = userDir(user);
  return dir ? path.join(dir, name) : null;
}

function readJSON(file, fallback) {
  if (!file) return fallback;
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, value) {
  if (!file) return false;
  try {
    ensureDir(path.dirname(file));
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- conferências ----------
   Várias conferências ABERTAS por usuário (cada uma com ID, arquivo, produtos,
   quantidades e progresso próprios), que podem ser retomadas por separado e
   finalizadas de forma independente — abrir um novo arquivo NUNCA sobrescreve
   outra conferência aberta.

   Storage por usuário:
     conferencias.json     -> lista das conferências ABERTAS (fonte de verdade),
                              ordenada da MAIS recente para a mais antiga;
     conferenciaAtual.json -> ESPELHO de compatibilidade com leituras antigas:
                              guarda a conferência ABERTA mais recente (ou null);
     historico.json        -> conferências FINALIZADAS (não reaparecem nas abertas).

   Migração segura: se conferencias.json ainda não existir, um valor existente
   em conferenciaAtual.json vira a lista inicial; nada é apagado ou sobrescrito. */
function openConfsFile(user) {
  const dir = userDir(user);
  return dir ? path.join(dir, "conferencias.json") : null;
}

function openConfsRaw(user) {
  if (!isKnown(user)) return [];
  const list = readJSON(openConfsFile(user), null);
  if (Array.isArray(list)) return list;
  // migração do formato atual (um arquivo conferenciaAtual.json):
  // preserva a conferência em andamento existente como a primeira da lista.
  const c = readJSON(fileFor(user, "conferenciaAtual.json"), null);
  if (c && typeof c === "object" && c.id) return [c];
  return [];
}

function saveOpenConfs(user, list) {
  if (!isKnown(user)) return false;
  const dir = userDir(user);
  if (!dir) return false;
  const ok = writeJSON(path.join(dir, "conferencias.json"), list);
  writeJSON(path.join(dir, "conferenciaAtual.json"), list.length ? list[0] : null);
  return ok;
}

function listOpenConfs(user) {
  if (!isKnown(user)) return [];
  const seen = {};
  const out = [];
  for (const c of openConfsRaw(user)) {
    if (!c || typeof c !== "object" || !c.id || seen[c.id]) continue; // nunca duplica
    seen[c.id] = true;
    out.push(c);
  }
  return out;
}

function getOpenConf(user, id) {
  if (!id) return null;
  for (const c of listOpenConfs(user)) if (c.id === id) return c;
  return null;
}

function getConf(user) {   // "conferência atual": a ABERTA mais recente (ou null)
  if (!isKnown(user)) return null;
  const l = listOpenConfs(user);
  return l.length ? l[0] : null;
}

function normalizeProduto(p) {
  return {
    codigo: String(p && p.codigo != null ? p.codigo : ""),
    descricao: String(p && p.descricao != null ? p.descricao : ""),
    esperado: Number(p && p.esperado) || 0,
    conferido: p && p.conferido == null ? null : Number(p.conferido) || 0,
    status: p && p.status === "conferido" ? "conferido" : "pendente"
  };
}

function targetConf(user, id) {
  const list = listOpenConfs(user);
  if (!list.length) return null;
  if (id) return getOpenConf(user, id) || null;
  return list[0];   // idêntico ao comportamento anterior quando há 1 aberta
}

function startConf(user, info) {
  if (!isKnown(user)) return null;
  info = info || {};
  const now = Date.now();
  const produtos = Array.isArray(info.produtos) ? info.produtos.map(normalizeProduto) : [];
  let list = listOpenConfs(user);
  // upsert idempotente: se o id já existe (retomada da MESMA conferência),
  // NÃO duplica — substitui o valor anterior e move para o topo.
  if (info.id) list = list.filter((c) => c.id !== info.id);
  const conf = {
    id: info.id || ("C-" + now.toString(36) + "-" + crypto.randomBytes(4).toString("hex")),
    arquivo: String(info.arquivo || ""),
    criadaEm: info.criadaEm || now,
    atualizadaEm: now,
    produtos: produtos
  };
  list.unshift(conf);
  saveOpenConfs(user, list);
  return conf;
}

function saveConf(user, conf, id) {
  if (!isKnown(user) || !conf || typeof conf !== "object" || !conf.id) return false;
  conf.atualizadaEm = Date.now();
  const list = listOpenConfs(user);
  const idx = list.findIndex((c) => c.id === conf.id);
  if (idx >= 0) list[idx] = conf;
  else list.unshift(conf);        // retomada offline de uma conf que estava no espelho
  return saveOpenConfs(user, list);
}

function setProduto(user, codigo, conferido, id) {
  const list = listOpenConfs(user);
  if (!list.length) return null;
  const target = id ? list.find((c) => c.id === id) || null : list[0];
  if (!target) return null;
  const alvo = String(codigo);
  let achou = false;
  target.produtos = (target.produtos || []).map((p) => {
    if (String(p.codigo) !== alvo) return p;
    achou = true;
    if (conferido === null || conferido === undefined) {
      return { codigo: p.codigo, descricao: p.descricao, esperado: p.esperado, conferido: null, status: "pendente" };
    }
    return { codigo: p.codigo, descricao: p.descricao, esperado: p.esperado, conferido: Number(conferido) || 0, status: "conferido" };
  });
  if (!achou) return target;
  target.atualizadaEm = Date.now();
  saveOpenConfs(user, list);
  return target;
}

function clearConf(user, id) {
  if (!isKnown(user)) return false;
  const list = listOpenConfs(user);
  const next = id ? list.filter((c) => c.id !== id) : list.slice(1); // sem id: remove a mais recente
  return saveOpenConfs(user, next);
}

function finishConf(user, id) {
  if (!isKnown(user)) return null;
  const target = targetConf(user, id);
  if (!target) return null;
  const now = Date.now();
  target.finalizadaEm = now;
  target.atualizadaEm = now;
  const hist = listHist(user);
  if (!hist.some((h) => h && h.id === target.id)) hist.push(target);  // nunca duplica
  writeJSON(fileFor(user, "historico.json"), hist);
  saveOpenConfs(user, listOpenConfs(user).filter((c) => c.id !== target.id));
  return target;
}

function listHist(user) {
  if (!isKnown(user)) return [];
  const h = readJSON(fileFor(user, "historico.json"), []);
  return Array.isArray(h) ? h : [];
}

function getHist(user, id) {
  const h = listHist(user);
  for (let i = 0; i < h.length; i++) if (h[i] && h[i].id === id) return h[i];
  return null;
}

function deleteOpenConf(user, id) {
  if (!isKnown(user) || !id) return { ok: false, code: "not_found", message: "Conferência não encontrada" };
  const list = listOpenConfs(user);
  const next = list.filter((c) => c && c.id !== id);
  if (next.length === list.length) {
    return { ok: false, code: "not_found", message: "Conferência não encontrada" };
  }
  if (!saveOpenConfs(user, next)) {
    return { ok: false, code: "storage", message: "Não foi possível remover a conferência" };
  }
  return { ok: true };
}

function deleteHistConf(user, id) {
  if (!isKnown(user) || !id) return { ok: false, code: "not_found", message: "Conferência não encontrada" };
  const h = listHist(user);
  const next = h.filter((x) => x && x.id !== id);
  if (next.length === h.length) {
    return { ok: false, code: "not_found", message: "Conferência não encontrada" };
  }
  if (!writeJSON(fileFor(user, "historico.json"), next)) {
    return { ok: false, code: "storage", message: "Não foi possível remover a conferência" };
  }
  return { ok: true };
}

/* ---------- carga de conferência por ADM (destino pelo ID interno) ----------
   Cria UMA NOVA conferência ABERTA para o usuário destinatário, com id próprio
   (o id nunca vem do cliente). Não sobrescreve nem finaliza conferências
   abertas existentes; não toca conferências/histórico do administrador. */
function cleanProdutos(list) {
  if (!Array.isArray(list)) return { ok: false, message: "Conteúdo do arquivo inválido" };
  if (!list.length) return { ok: false, message: "O arquivo não contém produtos" };
  if (list.length > 10000) return { ok: false, message: "Arquivo muito grande (máximo 10.000 produtos)" };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, message: "Conteúdo do arquivo inválido" };
    const codigo = String(p.codigo == null ? "" : p.codigo).trim();
    if (!codigo) return { ok: false, message: "Conteúdo do arquivo inválido (código vazio)" };
    if (codigo.length > 80) return { ok: false, message: "Código de produto muito longo" };
    const descricao = String(p.descricao == null ? "" : p.descricao).slice(0, 200);
    const exp = Number(p.esperado);
    const esperado = Number.isFinite(exp) && exp >= 0 ? exp : 0;
    let conferido = null;
    if (p.conferido != null) {
      const c = Number(p.conferido);
      conferido = Number.isFinite(c) && c >= 0 ? c : null;
    }
    const status = p.status === "conferido" ? "conferido" : "pendente";
    out.push({ codigo, descricao, esperado, conferido, status });
  }
  return { ok: true, list: out };
}

function newConferenciaFor(ownerAccountId, info) {
  const a = resolveAccount(ownerAccountId);
  if (!a) return { ok: false, code: "not_found", message: "Usuário não encontrado" };
  const cleaned = cleanProdutos((info && info.produtos) || null);
  if (!cleaned.ok) return { ok: false, code: "produtos_invalid", message: cleaned.message };
  const arquivo = String(info && info.arquivo != null ? info.arquivo : "").slice(0, 140);
  const conf = startConf(a.name, { arquivo, produtos: cleaned.list });
  if (!conf) return { ok: false, code: "storage", message: "Não foi possível salvar a conferência" };
  return { ok: true, conferencia: conf, usuario: { id: a.id, user: a.name, role: a.role } };
}

function resumo(conf) {
  if (!conf || !Array.isArray(conf.produtos)) return null;
  let total = conf.produtos.length, conferidos = 0, esperado = 0, encontrado = 0;
  const divergencias = [];
  for (const p of conf.produtos) {
    esperado += Number(p.esperado) || 0;
    if (p.status === "conferido") {
      conferidos++;
      const c = Number(p.conferido) || 0;
      encontrado += c;
      const dif = c - (Number(p.esperado) || 0);
      if (dif !== 0) divergencias.push({ codigo: p.codigo, descricao: p.descricao, esperado: Number(p.esperado) || 0, conferido: c, diferenca: dif });
    }
  }
  return { id: conf.id, arquivo: conf.arquivo, total, conferidos, esperado, encontrado, diferencaTotal: encontrado - esperado, divergencias };
}

/* ---------- opções ---------- */
function getOpcoes(user) {
  if (!isKnown(user)) return {};
  const o = readJSON(fileFor(user, "opcoes.json"), {});
  return o && typeof o === "object" ? o : {};
}

function setOpcoes(user, opcoes) {
  if (!isKnown(user) || !opcoes || typeof opcoes !== "object") return false;
  return writeJSON(fileFor(user, "opcoes.json"), opcoes);
}

/* ---------- sessões (token -> usuário) ---------- */
function loadSessions() {
  const s = readJSON(SESS_FILE, {});
  return s && typeof s === "object" ? s : {};
}

function saveSessions(s) {
  writeJSON(SESS_FILE, s);
}

function createSession(user) {
  const a = resolveAccount(user);
  if (!a) return null;
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  const all = loadSessions();
  all[token] = { user: a.name, uid: a.id, createdAt: now, expiresAt: now + SESSION_TTL_MS };
  saveSessions(all);
  return { token: token, user: a.name, expiresAt: now + SESSION_TTL_MS };
}

function userForToken(token) {
  if (!token || typeof token !== "string") return null;
  const all = loadSessions();
  const s = all[token];
  if (!s) return null;
  const a = resolveAccount(s.uid || s.user);
  if (!a) { delete all[token]; saveSessions(all); return null; }
  if (s.expiresAt && Date.now() > s.expiresAt) {
    delete all[token];
    saveSessions(all);
    return null;
  }
  return a.name; // nome ATUAL (renomear não derruba a sessão)
}

function destroySession(token) {
  if (!token) return false;
  const all = loadSessions();
  if (token in all) { delete all[token]; saveSessions(all); return true; }
  return false;
}

module.exports = {
  USERS,
  DATA_DIR,
  isKnown, auth, roleOf, accountOf, listAccounts, createAccount,
  renameAccount, setPin, setRole, deleteAccount,
  listTombstones: () => loadTombstones(),
  getConf, listOpenConfs, getOpenConf,
  startConf, saveConf, setProduto, clearConf, finishConf, resumo,
  listHist, getHist, newConferenciaFor, deleteOpenConf, deleteHistConf,
  getOpcoes, setOpcoes,
  createSession, userForToken, destroySession
};
