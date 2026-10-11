/* =====================================================================
   rconf-store.js — armazenamento local POR CONTA (offline, sem API)

   Identidade: a conta tem um ID interno estável (nunca apenas o nome). O
   cache local é gravado SEMPRE por esse ID; um nome repetido (conta nova
   após exclusão) NUNCA acessa dados de outra conta.

   Chaves usadas:
     rconf_session            -> { "user": "<usuário>", "id": "<id da conta>" } (sessão atual)
     rconf_data_<id da conta> -> dados privados da conta (guardados por ID)
     rconf_data_<nome>        -> chaves ANTIGAS (por nome): PRESERVADAS, mas NUNCA
                                 lidas nem enviadas automaticamente. Podem conter
                                 trabalho recuperável e não são apagadas.
     rconf_user               -> "Lembrar usuário" (só o NOME, nunca o PIN)

   Regras de isolamento:
     - dados locais só são reutilizados para o MESMO ID da conta autenticada;
     - uma conferência local NUNCA é enviada ao servidor em automático: a
       recuperação é explícita (botão "Continuar" na tela Nova Conferência);
     - sem identificador de conta, o cache não é gravado (modo demo fica
       restrito às contas iniciais, por seedId determinístico).

   Estrutura de rconf_data_<id>:
     {
       version:     1,
       user:        "<usuário>",
       accountId:   "<id da conta>",
       updatedAt:   <epoch ms>,
       conferenciaAtual: null,
       conferencias: [],   // reservado p/ Nova Conferência
       historial:    [],   // reservado p/ Histórico
       opciones:     {}    // reservado p/ Opções
     }

   Regras antigas preservadas:
     - o PIN jamais é gravado (nem aqui nem em outro lugar);
     - dados legados SEM usuário (ex.: "rconf_data") são ignorados,
       nunca migrados para uma conta específica.
   ===================================================================== */
