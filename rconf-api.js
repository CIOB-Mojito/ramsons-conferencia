/* =====================================================================
   rconf-api.js — cliente da API local (mesma origem)

   Fala com server.js via fetch. A autorização é a SESSÃO (cookie HttpOnly
   definido pelo servidor); o cliente NUNCA envia um "user" como autorização.

   Se a API não estiver disponível (ex.: aberto como arquivo local, sem
   servidor), as telas caem no modo local (rconf-store.js) para
   compatibilidade. O armazenamento principal é o servidor.
   ===================================================================== */
(function (root) {
  "use strict";

  function factory(base) {
    base = base == null ? "" : String(base);

    function req(method, path, body) {
      var opts = { method: method, credentials: "same-origin", headers: {} };
      if (body !== undefined) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      return fetch(base + path, opts).then(function (r) {
        return r.text().then(function (txt) {
          var d = {};
          try { d = txt ? JSON.parse(txt) : {}; } catch (e) { d = {}; }
          if (!r.ok) {
            var err = new Error(d && d.error ? d.error : ("http_" + r.status));
            err.status = r.status;
            err.data = d;
            throw err;
          }
          return d;
        });
      });
    }

    return {
      base: base,
      login: function (usuario, pin) { return req("POST", "/api/login", { usuario: usuario, pin: pin }); },
      logout: function () { return req("POST", "/api/logout", {}); },
      me: function () { return req("GET", "/api/me"); },
      confGet: function () { return req("GET", "/api/conferencia-atual"); },
      confList: function () { return req("GET", "/api/conferencias"); },
      confGetId: function (id) { return req("GET", "/api/conferencias/" + encodeURIComponent(id)); },
      confStart: function (info) { info = info || {}; return req("POST", "/api/conferencia", { id: info.id, arquivo: info.arquivo, produtos: info.produtos }); },
      confSetProduto: function (codigo, conferido, id) { return req("PUT", "/api/conferencia/produto", { codigo: codigo, conferido: conferido, id: id }); },
      confFinish: function (id) { return req("POST", "/api/conferencia/finalizar", { id: id }); },
      histList: function () { return req("GET", "/api/historico"); },
      histGet: function (id) { return req("GET", "/api/historico/" + encodeURIComponent(id)); },
      confDelete: function (id) { return req("DELETE", "/api/conferencias/" + encodeURIComponent(id)); },
      histDelete: function (id) { return req("DELETE", "/api/historico/" + encodeURIComponent(id)); },
      adminUsers: function () { return req("GET", "/api/admin/users"); },
      adminUser: function (id) { return req("GET", "/api/admin/users/" + encodeURIComponent(id)); },
      adminRenameUser: function (id, nome) { return req("POST", "/api/admin/users/" + encodeURIComponent(id) + "/rename", { nome: nome }); },
      adminResetPin: function (id) { return req("POST", "/api/admin/users/" + encodeURIComponent(id) + "/reset-pin", {}); },
      adminSetRole: function (id, tipo) { return req("POST", "/api/admin/users/" + encodeURIComponent(id) + "/role", { tipo: tipo }); },
      adminDeleteUser: function (id) { return req("DELETE", "/api/admin/users/" + encodeURIComponent(id)); },
      adminLoadConf: function (id, info) { info = info || {}; return req("POST", "/api/admin/users/" + encodeURIComponent(id) + "/conferencia", { arquivo: info.arquivo, produtos: info.produtos }); },
      adminCreateUser: function (usuario, pin, pinConfirm, tipo) {
        return req("POST", "/api/admin/users", { usuario: usuario, pin: pin, pinConfirm: pinConfirm, tipo: tipo });
      },
      myPin: function (atual, novo, confirm) {
        return req("POST", "/api/me/pin", { pinAtual: atual, pinNovo: novo, pinNovoConfirm: confirm });
      },
      status: function () { return req("GET", "/api/status"); },
      available: function () {
        return fetch(base + "/api/ping", { credentials: "same-origin" }).then(function (r) { return r.ok; }).catch(function () { return false; });
      }
    };
  }

  root.RconfApiFactory = factory;
  root.RconfApi = factory(root.RCONF_API_BASE || "");
  if (typeof module !== "undefined" && module.exports) module.exports = factory;
})(typeof window !== "undefined" ? window : this);