(function (global) {
  "use strict";

  var K_SESSION = "rconf_session";
  var K_PREFIX = "rconf_data_";
  var VERSION = 1;

  var USERS = [
    { user: "Ismael", pin: "1234", role: "ADM" },
    { user: "Anderson", pin: "1234", role: "USUARIO" }
  ];

  /* ID determinístico usado pelas contas iniciais no modo demo/offline.
     No modo com servidor, a identidade vem do ID real da conta. */
  function seedId(name) {
    return "usr_seed_" + String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  }

  /* Identificador da conta da sessão atual (ou null sem sessão/demo). */
  function currentAccountId() {
    var s = parse(readRaw(K_SESSION));
    if (s && typeof s.id === "string" && s.id) return s.id;
    if (s && typeof s.user === "string" && s.user) return seedId(s.user); // demo/offline determinístico
    return null;
  }

  /* ---------- localStorage defensivo (modo privado / sem storage) ---------- */
  function ls() {
    try {
      var t = global.localStorage;
      if (!t) return null;
      var probe = "__rconf_probe__";
      t.setItem(probe, "1");
      t.removeItem(probe);
      return t;
    } catch (e) { return null; }
  }

  function readRaw(k) {
    var s = ls();
    if (!s) return null;
    try { return s.getItem(k); } catch (e) { return null; }
  }
  function writeRaw(k, v) {
    var s = ls();
    if (!s) return false;
    try { s.setItem(k, v); return true; } catch (e) { return false; }
  }
  function dropRaw(k) {
    var s = ls();
    if (!s) return;
    try { s.removeItem(k); } catch (e) {}
  }

  function parse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /* ---------- saneamento: nunca persistir segredos ---------- */
  function scrub(o) {
    if (!o || typeof o !== "object") return o;
    if (Object.prototype.toString.call(o) === "[object Array]") return o;
    var banned = ["pin", "senha", "password", "pass", "secret", "token"];
    for (var i = 0; i < banned.length; i++) delete o[banned[i]];
    return o;
  }

  function emptyData(user) {
    return {
      version: VERSION, user: user, updatedAt: 0,
      conferenciaAtual: null,
      conferencias: [], historial: [], opciones: {}
    };
  }

  /* normaliza o que veio do storage: garante as 3 seções e o dono */
  function normalize(user, raw) {
    var d = parse(raw);
    if (!d || typeof d !== "object") d = {};
    var out = emptyData(user);
    out.updatedAt = typeof d.updatedAt === "number" ? d.updatedAt : 0;
    if (Object.prototype.toString.call(d.conferencias) === "[object Array]") out.conferencias = d.conferencias;
    if (Object.prototype.toString.call(d.historial) === "[object Array]") out.historial = d.historial;
    if (d.opciones && typeof d.opciones === "object") out.opciones = scrub(d.opciones);
    if (d.conferenciaAtual && typeof d.conferenciaAtual === "object") {
      out.conferenciaAtual = d.conferenciaAtual;
    }
    return out;
  }

  function isKnown(user) {
    for (var i = 0; i < USERS.length; i++) if (USERS[i].user === user) return true;
    // Com identificador de conta (sessão do servidor) qualquer conta criada
    // pode manter cache local, SEMPRE identificado pelo ID (nunca pelo nome).
    return currentAccountId() !== null;
  }

  /* ---------- API ---------- */
  var Rconf = {
    VERSION: VERSION,
    USERS: USERS,

    auth: function (user, pin) {
      for (var i = 0; i < USERS.length; i++) {
        if (USERS[i].user === user && USERS[i].pin === pin) return true;
      }
      return false;
    },

    session: {
      user: function () {
        var d = parse(readRaw(K_SESSION));
        var u = d && typeof d.user === "string" && d.user ? d.user : "";
        if (!u) { if (d) dropRaw(K_SESSION); return null; }
        return u;
      },
      /* ID interno estável da conta (fonte: servidor /api/login, /api/me).
         Nulo em modo demo/offline (allí seedId é usado para o cache). */
      id: function () { return currentAccountId(); },
      account: function () {
        var u = this.user();
        return u ? { user: u, id: currentAccountId() } : null;
      },
      set: function (info) {
        var user = "", id = null;
        if (typeof info === "string") { user = String(info || "").trim(); }      // legado: só nome
        else if (info && typeof info === "object") {
          user = String(info.user != null ? info.user : "").trim();
          id = info.id ? String(info.id) : null;
        }
        if (!user) return false;
        var ok = writeRaw(K_SESSION, JSON.stringify({ user: user, id: id, at: Date.now() }));
        if (ok) Rconf.data.get(user);   // garante a chave da conta existindo
        return ok;
      },
      clear: function () { dropRaw(K_SESSION); }
    },

    data: {
      /* a chave local é SEMPRE a conta (ID, ou seedId determinístico no demo) */
      localKey: function (user) {
        var id = currentAccountId();
        return K_PREFIX + (id || seedId(user || ""));
      },
      get: function (user) {
        if (!isKnown(user)) return emptyData(user);
        var id = currentAccountId();
        if (!id) return emptyData(user);                    // sem identidade: sem cache
        var raw = readRaw(K_PREFIX + id);
        if (raw === null) {                                 // primeira vez: cria a estrutura da conta
          writeRaw(K_PREFIX + id, JSON.stringify(emptyData(user)));
          return emptyData(user);
        }
        return normalize(user, raw);
      },
      save: function (user, data) {
        if (!isKnown(user)) return false;
        var id = currentAccountId();
        if (!id) return false;
        var d = normalize(user, JSON.stringify(data));
        d.user = user;
        d.accountId = id;
        d.updatedAt = Date.now();
        return writeRaw(K_PREFIX + id, JSON.stringify(d));
      },
      reset: function (user) {
        if (!isKnown(user)) return false;
        var id = currentAccountId();
        if (!id) return false;
        writeRaw(K_PREFIX + id, JSON.stringify(emptyData(user)));
        return true;
      }
    },

    /* ---------- conferências (várias ABERTAS por conta) ----------
       Fonte de verdade local: d.conferencias[] (as ABERTAS, da mais recente
       para a mais antiga). d.conferenciaAtual é o ESPELHO da mais recente,
       mantido para compatibilidade com leituras antigas do modo local. */
    listOpenLocal: function (user) {
      if (!isKnown(user)) return [];
      var d = Rconf.data.get(user);
      return Object.prototype.toString.call(d.conferencias) === "[object Array]" ? d.conferencias : [];
    },
    getOpenLocal: function (user, id) {
      var l = Rconf.listOpenLocal(user);
      for (var i = 0; i < l.length; i++) if (l[i] && l[i].id === id) return l[i];
      return null;
    },
    persistOpenLocal: function (user, list) {
      if (!isKnown(user)) return false;
      var d = Rconf.data.get(user);
      d.conferencias = list;
      d.conferenciaAtual = list.length ? list[0] : null;
      d.updatedAt = Date.now();
      return Rconf.data.save(user, d);
    },
    /* "atual": a mais recente das ABERTAS; cai no espelho legado (conferencia
       única antiga sem array) apenas quando não há lista. */
    activeLocal: function (user) {
      var l = Rconf.listOpenLocal(user);
      if (l.length) return l[0];
      if (!isKnown(user)) return null;
      var d = Rconf.data.get(user);
      return d.conferenciaAtual && typeof d.conferenciaAtual === "object" ? d.conferenciaAtual : null;
    },

    confs: {
      list: function (user) { return Rconf.listOpenLocal(user); },
      get: function (user, id) { return Rconf.getOpenLocal(user, id); },
      count: function (user) { return Rconf.listOpenLocal(user).length; },

      start: function (user, info) {
        if (!isKnown(user)) return null;
        info = info || {};
        var now = Date.now();
        var produtos = Object.prototype.toString.call(info.produtos) === "[object Array]" ? info.produtos : [];
        var conf = {
          id: info.id || ("C-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 7)),
          arquivo: info.arquivo || "",
          criadaEm: info.criadaEm || now,
          atualizadaEm: now,
          produtos: produtos.map(function (p) {
            return {
              codigo: String(p.codigo == null ? "" : p.codigo),
              descricao: String(p.descricao == null ? "" : p.descricao),
              esperado: Number(p.esperado) || 0,
              conferido: p.conferido == null ? null : Number(p.conferido),
              status: p.status === "conferido" ? "conferido" : "pendente"
            };
          })
        };
        var l = Rconf.listOpenLocal(user);
        if (info.id) l = l.filter(function (c) { return !c || c.id !== info.id; }); // upsert: retomada idempotente
        l.unshift(conf);
        Rconf.persistOpenLocal(user, l);
        return conf;
      },

      save: function (user, conf) {
        if (!isKnown(user) || !conf || typeof conf !== "object" || !conf.id) return false;
        conf.atualizadaEm = Date.now();
        var l = Rconf.listOpenLocal(user);
        var idx = -1;
        for (var i = 0; i < l.length; i++) if (l[i] && l[i].id === conf.id) { idx = i; break; }
        if (idx >= 0) l[idx] = conf; else l.unshift(conf);
        return Rconf.persistOpenLocal(user, l);
      },

      setProduto: function (user, codigo, conferido, id) {
        if (!isKnown(user)) return null;
        var conf = id ? Rconf.getOpenLocal(user, id) : Rconf.activeLocal(user);
        if (!conf || !conf.produtos) return null;
        var alvo = String(codigo);
        for (var i = 0; i < conf.produtos.length; i++) {
          if (String(conf.produtos[i].codigo) === alvo) {
            if (conferido === null) {
              conf.produtos[i].conferido = null;
              conf.produtos[i].status = "pendente";
            } else {
              conf.produtos[i].conferido = Number(conferido) || 0;
              conf.produtos[i].status = "conferido";
            }
            break;
          }
        }
        Rconf.confs.save(user, conf);
        return conf;
      },

      clear: function (user, id) {
        if (!isKnown(user)) return false;
        var l = Rconf.listOpenLocal(user);
        var next = id ? l.filter(function (c) { return c.id !== id; }) : l.slice(1);
        return Rconf.persistOpenLocal(user, next);
      },

      /* remove uma conferência ABERTA específica pelo seu id (modo local) */
      remove: function (user, id) {
        if (!isKnown(user) || !id) return false;
        var l = Rconf.listOpenLocal(user);
        var next = l.filter(function (c) { return !c || c.id !== id; });
        if (next.length === l.length) return false;
        return Rconf.persistOpenLocal(user, next);
      },

      finish: function (user, id) {
        if (!isKnown(user)) return null;
        var conf = id ? Rconf.getOpenLocal(user, id) : Rconf.activeLocal(user);
        if (!conf) return null;
        var now = Date.now();
        conf.finalizadaEm = now;
        conf.atualizadaEm = now;
        var d = Rconf.data.get(user);
        if (Object.prototype.toString.call(d.historial) !== "[object Array]") d.historial = [];
        var dup = false;
        for (var i = 0; i < d.historial.length; i++) if (d.historial[i] && d.historial[i].id === conf.id) dup = true;
        if (!dup) d.historial.push(conf);
        d.conferencias = Rconf.listOpenLocal(user).filter(function (c) { return c.id !== conf.id; });
        d.conferenciaAtual = d.conferencias.length ? d.conferencias[0] : null;
        d.updatedAt = now;
        Rconf.data.save(user, d);
        return conf;
      }
    },

    /* ---------- conferência em andamento (API antiga: sempre a "atual") ---------- */
    conf: {
      /* devolve a conferência em andamento mais recente do usuário (ou null) */
      get: function (user) { return Rconf.activeLocal(user); },

      /* cria uma nova conferência em andamento a partir dos produtos importados */
      start: function (user, info) { return Rconf.confs.start(user, info); },

      /* grava o estado atual (substitui a conferência em andamento) */
      save: function (user, conf) { return Rconf.confs.save(user, conf); },

      /* marca/atualiza um produto específico da conferência atual por código */
      setProduto: function (user, codigo, conferido) { return Rconf.confs.setProduto(user, codigo, conferido, null); },

      /* remove a conferência atual (sem finalizar) */
      clear: function (user) { return Rconf.confs.clear(user, null); },

      /* finaliza: move a atual para o histórico e limpa a atual */
      finish: function (user) { return Rconf.confs.finish(user, null); },

      /* resumo calculado (não persistido) */
      resumo: function (conf) {
        if (!conf || !conf.produtos) return null;
        var total = conf.produtos.length, conferidos = 0, esperado = 0, encontrado = 0;
        var divergencias = [];
        for (var i = 0; i < conf.produtos.length; i++) {
          var p = conf.produtos[i];
          esperado += Number(p.esperado) || 0;
          if (p.status === "conferido") {
            conferidos++;
            encontrado += Number(p.conferido) || 0;
            var dif = (Number(p.conferido) || 0) - (Number(p.esperado) || 0);
            if (dif !== 0) divergencias.push({ codigo: p.codigo, descricao: p.descricao, esperado: Number(p.esperado) || 0, conferido: Number(p.conferido) || 0, diferenca: dif });
          }
        }
        return { id: conf.id, arquivo: conf.arquivo, total: total, conferidos: conferidos, esperado: esperado, encontrado: encontrado, diferencaTotal: encontrado - esperado, divergencias: divergencias };
      }
    },

    historial: {
      list: function (user) {
        if (!isKnown(user)) return [];
        var d = Rconf.data.get(user);
        return Object.prototype.toString.call(d.historial) === "[object Array]" ? d.historial : [];
      },
      get: function (user, id) {
        var l = Rconf.historial.list(user);
        for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
        return null;
      },
      /* remove uma conferência FINALIZADA específica pelo seu id (modo local) */
      remove: function (user, id) {
        if (!isKnown(user) || !id) return false;
        var d = Rconf.data.get(user);
        if (Object.prototype.toString.call(d.historial) !== "[object Array]") return false;
        var next = d.historial.filter(function (x) { return !x || x.id !== id; });
        if (next.length === d.historial.length) return false;
        d.historial = next;
        d.updatedAt = Date.now();
        Rconf.data.save(user, d);
        return true;
      }
    }
  };

  global.Rconf = Rconf;
})(typeof window !== "undefined" ? window : this);
